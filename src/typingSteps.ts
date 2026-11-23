// How a person would type one change: the steps every frontend applies, the
// VS Code player to a mirror editor and the Claude Code plugin to the text its
// pane shows. Every typing decision lives here; a frontend only carries steps
// out. The generator is lazy, so each decision is made right after the step
// before it was applied, reading the speed, settings, caret, viewport and
// finish-now state the host reports at that moment.
//
// Offsets are UTF-16 code units into the LF-normalized text. Pure: no vscode,
// no Node built-ins, so the plugin's neutral bundle can take it.

import { caretPath, type Caret } from './caretPath';
import { baseCharsPerMinute } from './pace';
import type { PlaybackSettings } from './playbackSettings';
import { authoringOrder, planHunks, type Hunk } from './planner';
import { backspaceStep, typingChunkEnd } from './typingChunks';


/** Deletions this long or shorter, within one line, are backspaced; longer ones are selected and deleted. */
export const BACKSPACE_MAX = 24;
/** More arrow presses than this to reach an edit, and the caret is clicked there instead. */
export const ARROW_MAX_KEYS = 24;
/** Chunk size is the characters typed in one tick at this rate. */
export const TICK_HZ = 60;
/** The longest wait a step asks for, in ms: the longest read pause or file-switch delay. */
export const MAX_WAIT_MS = 15000;
/** Beat when the caret reaches an edit, before deleting or typing there. */
export const ARRIVE_MS = 220;
/** Beat a long deletion stays selected before it goes. */
export const SELECT_MS = 380;
/** Beat a deleted file's whole text stays selected before it goes. */
export const DELETE_FILE_MS = 500;

/** What the steps read live from the frontend's settings: the shared playback settings and the base speed. */
export type TypingSettings = PlaybackSettings & { charsPerMinute: number };

/** The change to type, texts normalized to LF. A `delete` removes the whole file; any other kind types `before` into `after`. */
export interface TypingChange {
  before: string;
  after: string;
  kind: string;
}

/**
 * How the change starts. `switching`: another file was shown before this one,
 * so the read pause comes first and the file-switch delay after the file is
 * shown. `jump`: the first edit is brought into view at once and the caret
 * clicked there (a file switch, the first change played, or a rename).
 */
export interface TypingStart {
  switching: boolean;
  jump: boolean;
}

/** What the steps ask the frontend, each time a decision needs it. */
export interface TypingHost {
  settings(): TypingSettings;
  /** The playback speed multiplier: catch-up times manual speed. */
  speed(): number;
  /** Whether finish now was pressed: the rest of the change goes in at once. */
  finishing(): boolean;
  /** Where the caret is now. */
  caret(): Caret;
  /** Whether lines `first` to `last` are all in view; undefined when the frontend has no viewport to tell. */
  inView(first: number, last: number): boolean | undefined;
  /** The language whose per-language speed applies, if any. */
  languageId(): string;
}

export type TypingStep =
  /** Wait until the read pause has passed since the last edit. */
  | { kind: 'readPause' }
  /** Bring the change's file up, holding its before text. */
  | { kind: 'show' }
  /** Put the caret at `at`: an arrow press, or a click. */
  | { kind: 'caret'; at: number }
  /**
   * Bring the line of `at` into view if it is not. With `scroll`, this comes
   * after a read pause: the frontend looks again, and may scroll there rather
   * than jump.
   */
  | { kind: 'reveal'; at: number; scroll: boolean }
  /** Text about to be deleted, [from, to); from === to takes the mark down. `oneStep`: it goes in one step rather than backspaced. */
  | { kind: 'mark'; from: number; to: number; oneStep: boolean }
  /** Select [from, to), bringing it into view with `reveal`. */
  | { kind: 'select'; from: number; to: number; reveal: boolean }
  /** Delete [from, to), leaving the caret at `from`. */
  | { kind: 'delete'; from: number; to: number }
  /** Insert `text` at `at`, leaving the caret after it. */
  | { kind: 'insert'; at: number; text: string }
  /** Replace the whole text at once. */
  | { kind: 'replace'; text: string }
  /** Text just put in, [from, to): a hunk typed in full, or a whole text replaced. For highlights. */
  | { kind: 'added'; from: number; to: number }
  /** Wait `ms`, already divided by the speed, at most MAX_WAIT_MS. */
  | { kind: 'wait'; ms: number };

/** Where the caret waits before typing `h`: after the text it backspaces, or where the edit starts. */
export function caretBeforeHunk(h: Hunk): number {
  return isBackspaced(h.deleteText) ? h.offset + h.deleteText.length : h.offset;
}

/** The hunks a change is typed in, in the order they are typed. */
export function typingHunks(before: string, after: string, naturalOrder: boolean): Hunk[] {
  const planned = planHunks(before, after);
  return naturalOrder ? authoringOrder(planned, after) : planned;
}

function isBackspaced(deleted: string): boolean {
  return deleted.length > 0 && deleted.length <= BACKSPACE_MAX && !deleted.includes('\n');
}

/**
 * The steps that type `change`. Applying its edit steps (delete, insert,
 * replace) to the before text in order gives the after text exactly, whenever
 * finish now is pressed.
 */
export function* typingSteps(change: TypingChange, start: TypingStart, host: TypingHost, random: () => number): Generator<TypingStep, void, void> {
  let text = change.before;
  const humanize = (ms: number) => Math.max(0, ms * (1 + host.settings().jitter * 0.8 * (random() * 2 - 1)));
  const wait = (ms: number): TypingStep[] => (ms > 0 ? [{ kind: 'wait', ms: Math.min(ms, MAX_WAIT_MS) }] : []);
  const cps = () => {
    const s = host.settings();
    return (baseCharsPerMinute(host.languageId(), s.charsPerMinute, s.languageSpeeds) / 60) * host.speed();
  };
  const lineStart = (line: number) => {
    let at = 0;
    for (let n = 0; n < line; n++) {
      const nl = text.indexOf('\n', at);
      if (nl === -1) return at;
      at = nl + 1;
    }
    return at;
  };
  const lineText = (line: number) => {
    const at = lineStart(line);
    const nl = text.indexOf('\n', at);
    return text.slice(at, nl === -1 ? undefined : nl);
  };
  const toCaret = (offset: number): Caret => {
    const at = Math.max(0, Math.min(offset, text.length));
    const begin = at > 0 ? text.lastIndexOf('\n', at - 1) + 1 : 0;
    let line = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < begin; i = text.indexOf('\n', i + 1)) line++;
    return { line, character: at - begin };
  };
  const offsetOf = (c: Caret) => lineStart(c.line) + c.character;
  const lineCount = () => {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    return n;
  };
  /** `c` moved onto the text: a frontend's caret can sit past its end, or a line's. */
  const clampCaret = (c: Caret): Caret => {
    const line = Math.max(0, Math.min(c.line, lineCount() - 1));
    return { line, character: Math.max(0, Math.min(c.character, lineText(line).length)) };
  };
  const del = (from: number, to: number): TypingStep => {
    text = text.slice(0, from) + text.slice(to);
    return { kind: 'delete', from, to };
  };
  const ins = (at: number, t: string): TypingStep => {
    text = text.slice(0, at) + t + text.slice(at);
    return { kind: 'insert', at, text: t };
  };
  const replace = (t: string): TypingStep => {
    text = t;
    return { kind: 'replace', text: t };
  };

  /** Brings `line` into view: at once, or after the read pause when it is out of view and `smooth`. */
  function* scrollTo(line: number, smooth: boolean): Generator<TypingStep, void, void> {
    const at = lineStart(line);
    if (!smooth || host.finishing() || host.inView(line, line) === undefined) {
      yield { kind: 'reveal', at, scroll: false };
      return;
    }
    if (host.inView(line, line)) return;
    yield { kind: 'readPause' };
    yield { kind: 'reveal', at, scroll: true };
  }

  /** Moves the caret to `offset`: walking with arrow keys when close and in view, otherwise clicking there. */
  function* navigate(offset: number, smooth: boolean, continues: boolean): Generator<TypingStep, void, void> {
    const s = host.settings();
    const from = clampCaret(host.caret());
    const to = toCaret(offset);
    // One visible range holds the whole walk, so the caret never enters a folded region and unfolds it.
    const walk = smooth && s.arrowNavigation && !host.finishing() && host.inView(Math.min(from.line, to.line), Math.max(from.line, to.line)) === true;
    yield* scrollTo(to.line, smooth && !continues);
    const keys = walk ? caretPath(lineText, from, to, ARROW_MAX_KEYS) : undefined;
    for (const k of keys ?? []) {
      if (host.finishing()) break;
      yield { kind: 'caret', at: offsetOf(k) };
      yield* wait(humanize(1000 / host.settings().arrowKeysPerSecond) / host.speed());
    }
    yield { kind: 'caret', at: offset };
    yield { kind: 'reveal', at: offset, scroll: false };
  }

  function* deleteText(h: Hunk): Generator<TypingStep, void, void> {
    // Characters of this hunk still in the text, counted from h.offset.
    let remaining = h.deleteText.length;
    if (isBackspaced(h.deleteText)) {
      while (remaining > 0 && !host.finishing()) {
        const rate = cps() * 1.6;
        const step = backspaceStep(h.deleteText, remaining, Math.round(rate / TICK_HZ));
        yield del(h.offset + remaining - step, h.offset + remaining);
        remaining -= step;
        yield { kind: 'mark', from: h.offset, to: h.offset + remaining, oneStep: false };
        yield* wait(humanize((step * 1000) / rate));
      }
      if (remaining === 0) return;
    }
    // Longer or multi-line deletions, or the rest after finish now: select, a beat so the selection registers, then delete.
    yield { kind: 'mark', from: h.offset, to: h.offset + remaining, oneStep: true };
    yield { kind: 'select', from: h.offset, to: h.offset + remaining, reveal: true };
    if (!host.finishing()) {
      yield* wait(humanize(SELECT_MS) / host.speed());
      // The text may have been put back, or its tab reopened, meanwhile.
      yield { kind: 'select', from: h.offset, to: h.offset + remaining, reveal: true };
    }
    yield del(h.offset, h.offset + remaining);
  }

  function* typeText(offset: number, insert: string): Generator<TypingStep, void, void> {
    let i = 0;
    while (i < insert.length) {
      if (host.finishing()) {
        yield ins(offset + i, insert.slice(i));
        return;
      }
      const rate = cps();
      const at = offset + i;
      let chunk = '';
      let instant = false;
      if (at === 0 || text[at - 1] === '\n') {
        // Editors auto-indent; nobody types leading spaces one by one.
        const indent = /^[ \t]+/.exec(insert.slice(i, i + 256));
        if (indent) {
          chunk = indent[0];
          instant = true;
        }
      }
      if (!chunk) chunk = insert.slice(i, typingChunkEnd(insert, i, Math.round(rate / TICK_HZ)));
      yield ins(at, chunk);
      i += chunk.length;
      if (chunk.includes('\n') || i === chunk.length) yield { kind: 'reveal', at: offset + i, scroll: false };
      if (!instant) yield* wait(delayAfter(chunk, rate));
    }
    yield { kind: 'added', from: offset, to: offset + insert.length };
  }

  function delayAfter(chunk: string, rate: number): number {
    const jitter = host.settings().jitter;
    const perChar = 1000 / rate;
    let ms = humanize(chunk.length * perChar);
    const last = chunk[chunk.length - 1];
    if (last === '\n') ms += perChar * (2 + random() * 4 * jitter);
    else if (last === ';' || last === '{' || last === '}' || last === ',') ms += perChar * 1.5 * random();
    // Occasional "thinking" pause at the end of a line.
    if (last === '\n' && random() < 0.04 * jitter) ms += (300 + random() * 700) / host.speed();
    return ms;
  }

  function* typeHunk(h: Hunk, smooth: boolean): Generator<TypingStep, void, void> {
    yield* navigate(caretBeforeHunk(h), smooth, h.continues === true);
    // The text to delete shows as such from when the caret arrives until it is gone.
    if (h.deleteText.length > 0) yield { kind: 'mark', from: h.offset, to: h.offset + h.deleteText.length, oneStep: !isBackspaced(h.deleteText) };
    yield* wait(humanize(ARRIVE_MS) / host.speed());
    if (h.deleteText.length > 0) {
      yield* deleteText(h);
      yield { kind: 'mark', from: h.offset, to: h.offset, oneStep: false };
    }
    if (h.insertText.length > 0) yield* typeText(h.offset, h.insertText);
  }

  // The last file stays in view while it is read.
  if (start.switching) yield { kind: 'readPause' };
  yield { kind: 'show' };
  if (start.switching) yield* wait(host.settings().fileSwitchDelayMs / host.speed());

  if (change.kind === 'delete') {
    const all = text.length;
    yield { kind: 'select', from: 0, to: all, reveal: false };
    yield { kind: 'mark', from: 0, to: all, oneStep: true };
    yield* wait(DELETE_FILE_MS / host.speed());
    yield del(0, all);
    yield { kind: 'mark', from: 0, to: 0, oneStep: true };
    return;
  }

  const s = host.settings();
  const hunks = typingHunks(change.before, change.after, s.naturalOrder);
  const inserted = hunks.reduce((n, h) => n + h.insertText.length, 0);
  if (inserted > s.maxAnimatedChars) {
    yield replace(change.after);
    yield { kind: 'added', from: 0, to: change.after.length };
    return;
  }

  // After a file switch or a rename, the first edit is jumped to; later ones are scrolled to.
  let smooth = !start.jump;
  for (const h of hunks) {
    if (host.finishing()) {
      // Pressed before this edit was reached: it is brought into view at once, and the rest put in below.
      yield* navigate(h.offset, false, false);
      break;
    }
    yield* typeHunk(h, smooth);
    smooth = true;
  }
  if (text !== change.after) yield replace(change.after);
}
