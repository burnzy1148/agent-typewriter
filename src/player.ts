import * as vscode from 'vscode';
import { MirrorFileSystem, mirrorBytes } from './mirrorFs';
import { catchUpSpeed } from './pace';
import { lfOffsetToLineCol, normalizeEol, type Eol } from './planner';
import { readPauseLeft } from './readPause';
import { SCROLL_FRAME_MS, centeredTop, scrollSteps } from './scroll';
import type { ChangeEvent, Timeline } from './timeline';
import type { Settings } from './config';
import { typingSteps, type TypingHost, type TypingStep } from './typingSteps';

/** How often a read pause looks again at what is left of it. */
const READ_PAUSE_STEP_MS = 100;

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
  /** When the player last changed a mirror's text, and in which epoch; the read pause counts from there. */
  private lastEditAt = 0;
  private lastEditEpoch = -1;
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
  /** Text about to be deleted, while markDeletions is on. */
  private readonly deleting = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('agentTypewriter.deletingTextBackground'),
    textDecoration: 'line-through',
  });
  /** The editor showing a deletion preview, so it can be taken down there. */
  private previewed: vscode.TextEditor | undefined;
  private previewedText: string | undefined;
  /** Path of the mirror the change in flight is typing into; `expected` is its text. */
  private liveRelPath: string | undefined;
  /** The epoch that change started in; once interrupted, its text is no longer live. */
  private liveEpoch = -1;
  /** Bumped by every play(), so each change gets its own liveToken. */
  private changes = 0;
  private liveChange = -1;
  private readonly edited = new vscode.EventEmitter<string>();
  /** Fires with a mirror's path after the player changed its text, once liveText has caught up. */
  readonly onDidEditMirror = this.edited.event;
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

  /** The text the player has put in `relPath`'s mirror so far, while a change is typed into it. */
  liveText(relPath: string): string | undefined {
    return this.liveToken(relPath) !== undefined ? this.expected : undefined;
  }

  /** Identifies the change typing into `relPath`'s mirror right now, so marks drawn during it can be told from older ones. */
  liveToken(relPath: string): number | undefined {
    return this.liveRelPath === relPath && this.live(this.liveEpoch) ? this.liveChange : undefined;
  }

  /** The text shown as about to be deleted right now, if any. For tests. */
  get deletionPreview(): string | undefined {
    return this.previewedText;
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
    // The next change is the first one played: it is jumped to, not scrolled to.
    this.lastRelPath = undefined;
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
      // Only the followed lane: other lanes' mirrors stay where their own cursors are.
      this.timeline.seekToEnd();
      const { states, renamedAway } = this.timeline.snapTargets();
      for (const relPath of renamedAway) if (!this.disposed) await this.retireMirror(relPath);
      // Their text, read before anything is awaited: as for playback, a change can leave the buffer meanwhile.
      const latest: ChangeEvent[] = [...states.values()].map((e) => ({ ...e }));
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
    this.deleting.dispose();
    this.edited.dispose();
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
      // Its text, read once: the change can leave the buffer, and its saved copy with it, while it is typed.
      const change: ChangeEvent = { ...next };
      this.inFlight = this.play(change, epoch).catch(async (err) => {
        this.log.appendLine(`Playback of ${change.relPath} failed: ${err instanceof Error ? err.message : String(err)}`);
        // The change is marked played either way, so its mirror must not keep older text.
        if (this.live(epoch)) await this.settle(change).catch(() => undefined);
        if (this.live(epoch) && change.fromRelPath !== undefined) await this.retireMirror(change.fromRelPath).catch(() => undefined);
      });
      await this.inFlight;
      this.liveRelPath = undefined;
      this.timeline.complete(next.seq, token);
    }
  }

  private async play(e: ChangeEvent, epoch: number): Promise<void> {
    this.liveChange = ++this.changes;
    if (e.fromRelPath !== undefined && !(await this.moveMirror(e, e.fromRelPath, epoch))) return;
    // The last file stays in view while it is read, and the new one gets a beat before its first edit.
    const switching = this.lastRelPath !== undefined && this.lastRelPath !== e.relPath;
    // After a file switch, or a rename's move to the new mirror, the first edit is jumped to; later ones are scrolled to.
    const jump = this.lastRelPath !== e.relPath || e.fromRelPath !== undefined;
    let editor: vscode.TextEditor | undefined;
    /** The editor the steps look at: the mirror's visible one, when the tab was reopened since the last step. */
    const current = (): vscode.TextEditor | undefined => {
      const key = MirrorFileSystem.uriFor(e.relPath).toString();
      if (editor && vscode.window.visibleTextEditors.includes(editor)) return editor;
      return vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === key) ?? editor;
    };
    const host: TypingHost = {
      settings: () => this.settings(),
      speed: () => this.speedMultiplier(this.settings()),
      finishing: () => this.finishNow,
      caret: () => {
        const ed = current();
        if (!ed) return { line: 0, character: 0 };
        const p = ed.document.validatePosition(ed.selection.active);
        return { line: p.line, character: p.character };
      },
      inView: (first, last) => {
        const ed = current();
        return ed && ed.visibleRanges.length > 0 ? inView(ed, first, last) : undefined;
      },
      languageId: () => current()?.document.languageId ?? '',
    };
    let shown = false;
    try {
      for (const step of typingSteps(e, { switching, jump }, host, Math.random)) {
        if (step.kind === 'readPause') {
          await this.readPause(epoch);
        } else if (step.kind === 'show') {
          // Before showing the tab: VS Code asks for its CodeLens row as it opens.
          this.setPlaybackPath(e.relPath);
          this.currentEol = e.eol;
          // The mirror might not match this event's "before" (first replay, after a
          // seek, or a reverted mirror). ready() snaps it so the hunks line up. Set
          // before showing the tab, so the change counts as live from its start.
          this.expected = e.before;
          this.liveRelPath = e.relPath;
          this.liveEpoch = epoch;
          this.synced = undefined;
          editor = await this.showMirror(e.relPath, e.before, e.eol);
          shown = true;
        } else if (step.kind === 'wait') {
          await this.sleep(step.ms);
        } else {
          if (!editor || !(editor = await this.ready(e.relPath, editor, epoch))) return;
          editor = await this.apply(e.relPath, editor, step, epoch);
          if (!editor) return;
        }
        if (!this.live(epoch)) return;
      }
    } finally {
      this.previewDelete();
      // Once its tab was shown, this file is the one played into, even when the change was interrupted before its first edit.
      if (shown) this.lastRelPath = e.relPath;
    }
    if (e.kind === 'delete') {
      this.store(e);
      return;
    }
    if (!editor || !(editor = await this.ready(e.relPath, editor, epoch))) return;
    await setText(editor.document, e.after, e.eol);
    this.store(e);
  }

  /** Carries out one step that acts on the mirror's editor. Undefined once the change was interrupted. */
  private async apply(relPath: string, editor: vscode.TextEditor, step: TypingStep, epoch: number): Promise<vscode.TextEditor | undefined> {
    const doc = editor.document;
    switch (step.kind) {
      case 'caret': {
        const caret = posAt(doc, step.at);
        editor.selection = new vscode.Selection(caret, caret);
        return editor;
      }
      case 'reveal': {
        const at = posAt(doc, step.at);
        if (step.scroll) return this.scrollTo(relPath, editor, at.line, epoch);
        editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        return editor;
      }
      case 'mark':
        this.previewDelete(editor, step.from, step.to);
        return editor;
      case 'select': {
        const range = new vscode.Range(posAt(doc, step.from), posAt(doc, step.to));
        editor.selection = new vscode.Selection(range.start, range.end);
        if (step.reveal) editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        return editor;
      }
      case 'delete': {
        await this.edit(doc, step.from, step.to, '');
        const caret = posAt(doc, step.from);
        editor.selection = new vscode.Selection(caret, caret);
        return editor;
      }
      case 'insert': {
        await this.edit(doc, step.at, step.at, step.text);
        const caret = posAt(doc, step.at + step.text.length);
        editor.selection = new vscode.Selection(caret, caret);
        return editor;
      }
      case 'replace':
        await this.edit(doc, 0, this.expected.length, step.text);
        return editor;
      case 'added':
        if (!this.settings().highlightAdditions) this.flashRange(editor, new vscode.Range(posAt(doc, step.from), posAt(doc, step.to)));
        return editor;
      default:
        return editor;
    }
  }

  /**
   * The move half of a rename: shows the old mirror with the before text,
   * then opens the new mirror with that text and removes the old one. The
   * rest of play() types any edit into the new mirror. False if interrupted.
   */
  private async moveMirror(e: ChangeEvent, from: string, epoch: number): Promise<boolean> {
    const s = this.settings();
    const switching = this.lastRelPath !== undefined && this.lastRelPath !== from;
    if (switching) {
      await this.readPause(epoch);
      if (!this.live(epoch)) return false;
    }
    this.setPlaybackPath(from);
    this.currentEol = e.eol;
    this.expected = e.before;
    this.liveRelPath = from;
    this.liveEpoch = epoch;
    this.synced = undefined;
    let editor: vscode.TextEditor | undefined = await this.showMirror(from, e.before, e.eol);
    if (switching) await this.sleep(s.fileSwitchDelayMs / this.speedMultiplier(s));
    if (!(editor = await this.ready(from, editor, epoch))) return false;
    await this.sleep(500 / this.speedMultiplier(s));
    if (!this.live(epoch)) return false;
    this.mirror.store(MirrorFileSystem.uriFor(e.relPath), mirrorBytes(e.before, e.eol));
    this.liveRelPath = e.relPath;
    this.setPlaybackPath(e.relPath);
    await this.showMirror(e.relPath, e.before, e.eol);
    await this.retireMirror(from);
    this.lastRelPath = e.relPath;
    return this.live(epoch);
  }

  /** Closes a mirror's tabs and removes its document: its file was renamed away. */
  private async retireMirror(relPath: string): Promise<void> {
    const uri = MirrorFileSystem.uriFor(relPath);
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
    this.mirror.deleteFile(uri);
  }

  // ---------------------------------------------------------------- typing

  /**
   * Brings `line` into view after a read pause: not at all when it came into
   * view meanwhile (the user scrolled, or resized the editor), by a jump with
   * smoothScroll off or after finish now, otherwise by scrolling there.
   * Undefined once the change was interrupted.
   */
  private async scrollTo(relPath: string, editor: vscode.TextEditor, line: number, epoch: number): Promise<vscode.TextEditor | undefined> {
    const s = this.settings();
    const at = new vscode.Range(line, 0, line, 0);
    let ed: vscode.TextEditor | undefined = editor;
    if (inView(ed, line)) return ed;
    const now = ed.visibleRanges;
    if (!s.smoothScroll || this.finishNow || now.length === 0) {
      ed.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return ed;
    }
    const first = now[0].start.line;
    const height = now[now.length - 1].end.line - first + 1;
    let shown = first;
    const steps = scrollSteps(shown, centeredTop(line, height, ed.document.lineCount), height, s.scrollLinesPerSecond, this.speedMultiplier(s));
    // Each frame shows the step for the time elapsed, so late timers skip
    // steps instead of stretching the scroll. Time spent paused doesn't count.
    let started = Date.now();
    for (let k = -1; k < steps.length - 1; ) {
      const waited = Date.now();
      if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
      started += Date.now() - waited;
      if (this.finishNow) break;
      k = Math.min(steps.length - 1, Math.max(k + 1, Math.floor((Date.now() - started) / SCROLL_FRAME_MS)));
      if (steps[k] !== shown) {
        ed.revealRange(new vscode.Range(steps[k], 0, steps[k], 0), vscode.TextEditorRevealType.AtTop);
        shown = steps[k];
      }
      if (k < steps.length - 1) await this.sleep(SCROLL_FRAME_MS);
    }
    if (!(ed = await this.ready(relPath, ed, epoch))) return undefined;
    // Lands on the edit after finish now, a frame VS Code clamped, or a scroll by the user during a pause.
    ed.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return ed;
  }

  // ---------------------------------------------------------------- pacing

  private speedMultiplier(s: Settings): number {
    return catchUpSpeed(this.timeline.pendingCount(), s) * this.manualSpeed;
  }

  /**
   * Before the view leaves what was just typed: waits until readPauseSeconds
   * (divided by the speed) have passed since the last edit, then holds while
   * paused. Nothing to wait for when playback jumped since that edit.
   */
  private async readPause(epoch: number): Promise<void> {
    if (this.lastEditEpoch !== epoch) return;
    // Waited in short steps, so a speed, catch-up or setting change during the pause takes effect.
    for (;;) {
      const s = this.settings();
      const left = readPauseLeft(this.lastEditAt, Date.now(), s.readPauseSeconds, this.speedMultiplier(s));
      if (left <= 0 || this.finishNow || !this.live(epoch)) break;
      await this.sleep(Math.min(left, READ_PAUSE_STEP_MS));
    }
    await this.whilePaused(epoch);
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
      this.edited.fire(relPath);
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
    this.lastEditAt = Date.now();
    this.lastEditEpoch = this.liveEpoch;
    this.storeExpected(doc.uri);
    if (this.liveRelPath !== undefined) this.edited.fire(this.liveRelPath);
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

  /**
   * Shows LF offsets [from, to) of the editor's mirror as about to be deleted,
   * while markDeletions is on. With no range, takes the preview down.
   */
  private previewDelete(editor?: vscode.TextEditor, from = 0, to = 0): void {
    const show = editor !== undefined && to > from && this.settings().markDeletions;
    try {
      if (this.previewed && this.previewed !== editor) this.previewed.setDecorations(this.deleting, []);
      if (editor) editor.setDecorations(this.deleting, show ? [new vscode.Range(posAt(editor.document, from), posAt(editor.document, to))] : []);
    } catch {
      // Editor already closed.
    }
    this.previewed = show ? editor : undefined;
    this.previewedText = show ? this.expected.slice(from, to) : undefined;
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

  /** Waits `ms` (at most 15 s, the longest read pause or file-switch delay), or less once finish now is pressed, the change is interrupted, or the player disposed. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.finishNow) return Promise.resolve();
    const epoch = this.epoch;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      const wake = () => {
        if (this.finishNow || this.epoch !== epoch || this.disposed) done();
        else this.waiters.push(wake);
      };
      const timer = setTimeout(done, Math.min(ms, 15000));
      this.waiters.push(wake);
    });
  }
}

/** True when lines `first` to `last` all lie inside one of the editor's visible ranges. */
function inView(editor: vscode.TextEditor, first: number, last = first): boolean {
  return editor.visibleRanges.some((r) => r.start.line <= first && last <= r.end.line);
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
