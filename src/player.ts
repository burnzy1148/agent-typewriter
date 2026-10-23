import * as vscode from 'vscode';
import { MirrorFileSystem, mirrorBytes } from './mirrorFs';
import { baseCharsPerMinute } from './pace';
import { lfOffsetToLineCol, normalizeEol, planHunks, type Eol, type Hunk } from './planner';
import { SCROLL_FRAME_MS, centeredTop, scrollSteps } from './scroll';
import { caretPath } from './caretPath';
import type { ChangeEvent, Timeline } from './timeline';
import type { Settings } from './config';
import { backspaceStep, typingChunkEnd } from './typingChunks';

const BACKSPACE_MAX = 24;
/** More arrow presses than this to reach an edit, and the caret is clicked there instead. */
const ARROW_MAX_KEYS = 24;
const TICK_HZ = 60;

/**
 * Consumes the timeline in order and types each change into its mirror
 * editor. Switching to a different file between events opens (or focuses)
 * that file's mirror tab first, so a run that touched three files plays back
 * as someone flipping between three tabs.
 */
export class Player implements vscode.Disposable {
  private paused = false;
  private disposed = false;
  /** Bumped by interrupt(); a playback that sees a newer epoch stops at once. */
  private epoch = 0;
  private finishNow = false;
  private manualSpeed = 1;
  private replayColumn: vscode.ViewColumn | undefined;
  private lastRelPath: string | undefined;
  private playbackPath: string | undefined;
  private readonly mirrorChanged = new vscode.EventEmitter<void>();
  /** Fires when the playback mirror moves to another file. */
  readonly onDidChangePlaybackMirror = this.mirrorChanged.event;
  /** Line ending of the change being played; reapplied if its tab is reopened. */
  private currentEol: Eol = '\n';
  /**
   * LF text the mirror of the change being played should hold: its before text
   * plus every edit made so far. A mirror that was reverted, or reloaded after
   * its tab closed, is put back to this before the next edit.
   */
  private expected = '';
  /** Document and version the last edit left, so the text is only compared after something else changed it. */
  private synced: { doc: vscode.TextDocument; version: number } | undefined;
  /** Nonzero while snapToLatest runs; the loop starts no change meanwhile. */
  private holds = 0;
  /** The latest snapToLatest; the next one, and interrupt(), wait for it. */
  private snapping: Promise<void> = Promise.resolve();
  private waiters: Array<() => void> = [];
  private inFlight: Promise<void> = Promise.resolve();
  private readonly flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: false,
  });
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly timeline: Timeline,
    private readonly mirror: MirrorFileSystem,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
  ) {
    this.subscription = timeline.onDidChange(() => this.poke());
    void this.loop();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get speed(): number {
    return this.manualSpeed;
  }

  /** The file whose mirror is being typed into, or was played into last. */
  get playbackRelPath(): string | undefined {
    return this.playbackPath;
  }

  setSpeed(multiplier: number): void {
    this.manualSpeed = Math.max(0.1, multiplier);
  }

  /** Pauses or resumes; does nothing when playback is already in that state. */
  setPaused(paused: boolean): void {
    if (this.paused !== paused) this.togglePause();
  }

  /** Until the next change plays there is no playback mirror, e.g. after loading another session. */
  forgetPlaybackMirror(): void {
    if (this.playbackPath === undefined) return;
    this.playbackPath = undefined;
    this.mirrorChanged.fire();
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    this.poke();
    return this.paused;
  }

  /** Types the rest of the current change instantly, then carries on normally. */
  finishCurrent(): void {
    this.finishNow = true;
    this.poke();
  }

  /** Stops the change being typed right now and waits until it has let go of the editor. */
  async interrupt(): Promise<void> {
    this.epoch++;
    this.poke();
    await this.inFlight;
    await this.snapping;
  }

  /**
   * Skips everything queued and puts every mirror document straight into its
   * newest recorded state. Overlapping calls run one after another. A seek,
   * skip or other snap that moves the cursor while this one waits wins.
   */
  snapToLatest(): Promise<void> {
    const jumps = this.timeline.jumps;
    const run = this.snapping.then(() => this.snap(jumps));
    this.snapping = run.catch(() => undefined);
    return run;
  }

  private async snap(jumps: number): Promise<void> {
    this.holds++;
    try {
      this.epoch++;
      this.poke();
      await this.inFlight;
      if (this.timeline.jumps !== jumps) return;
      // Move the cursor and read the states in one step: a change recorded
      // from here on stays queued and plays on top of the snapped text.
      this.timeline.seekToEnd();
      const latest = [...this.timeline.latestStates().values()];
      let newest: ChangeEvent | undefined;
      for (const e of latest) {
        if (this.disposed) return;
        if (!newest || e.seq > newest.seq) newest = e;
        await this.settle(e);
      }
      if (newest && !this.disposed) {
        this.setPlaybackPath(newest.relPath);
        const editor = await this.showMirror(newest.relPath, newest.after, newest.eol);
        await setText(editor.document, newest.after, newest.eol);
        this.lastRelPath = newest.relPath;
      }
    } finally {
      this.holds--;
      this.poke();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.subscription.dispose();
    this.flash.dispose();
    this.mirrorChanged.dispose();
    this.poke();
  }

  private setPlaybackPath(relPath: string): void {
    if (this.playbackPath === relPath) return;
    this.playbackPath = relPath;
    this.mirrorChanged.fire();
  }

  // ---------------------------------------------------------------- loop

  private async loop(): Promise<void> {
    while (!this.disposed) {
      const next = this.paused || this.holds > 0 ? undefined : this.timeline.peek();
      if (!next) {
        await this.nextPoke();
        continue;
      }
      const token = this.timeline.begin(next.seq);
      this.finishNow = false;
      const epoch = this.epoch;
      this.inFlight = this.play(next, epoch).catch(async (err) => {
        this.log.appendLine(`Playback of ${next.relPath} failed: ${err instanceof Error ? err.message : String(err)}`);
        // The change is marked played either way, so its mirror must not keep older text.
        if (this.live(epoch)) await this.settle(next).catch(() => undefined);
      });
      await this.inFlight;
      this.timeline.complete(next.seq, token);
    }
  }

  private async play(e: ChangeEvent, epoch: number): Promise<void> {
    const s = this.settings();
    const switching = this.lastRelPath !== e.relPath;
    // Before showing the tab: VS Code asks for its CodeLens row as it opens.
    this.setPlaybackPath(e.relPath);
    this.currentEol = e.eol;
    let editor: vscode.TextEditor | undefined = await this.showMirror(e.relPath, e.before, e.eol);
    // The mirror might not match this event's "before" (first replay, after a
    // seek, or a reverted mirror). ready() snaps it so the hunks line up.
    this.expected = e.before;
    this.synced = undefined;
    if (switching && this.lastRelPath !== undefined) {
      await this.sleep(s.fileSwitchDelayMs / this.speedMultiplier(s));
    }
    this.lastRelPath = e.relPath;
    if (!(editor = await this.ready(e.relPath, editor, epoch))) return;

    if (e.kind === 'delete') {
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), posAt(editor.document, e.before.length));
      await this.sleep(500 / this.speedMultiplier(s));
      if (!(editor = await this.ready(e.relPath, editor, epoch))) return;
      await this.edit(editor.document, 0, this.expected.length, '');
      this.store(e);
      return;
    }

    const hunks = planHunks(e.before, e.after);
    const inserted = hunks.reduce((n, h) => n + h.insertText.length, 0);
    if (inserted > s.maxAnimatedChars) {
      await this.edit(editor.document, 0, this.expected.length, e.after);
      this.flashRange(editor, new vscode.Range(0, 0, editor.document.lineCount, 0));
      this.store(e);
      return;
    }

    // After a file switch the first edit is jumped to; later ones are scrolled to.
    let smooth = !switching;
    for (const h of hunks) {
      if (this.finishNow) break;
      if (!(editor = await this.ready(e.relPath, editor, epoch))) return;
      await this.typeHunk(e.relPath, editor, h, smooth, epoch);
      if (!this.live(epoch)) return;
      smooth = true;
    }

    if (!(editor = await this.ready(e.relPath, editor, epoch))) return;
    if (this.expected !== e.after) await this.edit(editor.document, 0, this.expected.length, e.after);
    if (!this.live(epoch)) return;
    await setText(editor.document, e.after, e.eol);
    this.store(e);
  }

  // ---------------------------------------------------------------- typing

  private async typeHunk(relPath: string, editor: vscode.TextEditor, h: Hunk, smooth: boolean, epoch: number): Promise<void> {
    const s = this.settings();
    const caretOffset = h.deleteText.length > 0 && h.deleteText.length <= BACKSPACE_MAX && !h.deleteText.includes('\n')
      ? h.offset + h.deleteText.length
      : h.offset;

    const ed = await this.navigate(relPath, editor, caretOffset, smooth, epoch);
    if (!ed) return;
    editor = ed;
    await this.sleep(this.humanize(220, s) / this.speedMultiplier(s));
    if (!this.live(epoch)) return;

    if (h.deleteText.length > 0) {
      await this.deleteText(relPath, editor, h, epoch);
      if (!this.live(epoch)) return;
    }
    if (h.insertText.length > 0) {
      await this.typeText(relPath, editor, h.offset, h.insertText, epoch);
    }
  }

  /**
   * Moves the caret to LF offset `offset`. Close by and in view, it walks
   * there with arrow keys; otherwise the edit is brought into view and the
   * caret clicked there. Undefined once the change was interrupted.
   */
  private async navigate(relPath: string, editor: vscode.TextEditor, offset: number, smooth: boolean, epoch: number): Promise<vscode.TextEditor | undefined> {
    const s = this.settings();
    const from = editor.selection.active;
    const to = posAt(editor.document, offset);
    const walk = smooth && s.arrowNavigation && !this.finishNow && inView(editor, from.line) && inView(editor, to.line);
    let ed = await this.scrollTo(relPath, editor, to.line, smooth, epoch);
    if (!ed) return undefined;
    const doc = ed.document;
    const keys = walk ? caretPath((n) => doc.lineAt(n).text, from, to, ARROW_MAX_KEYS) : undefined;
    for (const k of keys ?? []) {
      if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
      if (this.finishNow) break;
      const caret = new vscode.Position(k.line, k.character);
      ed.selection = new vscode.Selection(caret, caret);
      await this.sleep(this.humanize(1000 / s.arrowKeysPerSecond, s) / this.speedMultiplier(s));
    }
    if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
    const caret = posAt(ed.document, offset);
    ed.selection = new vscode.Selection(caret, caret);
    return ed;
  }

  /**
   * Brings `line` into view. With `smooth` and smoothScroll on, a line outside
   * the viewport is scrolled to after a pause to read what was just typed;
   * otherwise the view jumps there. Undefined once the change was interrupted.
   */
  private async scrollTo(relPath: string, editor: vscode.TextEditor, line: number, smooth: boolean, epoch: number): Promise<vscode.TextEditor | undefined> {
    const s = this.settings();
    const at = new vscode.Range(line, 0, line, 0);
    const view = editor.visibleRanges;
    const jump = () => editor.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!smooth || !s.smoothScroll || view.length === 0 || this.finishNow) {
      jump();
      return editor;
    }
    if (inView(editor, line)) return editor;
    const first = view[0].start.line;
    const last = view[view.length - 1].end.line;

    await this.sleep(this.humanize(s.scrollPauseMs, s) / this.speedMultiplier(s));
    let ed: vscode.TextEditor | undefined = editor;
    if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
    const height = last - first + 1;
    let shown = ed.visibleRanges[0]?.start.line ?? first;
    const steps = scrollSteps(shown, centeredTop(line, height, ed.document.lineCount), height, s.scrollLinesPerSecond, this.speedMultiplier(s));
    for (const top of steps) {
      if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
      if (this.finishNow) break;
      if (top !== shown) {
        ed.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
        shown = top;
      }
      await this.sleep(SCROLL_FRAME_MS);
    }
    if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
    // Lands on the edit after finish now, a frame VS Code clamped, or a scroll by the user during a pause.
    ed.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return ed;
  }

  private async deleteText(relPath: string, editor: vscode.TextEditor, h: Hunk, epoch: number): Promise<void> {
    const s = this.settings();
    // Characters of this hunk still in the document, counted from h.offset.
    let remaining = h.deleteText.length;
    let ed: vscode.TextEditor | undefined = editor;

    if (remaining <= BACKSPACE_MAX && !h.deleteText.includes('\n')) {
      // Short deletions: backspace one character at a time from the end.
      while (remaining > 0 && !this.finishNow) {
        if (!(ed = await this.ready(relPath, ed, epoch))) return;
        if (this.finishNow) break;
        const doc = ed.document;
        const cps = this.cps(s, doc) * 1.6;
        const step = backspaceStep(h.deleteText, remaining, Math.round(cps / TICK_HZ));
        await this.edit(doc, h.offset + remaining - step, h.offset + remaining, '');
        remaining -= step;
        const caret = posAt(doc, h.offset + remaining);
        ed.selection = new vscode.Selection(caret, caret);
        await this.sleep(this.humanize((step * 1000) / cps, s));
      }
      if (remaining === 0) return;
    }

    // Longer or multi-line deletions (or the rest after "finish now"):
    // select the text, pause so the selection registers, then delete it.
    const select = (ed: vscode.TextEditor) => {
      const range = new vscode.Range(posAt(ed.document, h.offset), posAt(ed.document, h.offset + remaining));
      ed.selection = new vscode.Selection(range.start, range.end);
      ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return range;
    };
    if (!(ed = await this.ready(relPath, ed, epoch))) return;
    select(ed);
    if (!this.finishNow) {
      await this.sleep(this.humanize(380, s) / this.speedMultiplier(s));
      // The tab may have been reopened or the text put back meanwhile.
      if (!(ed = await this.ready(relPath, ed, epoch))) return;
      select(ed);
    }
    await this.edit(ed.document, h.offset, h.offset + remaining, '');
    const caret = posAt(ed.document, h.offset);
    ed.selection = new vscode.Selection(caret, caret);
  }

  private async typeText(relPath: string, editor: vscode.TextEditor, offset: number, text: string, epoch: number): Promise<void> {
    const s = this.settings();
    let i = 0;
    let ed: vscode.TextEditor | undefined = editor;
    while (i < text.length) {
      if (!(ed = await this.ready(relPath, ed, epoch))) return;
      const doc = ed.document;

      if (this.finishNow) {
        await this.edit(doc, offset + i, offset + i, text.slice(i));
        return;
      }

      const cps = this.cps(s, doc);
      const atLineStart = posAt(doc, offset + i).character === 0;
      let chunk = '';
      let instant = false;
      if (atLineStart) {
        // Editors auto-indent; nobody types leading spaces one by one.
        const indent = /^[ \t]+/.exec(text.slice(i, i + 256));
        if (indent) {
          chunk = indent[0];
          instant = true;
        }
      }
      if (!chunk) chunk = text.slice(i, typingChunkEnd(text, i, Math.round(cps / TICK_HZ)));

      await this.edit(doc, offset + i, offset + i, chunk);
      i += chunk.length;
      const caret = posAt(doc, offset + i);
      ed.selection = new vscode.Selection(caret, caret);
      if (chunk.includes('\n') || i === chunk.length) {
        ed.revealRange(new vscode.Range(caret, caret), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      if (!instant) await this.sleep(this.delayAfter(chunk, cps, s));
    }
    const end = posAt(ed.document, offset + text.length);
    this.flashRange(ed, new vscode.Range(posAt(ed.document, offset), end));
  }

  // ---------------------------------------------------------------- pacing

  private speedMultiplier(s: Settings): number {
    const catchUp = Math.min(s.maxSpeedup, 1 + s.catchUpFactor * this.timeline.pendingCount());
    return catchUp * this.manualSpeed;
  }

  private cps(s: Settings, doc: vscode.TextDocument): number {
    return (baseCharsPerMinute(doc.languageId, s.charsPerMinute, s.languageSpeeds) / 60) * this.speedMultiplier(s);
  }

  private delayAfter(chunk: string, cps: number, s: Settings): number {
    const perChar = 1000 / cps;
    let ms = this.humanize(chunk.length * perChar, s);
    const last = chunk[chunk.length - 1];
    if (last === '\n') ms += perChar * (2 + Math.random() * 4 * s.jitter);
    else if (last === ';' || last === '{' || last === '}' || last === ',') ms += perChar * 1.5 * Math.random();
    // Occasional "thinking" pause at the end of a line.
    if (last === '\n' && Math.random() < 0.04 * s.jitter) ms += (300 + Math.random() * 700) / this.speedMultiplier(s);
    return ms;
  }

  private humanize(ms: number, s: Settings): number {
    const spread = s.jitter * 0.8;
    return Math.max(0, ms * (1 + spread * (Math.random() * 2 - 1)));
  }

  // ---------------------------------------------------------------- editors

  private async showMirror(relPath: string, initial: string, eol: Eol): Promise<vscode.TextEditor> {
    const uri = MirrorFileSystem.uriFor(relPath);
    if (!this.mirror.has(uri)) this.mirror.writeFile(uri, mirrorBytes(initial, eol));
    const doc = await vscode.workspace.openTextDocument(uri);
    const s = this.settings();
    let column: vscode.ViewColumn;
    if (s.viewColumn === 'active') column = vscode.ViewColumn.Active;
    else if (this.replayColumn !== undefined && this.columnStillOpen(this.replayColumn)) column = this.replayColumn;
    else column = vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: true, preview: false });
    if (s.viewColumn === 'beside') this.replayColumn = editor.viewColumn;
    return editor;
  }

  /** The live editor for a mirror doc, reopening it if the user closed the tab mid-change. */
  private async editorFor(relPath: string, current: vscode.TextEditor): Promise<vscode.TextEditor> {
    const key = MirrorFileSystem.uriFor(relPath).toString();
    if (vscode.window.visibleTextEditors.includes(current) && current.document.uri.toString() === key) return current;
    const visible = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === key);
    if (visible) return visible;
    return this.showMirror(relPath, this.expected, this.currentEol);
  }

  /**
   * Waits out a pause, then returns the live editor for the mirror with its
   * text put back to `expected` if something else changed it. Undefined once
   * the change was interrupted or the player disposed: nothing more is edited.
   */
  private async ready(relPath: string, editor: vscode.TextEditor, epoch: number): Promise<vscode.TextEditor | undefined> {
    await this.whilePaused(epoch);
    if (!this.live(epoch)) return undefined;
    const ed = await this.editorFor(relPath, editor);
    if (!this.live(epoch)) return undefined;
    const doc = ed.document;
    if (this.synced?.doc !== doc || this.synced.version !== doc.version) {
      await setText(doc, this.expected, this.currentEol);
      this.synced = { doc, version: doc.version };
      this.storeExpected(doc.uri);
    }
    return this.live(epoch) ? ed : undefined;
  }

  /**
   * Replaces LF offsets [from, to) of the mirror with `text`, keeping
   * `expected`, and the stored bytes, in step with the document.
   */
  private async edit(doc: vscode.TextDocument, from: number, to: number, text: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(posAt(doc, from), posAt(doc, to)), text);
      if (await vscode.workspace.applyEdit(edit)) break;
      if (attempt === 3) throw new Error('VS Code rejected the edit');
      // The document changed after ready() looked (reloaded or reverted): put it back first.
      await setText(doc, this.expected, this.currentEol);
    }
    this.expected = this.expected.slice(0, from) + text + this.expected.slice(to);
    this.synced = { doc, version: doc.version };
    this.storeExpected(doc.uri);
  }

  /**
   * Keeps the stored bytes equal to the mirror mid-change, so VS Code's own
   * reloads (on showing the tab, on window focus, on revert) change nothing.
   */
  private storeExpected(uri: vscode.Uri): void {
    this.mirror.store(uri, mirrorBytes(this.expected, this.currentEol));
  }

  private columnStillOpen(column: vscode.ViewColumn): boolean {
    return vscode.window.tabGroups.all.some((g) => g.viewColumn === column);
  }

  private flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
    editor.setDecorations(this.flash, [range]);
    setTimeout(() => {
      try {
        editor.setDecorations(this.flash, []);
      } catch {
        // Editor already closed.
      }
    }, 700);
  }

  /** Stores a played change's after text in the mirror filesystem, for documents opened or reverted later. */
  private store(e: ChangeEvent): void {
    this.mirror.store(MirrorFileSystem.uriFor(e.relPath), mirrorBytes(e.after, e.eol));
  }

  /** Puts a file's mirror, open or not, into `e`'s after state. */
  private async settle(e: ChangeEvent): Promise<void> {
    const uri = MirrorFileSystem.uriFor(e.relPath);
    // A new file is announced, so a tab restored after a reload (still showing
    // "not found") loads it; an existing one is replaced quietly.
    if (this.mirror.has(uri)) this.store(e);
    else this.mirror.writeFile(uri, mirrorBytes(e.after, e.eol));
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) await setText(doc, e.after, e.eol);
  }

  // ---------------------------------------------------------------- waiting

  private poke(): void {
    const waiting = this.waiters.splice(0);
    for (const w of waiting) w();
  }

  private nextPoke(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** False once the change started at `epoch` was interrupted or the player disposed. */
  private live(epoch: number): boolean {
    return this.epoch === epoch && !this.disposed;
  }

  private async whilePaused(epoch: number): Promise<void> {
    while (this.paused && this.epoch === epoch && !this.disposed && !this.finishNow) await this.nextPoke();
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.finishNow) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5000)));
  }
}

/** True when `line` is inside one of the editor's visible ranges. */
function inView(editor: vscode.TextEditor, line: number): boolean {
  return editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
}

/** Puts a document's text and line ending to the given LF text and ending, unless it already has them. */
async function setText(doc: vscode.TextDocument, text: string, eol: Eol): Promise<void> {
  // Mirrors are read-only to the editor, so edits go through a workspace edit
  // rather than TextEditor.edit. One made against a version that changed
  // before it arrived is rejected; build it again from the current text.
  for (let attempt = 1; ; attempt++) {
    const edits: vscode.TextEdit[] = [];
    const want = toEndOfLine(eol);
    if (doc.eol !== want) edits.push(vscode.TextEdit.setEndOfLine(want));
    if (normalizeEol(doc.getText()) !== text) edits.push(vscode.TextEdit.replace(fullRange(doc), text));
    if (edits.length === 0) return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    if (await vscode.workspace.applyEdit(edit)) return;
    if (attempt === 3) throw new Error('VS Code rejected the edit');
  }
}

/** Position of an offset into the LF-normalized text, whatever the document's line ending. */
function posAt(doc: vscode.TextDocument, lfOffset: number): vscode.Position {
  if (doc.eol === vscode.EndOfLine.LF) return doc.positionAt(lfOffset);
  const p = lfOffsetToLineCol(normalizeEol(doc.getText()), lfOffset);
  return new vscode.Position(p.line, p.character);
}

function toEndOfLine(eol: Eol): vscode.EndOfLine {
  return eol === '\r\n' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF;
}
