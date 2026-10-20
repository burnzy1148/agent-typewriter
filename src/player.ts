import * as vscode from 'vscode';
import { MirrorFileSystem } from './mirrorFs';
import { baseCharsPerSecond } from './pace';
import { planHunks, type Hunk } from './planner';
import type { ChangeEvent, Timeline } from './timeline';
import type { Settings } from './config';

const BACKSPACE_MAX = 24;
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
  private waiters: Array<() => void> = [];
  private inFlight: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();
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

  setSpeed(multiplier: number): void {
    this.manualSpeed = Math.max(0.1, multiplier);
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
  }

  /** Puts every mirror document straight into its newest recorded state. */
  async snapToLatest(): Promise<void> {
    let newest: ChangeEvent | undefined;
    for (const [, e] of this.timeline.latestStates()) {
      const uri = MirrorFileSystem.uriFor(e.relPath);
      if (!newest || e.seq > newest.seq) newest = e;
      if (!this.mirror.has(uri)) continue;
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() === e.after) continue;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange(doc), e.after);
      await vscode.workspace.applyEdit(edit);
      await this.save(doc);
    }
    if (newest) {
      const editor = await this.showMirror(newest.relPath, newest.after);
      if (editor.document.getText() !== newest.after) await replaceAll(editor, newest.after);
      this.lastRelPath = newest.relPath;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.subscription.dispose();
    this.flash.dispose();
    this.poke();
  }

  // ---------------------------------------------------------------- loop

  private async loop(): Promise<void> {
    while (!this.disposed) {
      const next = this.paused ? undefined : this.timeline.peek();
      if (!next) {
        await this.nextPoke();
        continue;
      }
      const token = this.timeline.begin(next.seq);
      this.finishNow = false;
      const epoch = this.epoch;
      this.inFlight = this.play(next, epoch).catch((err) => {
        this.log.appendLine(`Playback of ${next.relPath} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      await this.inFlight;
      this.timeline.complete(next.seq, token);
    }
  }

  private async play(e: ChangeEvent, epoch: number): Promise<void> {
    const s = this.settings();
    const switching = this.lastRelPath !== e.relPath;
    let editor = await this.showMirror(e.relPath, e.before);
    if (switching && this.lastRelPath !== undefined) {
      await this.sleep(s.fileSwitchDelayMs / this.speedMultiplier(s));
    }
    this.lastRelPath = e.relPath;

    // The mirror might not match this event's "before" (first replay, after a
    // seek, or if someone typed into it). Snap it so the hunks line up.
    if (editor.document.getText() !== e.before) await replaceAll(editor, e.before);

    if (e.kind === 'delete') {
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), editor.document.positionAt(e.before.length));
      await this.sleep(500 / this.speedMultiplier(s));
      await replaceAll(editor, '');
      await this.save(editor.document);
      return;
    }

    const hunks = planHunks(e.before, e.after);
    const inserted = hunks.reduce((n, h) => n + h.insertText.length, 0);
    if (inserted > s.maxAnimatedChars) {
      await replaceAll(editor, e.after);
      this.flashRange(editor, new vscode.Range(0, 0, editor.document.lineCount, 0));
      await this.save(editor.document);
      return;
    }

    for (const h of hunks) {
      if (this.epoch !== epoch || this.disposed) return;
      if (this.finishNow) break;
      editor = await this.editorFor(e.relPath, editor);
      await this.typeHunk(e.relPath, editor, h, epoch);
    }
    if (this.epoch !== epoch) return;

    editor = await this.editorFor(e.relPath, editor);
    if (editor.document.getText() !== e.after) await replaceAll(editor, e.after);
    await this.save(editor.document);
  }

  // ---------------------------------------------------------------- typing

  private async typeHunk(relPath: string, editor: vscode.TextEditor, h: Hunk, epoch: number): Promise<void> {
    const s = this.settings();
    const doc = editor.document;
    const start = doc.positionAt(h.offset);

    // Navigate: put the caret where the edit happens, the way a person clicks there.
    const caretAt = h.deleteText.length > 0 && h.deleteText.length <= BACKSPACE_MAX && !h.deleteText.includes('\n')
      ? doc.positionAt(h.offset + h.deleteText.length)
      : start;
    editor.selection = new vscode.Selection(caretAt, caretAt);
    editor.revealRange(new vscode.Range(caretAt, caretAt), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await this.sleep(this.humanize(220, s) / this.speedMultiplier(s));

    if (h.deleteText.length > 0) {
      await this.deleteText(relPath, editor, h, epoch);
      if (this.epoch !== epoch) return;
    }
    if (h.insertText.length > 0) {
      await this.typeText(relPath, editor, h.offset, h.insertText, epoch);
    }
  }

  private async deleteText(relPath: string, editor: vscode.TextEditor, h: Hunk, epoch: number): Promise<void> {
    const s = this.settings();
    // Characters of this hunk still in the document, counted from h.offset.
    let remaining = h.deleteText.length;

    if (remaining <= BACKSPACE_MAX && !h.deleteText.includes('\n')) {
      // Short deletions: backspace one character at a time from the end.
      while (remaining > 0 && !this.finishNow) {
        if (this.epoch !== epoch) return;
        await this.whilePaused(epoch);
        if (this.finishNow) break;
        editor = await this.editorFor(relPath, editor);
        const doc = editor.document;
        const cps = this.cps(s, doc) * 1.6;
        const step = Math.min(remaining, Math.max(1, Math.round(cps / TICK_HZ)));
        const from = doc.positionAt(h.offset + remaining - step);
        const to = doc.positionAt(h.offset + remaining);
        await editSafe(editor, (b) => b.delete(new vscode.Range(from, to)));
        remaining -= step;
        editor.selection = new vscode.Selection(from, from);
        await this.sleep(this.humanize((step * 1000) / cps, s));
      }
      if (remaining === 0) return;
    }

    // Longer or multi-line deletions (or the rest after "finish now"):
    // select the text, pause so the selection registers, then delete it.
    editor = await this.editorFor(relPath, editor);
    const doc = editor.document;
    const range = new vscode.Range(doc.positionAt(h.offset), doc.positionAt(h.offset + remaining));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!this.finishNow) await this.sleep(this.humanize(380, s) / this.speedMultiplier(s));
    await editSafe(editor, (b) => b.delete(range));
    editor.selection = new vscode.Selection(range.start, range.start);
  }

  private async typeText(relPath: string, editor: vscode.TextEditor, offset: number, text: string, epoch: number): Promise<void> {
    const s = this.settings();
    let i = 0;
    while (i < text.length) {
      if (this.epoch !== epoch) return;
      await this.whilePaused(epoch);
      editor = await this.editorFor(relPath, editor);
      const doc = editor.document;

      if (this.finishNow) {
        const at = doc.positionAt(offset + i);
        await editSafe(editor, (b) => b.insert(at, text.slice(i)));
        return;
      }

      const cps = this.cps(s, doc);
      const atLineStart = doc.positionAt(offset + i).character === 0;
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
      if (!chunk) {
        const perTick = Math.max(1, Math.round(cps / TICK_HZ));
        let j = i;
        while (j < text.length && j - i < perTick) {
          j++;
          if (text[j - 1] === '\n') break;
        }
        chunk = text.slice(i, j);
      }

      const at = doc.positionAt(offset + i);
      await editSafe(editor, (b) => b.insert(at, chunk));
      i += chunk.length;
      const caret = doc.positionAt(offset + i);
      editor.selection = new vscode.Selection(caret, caret);
      if (chunk.includes('\n') || i === chunk.length) {
        editor.revealRange(new vscode.Range(caret, caret), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      if (!instant) await this.sleep(this.delayAfter(chunk, cps, s));
    }
    const end = editor.document.positionAt(offset + text.length);
    this.flashRange(editor, new vscode.Range(editor.document.positionAt(offset), end));
  }

  // ---------------------------------------------------------------- pacing

  private speedMultiplier(s: Settings): number {
    const catchUp = Math.min(s.maxSpeedup, 1 + s.catchUpFactor * this.timeline.pendingCount());
    return catchUp * this.manualSpeed;
  }

  private cps(s: Settings, doc: vscode.TextDocument): number {
    return baseCharsPerSecond(doc.languageId, s.charsPerSecond, s.languageSpeeds) * this.speedMultiplier(s);
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

  private async showMirror(relPath: string, initial: string): Promise<vscode.TextEditor> {
    const uri = MirrorFileSystem.uriFor(relPath);
    if (!this.mirror.has(uri)) this.mirror.writeFile(uri, this.encoder.encode(initial));
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
    const editor = await this.showMirror(relPath, '');
    return editor;
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

  private async save(doc: vscode.TextDocument): Promise<void> {
    try {
      if (doc.isDirty) await doc.save();
    } catch {
      // Saving only exists to keep the tab from showing as modified.
    }
  }

  // ---------------------------------------------------------------- waiting

  private poke(): void {
    const waiting = this.waiters.splice(0);
    for (const w of waiting) w();
  }

  private nextPoke(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async whilePaused(epoch: number): Promise<void> {
    while (this.paused && this.epoch === epoch && !this.disposed && !this.finishNow) await this.nextPoke();
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.finishNow) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5000)));
  }
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
}

async function replaceAll(editor: vscode.TextEditor, text: string): Promise<void> {
  await editSafe(editor, (b) => b.replace(fullRange(editor.document), text));
}

async function editSafe(editor: vscode.TextEditor, fn: (b: vscode.TextEditorEdit) => void): Promise<void> {
  const ok = await editor.edit(fn, { undoStopBefore: false, undoStopAfter: false });
  if (!ok) throw new Error('editor rejected the edit (tab closed or document changed)');
}
