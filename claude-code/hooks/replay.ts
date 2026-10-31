// Playback for the Claude Code plugin, as functions over a Deck the hooks keep
// in module memory: the session's changes in the shared Timeline, on its
// default lane, and the change being typed. A timer calls tick() every TICK_MS;
// nothing here touches the engine, so the unit tests in
// test/claudeCodeReplay.test.ts run it directly. viewOf() and savedOf() are
// what the hooks write to $.state.

import { Timeline, authoringOrder, backspaceStep, countChanges, planHunks, typingChunkEnd, type ChangeEvent, type Hunk } from './core.mjs';
import type { Saved, SavedChange, View } from '../types';

export type { Saved, SavedChange, View };

export const TICK_MS = 50;
export const DEFAULT_CHARS_PER_MINUTE = 1000;
/** Most changes the timeline keeps; past this the oldest is dropped, played ones first, so at most this many wait. */
export const MAX_WAITING = 200;
/** Most before and after text, in characters, the timeline's changes hold in all; past it the oldest go first. */
export const MAX_WAITING_CHARS = 20_000_000;
/** Files larger than this, before or after, are not typed. */
export const MAX_REPLAY_BYTES = 1_000_000;
/** Deletions longer than this, or spanning lines, go in one step (as in src/player.ts). */
export const BACKSPACE_MAX = 24;
/** Changes that insert more than this are applied at once, as the extension's maxAnimatedChars default. */
export const MAX_ANIMATED_CHARS = 6000;
/** How long a change shown at once (too large, or applied instantly) stays before the next one. */
const HOLD_TICKS = 20;
/** Bounds the keystrokes one tick types, whatever the speed. */
const MAX_STEPS_PER_TICK = 2000;
/** The view keeps this many lines and columns around the caret. */
export const VIEW_LINES = 120;
export const VIEW_COLUMNS = 400;

/**
 * One recorded change, texts normalized to LF. A too-large change keeps no
 * text. `kind` says whether the file was new, and `time` is when the change was
 * recorded, in epoch milliseconds.
 */
export type Change = { id: string; path: string; before: string; after: string; kind: 'create' | 'modify'; time: number; isTooLarge?: boolean };

/** A Windows absolute path: a drive letter, or a UNC share. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A change as the timeline holds it; the timeline keeps every field of a change pushed to it. */
type Event = ChangeEvent & Change;

/**
 * `change` with the fields every timeline event carries. `uri` is the absolute
 * path and `relPath` the path relative to `cwd` with forward slashes, as the
 * extension's events name it; the line counts are real.
 */
function eventOf(change: Change, cwd: string | undefined): Omit<Event, 'seq'> {
  const { added, removed } = countChanges(change.before, change.after);
  const relative = relativePath(change.path, cwd);
  const relPath = WINDOWS_PATH.test(change.path) ? relative.replace(/\\/g, '/') : relative;
  return { ...change, uri: change.path, relPath, eol: '\n', linesAdded: added, linesRemoved: removed };
}

function changeOf(e: ChangeEvent): Change {
  const { id, path, before, after, kind, time, isTooLarge } = e as Event;
  return { id, path, before, after, kind, time, ...(isTooLarge && { isTooLarge }) };
}

export type Playback = {
  change: Change;
  /** The change's seq in the timeline, and the token begin() gave for it. */
  seq: number;
  token: number;
  hunks: Hunk[];
  hunk: number;
  /** Code units of the current hunk's deleteText already removed. */
  deleted: number;
  /** Code units of the current hunk's insertText already typed. */
  typed: number;
  text: string;
  caret: number;
  /** Typing budget carried over from earlier ticks, in code units. */
  credit: number;
};

/** What the pane shows: the playing change, or the last one played. */
export type Shown = { path: string; text: string; caret: number; isTooLarge?: boolean };

/** Playback's state, which its functions change in place. */
export type Deck = {
  /** The changes still kept, played or waiting, and the cursor between them. */
  timeline: Timeline;
  playing?: Playback;
  shown?: Shown;
  isPaused: boolean;
  /** Ticks to wait before starting the next change. */
  hold: number;
  /** Changes recorded this session, dropped ones included. */
  recorded: number;
};

export type PlayOptions = { charsPerMinute: number; naturalOrder: boolean };

export function newDeck(): Deck {
  return { timeline: new Timeline(MAX_WAITING, MAX_WAITING_CHARS), isPaused: false, hold: 0, recorded: 0 };
}

/** The plugin's options as playback reads them; a speed that is not a positive number is the default. */
export function playOptions(options: Readonly<Record<string, unknown>>): PlayOptions {
  const cpm = Number(options.charsPerMinute);
  return {
    charsPerMinute: Number.isFinite(cpm) && cpm > 0 ? cpm : DEFAULT_CHARS_PER_MINUTE,
    naturalOrder: options.naturalOrder !== false,
  };
}

/** A change that leaves the file as it was, which is not recorded. */
export function isUnchanged(change: Change): boolean {
  return !change.isTooLarge && change.before === change.after;
}

/**
 * Adds a recorded change, its path named relative to `cwd`, dropping the oldest
 * ones past either limit. Returns false, adding nothing, for an unchanged file.
 */
export function enqueue(deck: Deck, change: Change, cwd?: string): boolean {
  if (isUnchanged(change)) return false;
  // A restored deck may hold more than the limits allow (see restore); a new change brings it back within them.
  deck.timeline.setLimit(MAX_WAITING);
  deck.timeline.setSizeLimit(MAX_WAITING_CHARS);
  deck.timeline.push(eventOf(change, cwd));
  deck.recorded++;
  return true;
}

/** The changes waiting to play, oldest first; the one being typed is not among them. */
export function queued(deck: Deck): Change[] {
  const { timeline } = deck;
  return timeline.all().filter((e) => timeline.stateOf(e.seq) === 'pending').map(changeOf);
}

/** The changes played, oldest first. */
function played(deck: Deck): Change[] {
  const { timeline } = deck;
  return timeline.all().filter((e) => timeline.stateOf(e.seq) === 'played').map(changeOf);
}

/**
 * What a reload needs to rebuild the deck, texts aside. The change being typed
 * is kept even once the timeline has dropped it; by then it has dropped every
 * played change too, so the order holds.
 */
export function savedOf(deck: Deck): Saved {
  const done = played(deck);
  const changes = [...done, ...(deck.playing ? [deck.playing.change] : []), ...queued(deck)];
  return {
    changes: changes.map(({ id, path, kind, time, isTooLarge }): SavedChange => ({ id, path, kind, time, ...(isTooLarge && { isTooLarge }) })),
    played: done.length,
    recorded: deck.recorded,
    isPaused: deck.isPaused,
  };
}

/**
 * The deck a reload starts from. `changes` are the saved changes whose texts
 * were found, in saved order. Those `saved.played` counts as played stay
 * played, the last of them shown done; the rest wait, the one that was being
 * typed starting over.
 */
export function restore(saved: Saved, changes: Change[], opts: PlayOptions, cwd?: string): Deck {
  // The change being typed sat outside the limits, so with it the saved changes
  // can be one over them. The timeline holds them all until the next is recorded.
  const chars = changes.reduce((n, c) => n + c.before.length + c.after.length, 0);
  const timeline = new Timeline(Math.max(MAX_WAITING, changes.length), Math.max(MAX_WAITING_CHARS, chars));
  for (const change of changes) timeline.push(eventOf(change, cwd));
  const wasPlayed = new Set(saved.changes.slice(0, saved.played).map((c) => c.id));
  const done = changes.filter((c) => wasPlayed.has(c.id));
  const next = timeline.all()[done.length];
  if (next) timeline.seek(next.seq);
  else timeline.seekToEnd();
  const last = done.at(-1);
  return { ...newDeck(), timeline, ...(last && { shown: shownFinished(last, opts) }), recorded: saved.recorded, isPaused: saved.isPaused };
}

/** The tag `saved` is kept under. savedFrom also reads the tag before it. */
export const SAVED_SHAPE = 'saved-2';

/** `saved` as the `saved-1` tag kept it: the changes still to play, the one being typed first, without kind or time. */
type SavedV1 = { changes: { id: string; path: string; isTooLarge?: boolean }[]; recorded: number; isPaused: boolean };

/**
 * The Saved a stored `saved` value holds: as stored under SAVED_SHAPE; under
 * `saved-1`, which kept neither kind nor time, every change waiting, each a
 * modify at time 0; under any other tag, or none, nothing.
 */
export function savedFrom(stored: { shape: string; value: unknown } | undefined): Saved {
  if (stored?.shape === SAVED_SHAPE) return stored.value as Saved;
  if (stored?.shape !== 'saved-1') return savedOf(newDeck());
  const was = stored.value as SavedV1;
  return { ...was, changes: was.changes.map((c) => ({ ...c, kind: 'modify', time: 0 })), played: 0 };
}

function plan(change: Change, opts: PlayOptions): Hunk[] {
  const hunks = planHunks(change.before, change.after);
  return opts.naturalOrder ? authoringOrder(hunks, change.after) : hunks;
}

/** Where the caret waits before a hunk: after the text it deletes, or where it types. */
function caretBefore(h: Hunk | undefined, fallback: number): number {
  return h ? h.offset + h.deleteText.length : fallback;
}

/** Where the caret rests once every hunk is typed: the end of the last one. */
function finalCaret(hunks: Hunk[]): number {
  const last = hunks[hunks.length - 1];
  return last ? last.offset + last.insertText.length : 0;
}

function shownDone(change: Change, caret: number): Shown {
  return change.isTooLarge
    ? { path: change.path, text: '', caret: 0, isTooLarge: true }
    : { path: change.path, text: change.after, caret };
}

/** `change` shown done, the caret where typing it ends. */
function shownFinished(change: Change, opts: PlayOptions): Shown {
  return shownDone(change, change.isTooLarge ? 0 : finalCaret(plan(change, opts)));
}

/** Plays the change at `seq` in one go: `shown` stays a while before the next change. */
function showAtOnce(deck: Deck, seq: number, shown: Shown): boolean {
  deck.timeline.complete(seq);
  deck.shown = shown;
  deck.hold = HOLD_TICKS;
  return true;
}

/** Starts the next waiting change. Returns false when none waits. */
function startNext(deck: Deck, opts: PlayOptions): boolean {
  const next = deck.timeline.peek();
  if (!next) return false;
  const change = changeOf(next);
  if (change.isTooLarge) return showAtOnce(deck, next.seq, shownDone(change, 0));
  const hunks = plan(change, opts);
  if (hunks.reduce((n, h) => n + h.insertText.length, 0) > MAX_ANIMATED_CHARS) {
    return showAtOnce(deck, next.seq, shownDone(change, finalCaret(hunks)));
  }
  const caret = caretBefore(hunks[0], 0);
  const token = deck.timeline.begin(next.seq);
  deck.playing = { change, seq: next.seq, token, hunks, hunk: 0, deleted: 0, typed: 0, text: change.before, caret, credit: 0 };
  deck.shown = { path: change.path, text: change.before, caret };
  return true;
}

function isLongDeletion(h: Hunk): boolean {
  return h.deleteText.length > BACKSPACE_MAX || h.deleteText.includes('\n');
}

/**
 * One keystroke of at most `budget` code units: a backspace step, a long
 * deletion in one go, or a typed chunk. Returns the units it used, and whether
 * it ends the tick (a long deletion is shown on a frame of its own).
 */
function keystroke(p: Playback, budget: number): { p: Playback; used: number; endsTick: boolean } {
  const h = p.hunks[p.hunk]!;
  const remaining = h.deleteText.length - p.deleted;
  if (remaining > 0) {
    const n = isLongDeletion(h) ? remaining : backspaceStep(h.deleteText, remaining, budget);
    const end = h.offset + remaining;
    const text = p.text.slice(0, end - n) + p.text.slice(end);
    return { p: { ...p, deleted: p.deleted + n, text, caret: end - n }, used: isLongDeletion(h) ? 1 : n, endsTick: isLongDeletion(h) };
  }
  const j = typingChunkEnd(h.insertText, p.typed, budget);
  const at = h.offset + p.typed;
  const text = p.text.slice(0, at) + h.insertText.slice(p.typed, j) + p.text.slice(at);
  return { p: { ...p, typed: j, text, caret: h.offset + j }, used: j - p.typed, endsTick: false };
}

/** Moves past finished hunks; `hunk` reaches `hunks.length` once the change is done. */
function settle(p: Playback): Playback {
  let q = p;
  for (;;) {
    const h = q.hunks[q.hunk];
    if (!h || q.deleted < h.deleteText.length || q.typed < h.insertText.length) return q;
    q = { ...q, hunk: q.hunk + 1, deleted: 0, typed: 0, caret: caretBefore(q.hunks[q.hunk + 1], q.caret) };
  }
}

/** Moves playback one tick on. Returns false when nothing moved. */
export function tick(deck: Deck, opts: PlayOptions): boolean {
  if (deck.isPaused) return false;
  if (deck.hold > 0) {
    deck.hold--;
    return true;
  }
  if (!deck.playing) return startNext(deck, opts);

  const rate = (opts.charsPerMinute / 60) * (TICK_MS / 1000);
  let budget = deck.playing.credit + rate;
  let p = settle(deck.playing);
  for (let steps = 0; p.hunk < p.hunks.length && budget >= 1 && steps < MAX_STEPS_PER_TICK; steps++) {
    const step = keystroke(p, Math.floor(budget));
    budget -= step.used;
    p = settle(step.p);
    if (step.endsTick) break;
  }
  // Done: show the text playback typed, which planHunks guarantees is the after text.
  if (p.hunk >= p.hunks.length) {
    deck.timeline.complete(p.seq, p.token);
    deck.playing = undefined;
  } else deck.playing = { ...p, credit: Math.min(budget, rate + 1) };
  deck.shown = { path: p.change.path, text: p.text, caret: p.caret };
  return true;
}

export function togglePause(deck: Deck): void {
  deck.isPaused = !deck.isPaused;
}

/** Finishes the current change at once; the next one starts on the next tick. */
export function finish(deck: Deck): void {
  const p = deck.playing;
  deck.hold = 0;
  if (!p) return;
  deck.timeline.complete(p.seq, p.token);
  deck.playing = undefined;
  deck.shown = shownDone(p.change, finalCaret(p.hunks));
}

/** Finishes every recorded change at once and shows the last one. */
export function skipToLatest(deck: Deck, opts: PlayOptions): void {
  const last = queued(deck).at(-1);
  if (!last) return finish(deck);
  deck.timeline.seekToEnd();
  deck.playing = undefined;
  deck.hold = 0;
  deck.shown = shownFinished(last, opts);
}

/** `path` relative to the session's working directory, or as given when outside it. */
export function relativePath(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  const sep = path.charAt(base.length);
  return path.startsWith(base) && (sep === '/' || sep === '\\') ? path.slice(base.length + 1) : path;
}

/**
 * Control characters other than tab, which the engine refuses in a Code
 * source, as visible stand-ins: C0 as Unicode control pictures, DEL as ␡,
 * C1 as the replacement character. One code unit each, so columns hold.
 */
export function showControls(line: string): string {
  return line.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    return code === 0x7f ? '␡' : '�';
  });
}

/** `line` cut to `[from, from + width)`, never splitting a surrogate pair at either end. */
function cutColumns(line: string, from: number, width: number): string {
  let s = line.slice(from, from + width);
  if (/^[\uDC00-\uDFFF]/.test(s)) s = '�' + s.slice(1);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1) + '�';
  return s;
}

/** 0-based line of offset `at`. */
function lineOf(text: string, at: number): number {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Offset where the line holding offset `at` starts. */
function lineStart(text: string, at: number): number {
  return at > 0 ? text.lastIndexOf('\n', at - 1) + 1 : 0;
}

/** What the pane draws for `deck`: status, and a window of the shown text around the caret. */
export function viewOf(deck: Deck): View {
  const status = deck.isPaused ? 'paused' : deck.playing ? 'typing' : 'idle';
  const base = { status, queued: deck.timeline.pendingCount(), isTyping: deck.playing !== undefined } as const;
  const empty = { lines: [], firstLine: 1, firstColumn: 0, caretLine: 0, caretColumn: 0 };
  const s = deck.shown;
  if (!s) return { ...base, ...empty };
  if (s.isTooLarge) return { ...base, ...empty, path: s.path, isTooLarge: true };

  const caret = Math.max(0, Math.min(s.caret, s.text.length));
  const caretLine = lineOf(s.text, caret);
  let start = lineStart(s.text, caret);
  const caretColumn = caret - start;
  // Walk back from the caret's line to the first line the window keeps.
  let firstLine = caretLine;
  while (firstLine > 0 && caretLine - firstLine < VIEW_LINES / 2) {
    start = lineStart(s.text, start - 1);
    firstLine--;
  }
  const lines: string[] = [];
  const firstColumn = caretColumn < VIEW_COLUMNS - 100 ? 0 : caretColumn - VIEW_COLUMNS / 2;
  for (let at = start; lines.length < VIEW_LINES; ) {
    const nl = s.text.indexOf('\n', at);
    lines.push(showControls(cutColumns(s.text.slice(at, nl === -1 ? undefined : nl), firstColumn, VIEW_COLUMNS)));
    if (nl === -1) break;
    at = nl + 1;
  }
  return { ...base, path: s.path, lines, firstLine: firstLine + 1, firstColumn, caretLine, caretColumn };
}

/**
 * The rows of `view` that fit a pane `rows` high and `columns` wide, shifted
 * left when the caret would be past the right edge and cut at the right edge,
 * with the caret marked while typing. Returns the source to draw and the line number of its first row.
 */
export function frame(view: View, rows: number, columns: number): { source: string; startLine: number } {
  const caretRow = view.caretLine - (view.firstLine - 1);
  const top = Math.max(0, Math.min(caretRow - Math.floor(rows / 2), view.lines.length - rows));
  const caretX = view.caretColumn - view.firstColumn;
  const shift = caretX < columns - 2 ? 0 : caretX - columns + Math.ceil(columns / 3);
  const out = view.lines.slice(top, top + rows).map((line, i) => {
    const shown = cutColumns(line, shift, columns);
    if (!view.isTyping || top + i !== caretRow) return shown;
    return shown.slice(0, caretX - shift) + '▍' + shown.slice(caretX - shift);
  });
  return { source: out.join('\n'), startLine: view.firstLine + top };
}
