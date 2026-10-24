import * as vscode from 'vscode';
import type { Settings } from './config';
import { baselines, diffMarks, lineMarks, removedPreview, type HighlightClears, type LineMarks } from './highlights';
import { MirrorFileSystem, MIRROR_SCHEME } from './mirrorFs';
import { normalizeEol } from './planner';
import type { Player } from './player';
import type { Timeline } from './timeline';

/** Each mirror is drawn at most this often while it changes; a trailing run draws the last change. */
const RENDER_INTERVAL_MS = 100;
/** Timer key for working out which mirrors have highlights at all. */
const ALL = '*';

type HighlightSettings = Pick<Settings, 'highlightAdditions' | 'markDeletions'>;

/** What one refresh works from: read once, used for every file. */
interface State {
  playing: number | undefined;
  clears: HighlightClears;
  bases: Map<string, string>;
  texts: Map<string, { text: string }>;
}

/**
 * Draws highlights on visible mirror editors: added lines and characters and
 * removal markers, against each file's baseline. Everything comes from the
 * timeline, its clears, and the player's text for the change being typed, so
 * seek, skip to latest, restore, a reopened tab or a toggled setting needs
 * nothing more than a redraw.
 */
export class HighlightView implements vscode.Disposable {
  private readonly addedLine: vscode.TextEditorDecorationType;
  private readonly addedText: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastRun = new Map<string, number>();
  /** Each file's last marks, reused while its baseline and text stay the same. */
  private readonly cache = new Map<string, { baseline: string; text: string; marks: LineMarks }>();
  /** Marks drawn per mirror URI, after the settings. For tests. */
  readonly drawn = new Map<string, LineMarks>();
  /** Mirror paths with any highlights shown, as the title bar's context key holds them. */
  private highlighted: string[] | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when whether any mirror has highlights changes. */
  readonly onDidChangeHighlighted = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly timeline: Timeline,
    private readonly player: Player,
    private readonly settings: () => HighlightSettings,
    extensionUri: vscode.Uri,
  ) {
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
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === MIRROR_SCHEME) this.schedule(e.document.uri.toString());
      }),
      player.onDidEditMirror((relPath) => this.schedule(MirrorFileSystem.uriFor(relPath).toString())),
      timeline.onDidChange(() => this.refresh()),
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
    const wait = Math.max(0, (this.lastRun.get(key) ?? 0) + RENDER_INTERVAL_MS - Date.now());
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.lastRun.set(key, Date.now());
        if (this.disposed) return;
        if (key === ALL) this.updateHighlighted();
        else this.render(key);
      }, wait),
    );
  }

  private state(): State {
    const playing = this.timeline.playing;
    const clears = this.timeline.highlightClears;
    // The change being typed counts, so its file's baseline is ready for its live text.
    const through = playing !== undefined ? playing + 1 : this.timeline.cursor;
    return { playing, clears, bases: baselines(this.timeline.all(), through, clears), texts: this.timeline.mirrorStates() };
  }

  /** The file's baseline and the text its mirror should show, or undefined when it shows no highlights. */
  private pair(relPath: string, st: State): { baseline: string; text: string; live: boolean } | undefined {
    const baseline = st.bases.get(relPath);
    if (baseline === undefined) return undefined;
    const live = this.player.liveText(relPath);
    if (live !== undefined) {
      // A clear made while this change is typed takes effect when it finishes.
      const cleared = Math.max(st.clears.all ?? 0, st.clears.files.get(relPath) ?? 0);
      if (st.playing !== undefined && cleared > st.playing) return undefined;
      return { baseline, text: live, live: true };
    }
    const text = st.texts.get(relPath)?.text;
    return text === undefined ? undefined : { baseline, text, live: false };
  }

  /** The marks the settings let through, or undefined when none are left. */
  private shown(relPath: string, baseline: string, text: string): LineMarks | undefined {
    const s = this.settings();
    if ((!s.highlightAdditions && !s.markDeletions) || baseline === text) return undefined;
    let hit = this.cache.get(relPath);
    if (!hit || hit.baseline !== baseline || hit.text !== text) {
      hit = { baseline, text, marks: lineMarks(text, diffMarks(baseline, text)) };
      this.cache.set(relPath, hit);
    }
    const m = hit.marks;
    const out: LineMarks = {
      lines: s.highlightAdditions ? m.lines : [],
      chars: s.highlightAdditions ? m.chars : [],
      removals: s.markDeletions ? m.removals : [],
    };
    return out.lines.length + out.removals.length > 0 ? out : undefined;
  }

  private render(key: string): void {
    const editors = vscode.window.visibleTextEditors.filter((ed) => ed.document.uri.toString() === key);
    if (editors.length === 0) {
      this.drawn.delete(key);
      return;
    }
    const doc = editors[0].document;
    const pair = this.pair(relPathOf(doc.uri), this.state());
    const docText = pair ? normalizeEol(doc.getText()) : undefined;
    // Mid-change the document can be a step ahead of the player's text; the
    // player's edit event redraws it, and until then the old marks move with the text.
    if (pair?.live && docText !== pair.text) return;
    const marks = pair && docText === pair.text ? this.shown(relPathOf(doc.uri), pair.baseline, pair.text) : undefined;
    for (const ed of editors) this.draw(ed, marks);
    if (marks) this.drawn.set(key, marks);
    else this.drawn.delete(key);
  }

  private draw(editor: vscode.TextEditor, marks: LineMarks | undefined): void {
    const language = editor.document.languageId;
    editor.setDecorations(this.addedLine, (marks?.lines ?? []).map((l) => new vscode.Range(l, 0, l, 0)));
    editor.setDecorations(this.addedText, (marks?.chars ?? []).map((c) => new vscode.Range(c.line, c.start, c.line, c.end)));
    editor.setDecorations(
      this.removed,
      (marks?.removals ?? []).map((r) => ({ range: new vscode.Range(r.line, 0, r.line, 0), hoverMessage: removedHover(r.texts, language) })),
    );
  }

  /** Works out which mirrors have highlights, for the title bar button and the Playback panel. */
  private updateHighlighted(): void {
    const st = this.state();
    const paths: string[] = [];
    for (const relPath of st.bases.keys()) {
      const pair = this.pair(relPath, st);
      if (pair && this.shown(relPath, pair.baseline, pair.text)) paths.push(MirrorFileSystem.uriFor(relPath).path);
    }
    for (const relPath of this.cache.keys()) if (!st.bases.has(relPath)) this.cache.delete(relPath);
    paths.sort();
    if (this.highlighted && paths.join('\n') === this.highlighted.join('\n')) return;
    const had = this.hasHighlights;
    this.highlighted = paths;
    void vscode.commands.executeCommand('setContext', 'agentTypewriter.highlightedMirrors', paths);
    if (had !== this.hasHighlights) this.changed.fire();
  }
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
