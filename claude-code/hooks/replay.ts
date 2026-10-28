// Playback for the Claude Code plugin, as pure functions over a Deck the hooks
// keep in $.state. A timer calls tick() every TICK_MS; nothing here touches the
// engine, so the unit tests in test/claudeCodeReplay.test.ts run it directly.

import { authoringOrder, backspaceStep, planHunks, typingChunkEnd, type Hunk } from './core.mjs';
import type { Change, Deck, Playback, Shown } from '../types';

export type { Change, Deck, Playback, Shown };

export const TICK_MS = 50;
export const DEFAULT_CHARS_PER_MINUTE = 1000;
/** Most recorded changes that wait to play; the oldest is dropped past this. */
export const MAX_WAITING = 200;
/** Files larger than this, before or after, are not typed. */
export const MAX_REPLAY_BYTES = 1_000_000;
/** How long the "too large to replay" note stays before the next change. */
const TOO_LARGE_HOLD_TICKS = 20;

export type PlayOptions = { charsPerMinute: number; naturalOrder: boolean };

export const emptyDeck: Deck = { queue: [], isPaused: false, hold: 0, recorded: 0 };

/** The plugin's options as playback reads them; a speed that is not a positive number is the default. */
export function playOptions(options: Readonly<Record<string, unknown>>): PlayOptions {
  const cpm = Number(options.charsPerMinute);
  return {
    charsPerMinute: Number.isFinite(cpm) && cpm > 0 ? cpm : DEFAULT_CHARS_PER_MINUTE,
    naturalOrder: options.naturalOrder !== false,
  };
}

export function enqueue(deck: Deck, change: Change): Deck {
  if (!change.isTooLarge && change.before === change.after) return deck;
  return { ...deck, queue: [...deck.queue, change].slice(-MAX_WAITING), recorded: deck.recorded + 1 };
}

function plan(change: Change, opts: PlayOptions): Hunk[] {
  const hunks = planHunks(change.before, change.after);
  return opts.naturalOrder ? authoringOrder(hunks, change.after) : hunks;
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

function startNext(deck: Deck, opts: PlayOptions): Deck {
  const [change, ...queue] = deck.queue;
  if (!change) return deck;
  if (change.isTooLarge) return { ...deck, queue, shown: shownDone(change, 0), hold: TOO_LARGE_HOLD_TICKS };
  const hunks = plan(change, opts);
  const caret = hunks[0]?.offset ?? 0;
  const playing: Playback = { change, hunks, hunk: 0, deleted: 0, typed: 0, text: change.before, caret, credit: 0 };
  return { ...deck, queue, playing, shown: { path: change.path, text: change.before, caret } };
}

/** One keystroke of `budget` code units: a backspace step or a typed chunk. Returns the units used. */
function keystroke(p: Playback, budget: number): { p: Playback; used: number } {
  const h = p.hunks[p.hunk]!;
  const remaining = h.deleteText.length - p.deleted;
  if (remaining > 0) {
    const n = backspaceStep(h.deleteText, remaining, budget);
    const end = h.offset + remaining;
    return { p: { ...p, deleted: p.deleted + n, text: p.text.slice(0, end - n) + p.text.slice(end), caret: end - n }, used: n };
  }
  const j = typingChunkEnd(h.insertText, p.typed, budget);
  const at = h.offset + p.typed;
  const text = p.text.slice(0, at) + h.insertText.slice(p.typed, j) + p.text.slice(at);
  return { p: { ...p, typed: j, text, caret: h.offset + j }, used: j - p.typed };
}

/** Moves past finished hunks; undefined once the change is done. */
function nextHunk(p: Playback): Playback | undefined {
  let q = p;
  for (;;) {
    const h = q.hunks[q.hunk];
    if (!h) return undefined;
    if (q.deleted < h.deleteText.length || q.typed < h.insertText.length) return q;
    const next = q.hunks[q.hunk + 1];
    q = { ...q, hunk: q.hunk + 1, deleted: 0, typed: 0, caret: next ? next.offset : q.caret };
  }
}

/** The deck one tick later. Returns the same object when nothing moved. */
export function tick(deck: Deck, opts: PlayOptions): Deck {
  if (deck.isPaused) return deck;
  if (deck.hold > 0) return { ...deck, hold: deck.hold - 1 };
  if (!deck.playing) return startNext(deck, opts);

  const rate = (opts.charsPerMinute / 60) * (TICK_MS / 1000);
  const budget = deck.playing.credit + rate;
  let p = nextHunk(deck.playing);
  if (p && budget >= 1) {
    const step = keystroke(p, Math.floor(budget));
    p = nextHunk({ ...step.p, credit: Math.min(budget - step.used, rate + 1) });
  } else if (p) {
    p = { ...p, credit: budget };
  }
  if (!p) return { ...deck, playing: undefined, shown: shownDone(deck.playing.change, finalCaret(deck.playing.hunks)) };
  return { ...deck, playing: p, shown: { path: p.change.path, text: p.text, caret: p.caret } };
}

export function togglePause(deck: Deck): Deck {
  return { ...deck, isPaused: !deck.isPaused };
}

/** Finishes the current change at once; the next one starts on the next tick. */
export function finish(deck: Deck): Deck {
  const p = deck.playing;
  if (!p) return deck.hold > 0 ? { ...deck, hold: 0 } : deck;
  return { ...deck, playing: undefined, hold: 0, shown: shownDone(p.change, finalCaret(p.hunks)) };
}

/** Finishes every recorded change at once and shows the last one. */
export function skipToLatest(deck: Deck, opts: PlayOptions): Deck {
  const last = deck.queue[deck.queue.length - 1];
  if (!last) return finish(deck);
  const caret = last.isTooLarge ? 0 : finalCaret(plan(last, opts));
  return { ...deck, queue: [], playing: undefined, hold: 0, shown: shownDone(last, caret) };
}

/** `path` relative to the session's working directory, or as given when outside it. */
export function relativePath(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  const sep = path.charAt(base.length);
  return path.startsWith(base) && (sep === '/' || sep === '\\') ? path.slice(base.length + 1) : path;
}

/** The `rows` lines around the caret, with the caret marked while typing, and the first one's line number. */
export function windowAround(text: string, caret: number, rows: number, isTyping: boolean) {
  const marked = isTyping ? text.slice(0, caret) + '▍' + text.slice(caret) : text;
  const lines = marked.split('\n');
  const caretLine = text.slice(0, caret).split('\n').length - 1;
  const first = Math.max(0, Math.min(caretLine - Math.floor(rows / 2), lines.length - rows));
  return { source: lines.slice(first, first + rows).join('\n'), startLine: first + 1 };
}
