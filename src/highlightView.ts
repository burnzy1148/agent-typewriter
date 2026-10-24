import * as vscode from 'vscode';
import type { Settings } from './config';
import { baselines, diffMarks, highlightPair, lineMarks, removedPreview, renderAction, renderWait, type HighlightPair, type HighlightState, type LineMarks } from './highlights';
import { MirrorFileSystem, MIRROR_SCHEME } from './mirrorFs';
import { normalizeEol } from './planner';
import type { Player } from './player';
import type { Timeline } from './timeline';

/** Each mirror is drawn at most this often while it changes; a trailing run draws the last change. */
const RENDER_INTERVAL_MS = 100;
/** Timer key for working out which mirrors have highlights at all. */
const ALL = '*';
/** A pass over every file diffs no more than this long; files left over keep their last answer until the next pass. */
const PASS_BUDGET_MS = 30;

type HighlightSettings = Pick<Settings, 'highlightAdditions' | 'markDeletions'>;

/**
 * Draws highlights on visible mirror editors: added lines and characters and
 * removal markers, against each file's baseline. Everything comes from the
 * timeline, its clears, and the player's text for the change being typed, so
 * seek, skip to latest, restore, a reopened tab or a toggled setting needs
 * nothing more than a redraw.
 */
export class HighlightView implements vscode.HoverProvider, vscode.Disposable {
  private readonly addedLine: vscode.TextEditorDecorationType;
  private readonly addedText: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastRun = new Map<string, number>();
  /** How long each key's last run took, to space out runs that are expensive. */
  private readonly lastCost = new Map<string, number>();
  /** Each file's last marks, reused while its baseline and text stay the same. */
  private readonly cache = new Map<string, { baseline: string; text: string; marks: LineMarks }>();
  /** Marks drawn per mirror URI, after the settings. For tests. */
  readonly drawn = new Map<string, LineMarks>();
  /** For marks drawn on the player's text mid-change: that change's token, so they are kept only during it. */
  private readonly drawnToken = new Map<string, number>();
  /** Mirror paths with any highlights shown, as the title bar's context key holds them. */
  private highlighted: string[] | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when whether any mirror has highlights changes. */
  readonly onDidChangeHighlighted = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  /** Timeline jumps seen so far; a new one takes stale marks down without waiting for the throttle. */
  private jumps: number;

  constructor(
    private readonly timeline: Timeline,
    private readonly player: Player,
    private readonly settings: () => HighlightSettings,
    extensionUri: vscode.Uri,
  ) {
    this.jumps = timeline.jumps;
    const icon = (name: string) => vscode.Uri.joinPath(extensionUri, 'images', 'gutter', name);
    this.addedLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('agentTypewriter.addedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('agentTypewriter.addedOverviewRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      light: { gutterIconPath: icon('added-light.svg'), gutterIconSize: 'cover' },
      dark: { gutterIconPath: icon('added-dark.svg'), gutterIconSize: 'cover' },
    });
    this.addedText = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('agentTypewriter.addedTextBackground'),
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('agentTypewriter.removedOverviewRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      light: { gutterIconPath: icon('removed-light.svg'), gutterIconSize: 'contain' },
      dark: { gutterIconPath: icon('removed-dark.svg'), gutterIconSize: 'contain' },
    });
    // Removed text is shown by provideHover, so it appears anywhere on the line.
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === MIRROR_SCHEME) this.schedule(e.document.uri.toString());
      }),
      player.onDidEditMirror((relPath) => {
        this.schedule(MirrorFileSystem.uriFor(relPath).toString());
        // Typed text can be the first highlight anywhere; the clear buttons follow it.
        this.schedule(ALL);
      }),
      timeline.onDidChange(() => {
        if (timeline.jumps !== this.jumps) {
          this.jumps = timeline.jumps;
          // After this turn, once the player has let go of the change it was typing.
          setTimeout(() => this.clearStale(), 0);
        }
        this.refresh();
      }),
    ];
    this.refresh();
  }

  /** True when any mirror, shown or not, has highlights or removal markers. */
  get hasHighlights(): boolean {
    return (this.highlighted?.length ?? 0) > 0;
  }

  /** Redraws every visible mirror and works out again which have highlights, e.g. after a settings change. */
  refresh(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme === MIRROR_SCHEME) this.schedule(ed.document.uri.toString());
    }
    for (const key of this.drawn.keys()) {
      if (!vscode.window.visibleTextEditors.some((ed) => ed.document.uri.toString() === key)) this.drawn.delete(key);
    }
    this.schedule(ALL);
  }

  /** The removed text when hovering a line with a removal marker. */
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const relPath = relPathOf(doc.uri);
    const pair = highlightPair(this.state(), relPath, this.player.liveText(relPath));
    if (!pair || normalizeEol(doc.getText()) !== pair.text) return undefined;
    const removal = this.shown(relPath, pair, this.settings())?.removals.find((r) => r.line === pos.line);
    return removal && new vscode.Hover(removedHover(removal.texts, doc.languageId), doc.lineAt(pos.line).range);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const s of this.subscriptions) s.dispose();
    this.addedLine.dispose();
    this.addedText.dispose();
    this.removed.dispose();
    this.changed.dispose();
  }

  private schedule(key: string): void {
    if (this.disposed || this.timers.has(key)) return;
    // Never synchronously: the player updates its text right after the edit that fired this.
    const wait = renderWait(Date.now(), this.lastRun.get(key) ?? 0, this.lastCost.get(key) ?? 0, RENDER_INTERVAL_MS);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.disposed) return;
        const started = Date.now();
        if (key === ALL) this.updateHighlighted();
        else this.render(key);
        this.lastRun.set(key, Date.now());
        this.lastCost.set(key, Date.now() - started);
      }, wait),
    );
  }

  private state(): HighlightState {
    const playing = this.timeline.playing !== undefined ? this.timeline.get(this.timeline.playing) : undefined;
    const clears = this.timeline.highlightClears;
    const events = this.timeline.all();
    // The change being typed counts, so its file's baseline is ready for its live text.
    const through = playing ? playing.seq + 1 : this.timeline.cursor;
    // With nothing playing, the change at the cursor has not played; a clear made
    // while it was typed (before a reload) already holds for every other file.
    const next = playing ? undefined : this.timeline.peek();
    const heldBack = next && { seq: next.seq, paths: [next.relPath, ...(next.fromRelPath !== undefined ? [next.fromRelPath] : [])] };
    const st: HighlightState = { bases: baselines(events, through, clears, heldBack), texts: this.timeline.mirrorStates(), clears };
    if (next) st.next = { seq: next.seq, relPath: next.relPath, fromRelPath: next.fromRelPath };
    if (playing) {
      st.playing = { seq: playing.seq, relPath: playing.relPath, fromRelPath: playing.fromRelPath };
      if (playing.fromRelPath !== undefined && this.player.liveText(playing.fromRelPath) !== undefined) {
        st.movingFrom = playing.fromRelPath;
        st.basesBefore = baselines(events, playing.seq, clears);
      }
    }
    return st;
  }

  /** The file's marks for `pair`, worked out once per baseline and text. */
  private marksOf(relPath: string, pair: HighlightPair): LineMarks {
    let hit = this.cache.get(relPath);
    if (!hit || hit.baseline !== pair.baseline || hit.text !== pair.text) {
      hit = { baseline: pair.baseline, text: pair.text, marks: lineMarks(pair.text, diffMarks(pair.baseline, pair.text)) };
      this.cache.set(relPath, hit);
    }
    return hit.marks;
  }

  /** The marks the settings let through, or undefined when none are left. */
  private shown(relPath: string, pair: HighlightPair, s: HighlightSettings): LineMarks | undefined {
    if ((!s.highlightAdditions && !s.markDeletions) || pair.baseline === pair.text) return undefined;
    return filterMarks(this.marksOf(relPath, pair), s);
  }

  private render(key: string): void {
    const editors = vscode.window.visibleTextEditors.filter((ed) => ed.document.uri.toString() === key);
    if (editors.length === 0) {
      this.drawn.delete(key);
      this.drawnToken.delete(key);
      return;
    }
    const doc = editors[0].document;
    const relPath = relPathOf(doc.uri);
    const pair = highlightPair(this.state(), relPath, this.player.liveText(relPath));
    const liveToken = this.player.liveToken(relPath);
    const action = renderAction(pair, pair ? normalizeEol(doc.getText()) : undefined, this.drawnToken.get(key), liveToken);
    if (action === 'keep') return;
    const marks = action === 'draw' && pair ? this.shown(relPath, pair, this.settings()) : undefined;
    for (const ed of editors) this.draw(ed, marks);
    if (marks) this.drawn.set(key, marks);
    else this.drawn.delete(key);
    if (action === 'draw' && pair?.live && liveToken !== undefined) this.drawnToken.set(key, liveToken);
    else this.drawnToken.delete(key);
  }

  /**
   * Takes down marks that no longer describe their mirror's text, right away:
   * only the cheap comparison, while the throttled redraw does the diffing.
   */
  private clearStale(): void {
    if (this.disposed || this.drawn.size === 0) return;
    const st = this.state();
    for (const ed of vscode.window.visibleTextEditors) {
      const key = ed.document.uri.toString();
      if (!this.drawn.has(key)) continue;
      const relPath = relPathOf(ed.document.uri);
      const pair = highlightPair(st, relPath, this.player.liveText(relPath));
      if (renderAction(pair, pair ? normalizeEol(ed.document.getText()) : undefined, this.drawnToken.get(key), this.player.liveToken(relPath)) !== 'clear') continue;
      for (const other of vscode.window.visibleTextEditors) if (other.document.uri.toString() === key) this.draw(other, undefined);
      this.drawn.delete(key);
      this.drawnToken.delete(key);
    }
  }

  private draw(editor: vscode.TextEditor, marks: LineMarks | undefined): void {
    editor.setDecorations(this.addedLine, (marks?.lines ?? []).map((l) => new vscode.Range(l, 0, l, 0)));
    editor.setDecorations(this.addedText, (marks?.chars ?? []).map((c) => new vscode.Range(c.line, c.start, c.line, c.end)));
    editor.setDecorations(this.removed, (marks?.removals ?? []).map((r) => new vscode.Range(r.line, 0, r.line, 0)));
  }

  /** Works out which mirrors have highlights, for the title bar button and the Playback panel. */
  private updateHighlighted(): void {
    const st = this.state();
    const s = this.settings();
    const deadline = Date.now() + PASS_BUDGET_MS;
    let unfinished = false;
    const paths: string[] = [];
    for (const relPath of [...st.bases.keys(), ...(st.movingFrom !== undefined ? [st.movingFrom] : [])]) {
      const pair = highlightPair(st, relPath, this.player.liveText(relPath));
      if (!pair || (!s.highlightAdditions && !s.markDeletions) || pair.baseline === pair.text) continue;
      const path = MirrorFileSystem.uriFor(relPath).path;
      const hit = this.cache.get(relPath);
      let has: boolean;
      if (hit && hit.baseline === pair.baseline && hit.text === pair.text) has = filterMarks(hit.marks, s) !== undefined;
      // A difference can still draw nothing (a newline added at the end), so diff, within the pass's budget.
      else if (Date.now() > deadline) {
        has = this.highlighted?.includes(path) ?? false;
        unfinished = true;
      } else has = this.shown(relPath, pair, s) !== undefined;
      if (has) paths.push(path);
    }
    for (const relPath of this.cache.keys()) if (!st.bases.has(relPath) && relPath !== st.movingFrom) this.cache.delete(relPath);
    if (unfinished) setTimeout(() => this.schedule(ALL), 0);
    paths.sort();
    if (this.highlighted && paths.join('\n') === this.highlighted.join('\n')) return;
    const had = this.hasHighlights;
    this.highlighted = paths;
    void vscode.commands.executeCommand('setContext', 'agentTypewriter.highlightedMirrors', paths);
    if (had !== this.hasHighlights) this.changed.fire();
  }

  /** Mirror paths with highlights, as the title bar's context key holds them. For tests. */
  get highlightedPaths(): readonly string[] {
    return this.highlighted ?? [];
  }
}

/** The marks the settings let through, or undefined when none are left. */
function filterMarks(m: LineMarks, s: HighlightSettings): LineMarks | undefined {
  const out: LineMarks = {
    lines: s.highlightAdditions ? m.lines : [],
    chars: s.highlightAdditions ? m.chars : [],
    removals: s.markDeletions ? m.removals : [],
  };
  return out.lines.length + out.removals.length > 0 ? out : undefined;
}

function relPathOf(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, '');
}

function removedHover(texts: readonly string[], language: string): vscode.MarkdownString {
  const { code, more } = removedPreview(texts);
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Removed**\n\n');
  md.appendCodeblock(code, language);
  if (more > 0) md.appendMarkdown(`… ${more} more line${more === 1 ? '' : 's'} removed`);
  return md;
}
