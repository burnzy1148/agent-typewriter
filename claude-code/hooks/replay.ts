// Playback for the Claude Code plugin, as functions over a Deck the hooks keep
// in module memory: the session's changes in the shared Timeline, a lane per
// loop (the main conversation's '' and each agent's by its id), and the change
// being typed. A timer calls tick() every TICK_MS;
// nothing here touches the engine, so the unit tests in
// test/claudeCodeReplay.test.ts run it directly. viewOf() and savedOf() are
// what the hooks write to $.state.

import {
  LANE_COLORS,
  Timeline,
  authoringOrder,
  autoFollowDecision,
  backspaceStep,
  colorSlot,
  countChanges,
  laneOf,
  planHunks,
  typingChunkEnd,
  type ChangeEvent,
  type Hunk,
} from './core.mjs';
import type { CallLinks, Clear, LaneChip, Listing, Row, Saved, SavedChange, SavedLane, Tab, Tool, TurnInfo, Turns, View } from '../types';
import { diffRows, lineAt, lineStarts, type DiffRow } from './marks';

export type { CallLinks, Clear, LaneChip, Listing, Row, Saved, SavedChange, SavedLane, Tab, Tool, TurnInfo, Turns, View };

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
/** Ticks the lines a long deletion removes are drawn removed before it lands: 400 ms. */
export const PREVIEW_TICKS = 8;
/** Most clears kept; past this the oldest go first. */
export const MAX_CLEARS = 50;

/**
 * One recorded change, texts normalized to LF. A too-large change keeps no
 * text. `number` is its place in the session's recording order, from 1, and
 * `tool` the tool that made it, unknown for a change an earlier version saved.
 * `kind` says whether the file was new, and `time` is when the change was
 * recorded, in epoch milliseconds. Its links name the turn and agent that made
 * it (CallLinks). `caption` is what the agent wrote before the call, as
 * normalizeCaption keeps it, absent when it wrote nothing there.
 */
export type Change = {
  id: string;
  number: number;
  tool?: Tool;
  path: string;
  before: string;
  after: string;
  kind: 'create' | 'modify';
  time: number;
  isTooLarge?: boolean;
  caption?: string;
} & CallLinks;

/** The links `x` has, leaving out the ones it lacks. */
export function linksOf(x: CallLinks): CallLinks {
  const { turnId, agentId, mainTurnId, agentCallId } = x;
  return { ...(turnId && { turnId }), ...(agentId && { agentId }), ...(mainTurnId && { mainTurnId }), ...(agentCallId && { agentCallId }) };
}

/** A change as recorded, before enqueue numbers it. */
export type NewChange = Omit<Change, 'number'>;

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
  return { ...change, uri: change.path, relPath, eol: '\n', linesAdded: added, linesRemoved: removed, ...(change.agentId && { lane: change.agentId }) };
}

/** The lane of `change`: the agent's id that made it, '' for the main conversation. */
function laneOfChange(change: { agentId?: string }): string {
  return change.agentId ?? '';
}

function changeOf(e: ChangeEvent): Change {
  const { id, number, tool, path, before, after, kind, time, isTooLarge, caption } = e as Event;
  return {
    id,
    number,
    ...(tool && { tool }),
    path,
    before,
    after,
    kind,
    time,
    ...(isTooLarge && { isTooLarge }),
    ...(caption && { caption }),
    ...linksOf(e as Event),
  };
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
  /**
   * Ticks left of the beat before the current hunk's long deletion lands,
   * while its lines are drawn removed; 0 once the beat is over, absent before
   * it starts.
   */
  preview?: number;
};

/** What the pane shows, and the id and caption of the change it shows: the playing change, a change cued to play next, or the last one played. */
export type Shown = { id: string; path: string; text: string; caret: number; isTooLarge?: boolean; caption?: string };

/** The caption field of `change`, for spreading into what shows it. */
function captionOf(change: { caption?: string }): { caption?: string } {
  return change.caption ? { caption: change.caption } : {};
}

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
  /** Whether auto-follow is on. */
  autoFollow: boolean;
  /** When the followed lane last typed a keystroke, finished or got a change, or was followed, in epoch milliseconds. */
  quietSince: number;
  /** The agent type of each agent lane the plugin saw it for, by lane id. */
  kinds: Map<string, string>;
};

/** What the plugin knows of the loop a change came from when it starts a lane: its `Agent` call's description and agent type, and whether it is in a turn. */
export type LaneAbout = { description?: string; subagentType?: string; isRunning?: boolean };

export type PlayOptions = { charsPerMinute: number; naturalOrder: boolean };

export function newDeck(): Deck {
  return { timeline: new Timeline(MAX_WAITING, MAX_WAITING_CHARS), isPaused: false, hold: 0, recorded: 0, autoFollow: true, quietSince: 0, kinds: new Map() };
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
export function isUnchanged(change: NewChange): boolean {
  return !change.isTooLarge && change.before === change.after;
}

/** Longest lane label, in characters, a whitespace run counting as one. */
const MAX_LANE_LABEL = 200;

/**
 * The label of lane `id`: `Main` for the main conversation's; for an agent's,
 * its `Agent` call's description on one line, else its agent type, else
 * `Subagent`.
 */
export function laneLabel(id: string, about?: LaneAbout): string {
  if (id === '') return 'Main';
  const description = oneLine(about?.description ?? '');
  if (description !== '') return cutAt(description, MAX_LANE_LABEL);
  const kind = oneLine(about?.subagentType ?? '');
  return kind !== '' ? cutAt(kind, MAX_LANE_LABEL) : 'Subagent';
}

/** Gives lane `id` its label and color: Main the first color while it is free, any other the color fewest lanes hold, earliest first. */
function defineLane(deck: Deck, id: string, about: LaneAbout | undefined, color?: number): void {
  const taken = deck.timeline.laneList().flatMap((l) => (l.id === id || l.color < 1 ? [] : [l.color]));
  const slot = color ?? colorSlot(id === '' ? 1 : undefined, taken);
  deck.timeline.defineLane({ id, label: laneLabel(id, about), root: '', color: slot, recording: id === '' || about?.isRunning === true });
  const kind = about?.subagentType && oneLine(about.subagentType);
  if (id !== '' && kind) deck.kinds.set(id, kind);
}

/**
 * Adds a recorded change, numbered next in the session and its path named
 * relative to `cwd`, in the lane of the loop that made it, dropping the
 * oldest ones past either limit. A lane with no kept change is started from
 * `about`. Returns false, adding nothing, for an unchanged file. `now`, the
 * time in epoch milliseconds, keeps auto-follow waiting while the followed
 * lane gets changes.
 */
export function enqueue(deck: Deck, change: NewChange, cwd?: string, about?: LaneAbout, now?: number): boolean {
  if (isUnchanged(change)) return false;
  const { timeline } = deck;
  // A restored deck may hold more than the limits allow (see restore); a new change brings it back within them.
  timeline.setLimit(MAX_WAITING);
  timeline.setSizeLimit(MAX_WAITING_CHARS);
  const lane = laneOfChange(change);
  if (!timeline.laneInfo(lane)) defineLane(deck, lane, about);
  // While the followed lane keeps no change, the lane of the next one is followed at once.
  const isEmpty = !deck.playing && timeline.laneEvents().length === 0;
  deck.recorded++;
  timeline.push(eventOf({ ...change, number: deck.recorded }, cwd));
  if (isEmpty && timeline.followed !== lane) timeline.follow(lane);
  if (now !== undefined && timeline.followed === lane) deck.quietSince = now;
  return true;
}

/** Marks lane `agentId` running (its loop is in a turn) or finished. A lane not started yet is left for its first change. */
export function setRunning(deck: Deck, agentId: string, isRunning: boolean): void {
  if (agentId === '' || !deck.timeline.laneInfo(agentId)) return;
  deck.timeline.setLaneRecording(agentId, isRunning);
}

/** The changes waiting to play, oldest first; the one being typed is not among them. */
export function queued(deck: Deck): Change[] {
  const { timeline } = deck;
  return timeline.all().filter((e) => timeline.stateOf(e.seq) === 'pending').map(changeOf);
}

/**
 * Every change the deck keeps, in recorded order, the change being typed
 * first when the timeline has dropped it, since it is then older than every
 * change the timeline keeps.
 */
function keptChanges(deck: Deck): Change[] {
  const { timeline, playing } = deck;
  const outside = playing && !timeline.get(playing.seq) ? [playing.change] : [];
  return [...outside, ...timeline.all().map(changeOf)];
}

/** Whether the kept change `c` has played: the timeline holds it, and its lane has moved past it. */
function isPlayed(deck: Deck, c: Change): boolean {
  const e = eventById(deck, c.id);
  return e !== undefined && deck.timeline.stateOf(e.seq) === 'played';
}

/** The event the timeline keeps for change `id`. */
function eventById(deck: Deck, id: string): Event | undefined {
  return deck.timeline.all().find((x) => (x as Event).id === id) as Event | undefined;
}

/** The captions of the changes the deck keeps, by change id. */
export function captionsOf(deck: Deck): Map<string, string> {
  return new Map(keptChanges(deck).flatMap((c) => (c.caption ? [[c.id, c.caption] as const] : [])));
}

/**
 * Gives the kept change `id` its caption, unless it has one. Returns whether
 * it changed anything.
 */
export function setCaption(deck: Deck, id: string, caption: string): boolean {
  const e = deck.timeline.all().find((x) => (x as Event).id === id) as Event | undefined;
  const p = deck.playing;
  const isPlaying = p?.change.id === id;
  if ((!e && !isPlaying) || (e ?? p!.change).caption) return false;
  if (e) e.caption = caption;
  if (isPlaying) deck.playing = { ...p!, change: { ...p!.change, caption } };
  if (deck.shown?.id === id) deck.shown = { ...deck.shown, caption };
  return true;
}

/**
 * What a reload needs to rebuild the deck, texts aside: every kept change in
 * recorded order, the lanes holding them, how many of each lane's changes have
 * played, the followed lane and the switches. The change being typed is kept
 * even once the timeline has dropped it, as not played.
 */
export function savedOf(deck: Deck): Saved {
  const { timeline } = deck;
  const changes = keptChanges(deck);
  const positions: Record<string, number> = {};
  const lanes: SavedLane[] = [];
  for (const c of changes) {
    const lane = laneOfChange(c);
    if (!(lane in positions)) {
      positions[lane] = 0;
      const info = timeline.laneInfo(lane);
      const kind = deck.kinds.get(lane);
      if (info) lanes.push({ id: lane, label: info.label, color: info.color, ...(kind && { kind }) });
    }
    if (isPlayed(deck, c)) positions[lane]!++;
  }
  return {
    changes: changes.map(
      (c): SavedChange => ({
        id: c.id,
        number: c.number,
        ...(c.tool && { tool: c.tool }),
        path: c.path,
        kind: c.kind,
        time: c.time,
        ...(c.isTooLarge && { isTooLarge: c.isTooLarge }),
        ...linksOf(c),
      }),
    ),
    recorded: deck.recorded,
    isPaused: deck.isPaused,
    lanes,
    positions,
    followed: timeline.followed,
    autoFollow: deck.autoFollow,
  };
}

/**
 * The deck a reload starts from. `changes` are the saved changes whose texts
 * were found, in saved order. Each lane's first `saved.positions` changes stay
 * played; the rest wait, the one that was being typed starting over. Lanes
 * keep their labels and colors; a lane the save does not describe is labeled
 * from `about`, what the plugin knows of its agent, and colored in the order
 * of its first change. Every lane but the main conversation's counts as
 * finished until its loop starts a turn. Paused, the pane shows the followed
 * lane's next change cued, as a pick while paused leaves it; otherwise its
 * last played change done.
 */
export function restore(saved: Saved, changes: Change[], opts: PlayOptions, cwd?: string, about?: (agentId: string) => LaneAbout | undefined): Deck {
  // The change being typed sat outside the limits, so with it the saved changes
  // can be one over them. The timeline holds them all until the next is recorded.
  const chars = changes.reduce((n, c) => n + c.before.length + c.after.length, 0);
  const timeline = new Timeline(Math.max(MAX_WAITING, changes.length), Math.max(MAX_WAITING_CHARS, chars));
  const deck: Deck = { ...newDeck(), timeline, recorded: saved.recorded, isPaused: saved.isPaused, autoFollow: saved.autoFollow };
  const savedLanes = new Map(saved.lanes.map((l) => [l.id, l]));
  // Which changes played: the first `positions[lane]` of each lane's saved changes.
  const wasPlayed = new Set<string>();
  const counted: Record<string, number> = {};
  for (const c of saved.changes) {
    const lane = laneOfChange(c);
    counted[lane] = (counted[lane] ?? 0) + 1;
    if (counted[lane]! <= (saved.positions[lane] ?? 0)) wasPlayed.add(c.id);
  }
  const events = changes.map((c, i) => ({ ...eventOf(c, cwd), seq: i + 1 }));
  // Each lane resumes at its first change not played, or past the end.
  const end = events.length + 1;
  const cursors: Record<string, number> = {};
  for (const e of events) {
    const lane = laneOf(e);
    if (!(lane in cursors)) cursors[lane] = end;
    if (cursors[lane] === end && !wasPlayed.has((e as Event).id)) cursors[lane] = e.seq;
  }
  // Lanes in the order of their first change: those the save describes keep their colors, the rest take the least used.
  const order = [...new Set(events.map(laneOf))];
  const lanes: { id: string; label: string; root: string; color: number }[] = [];
  for (const id of order) {
    const was = savedLanes.get(id);
    const taken = lanes.map((l) => l.color).concat(order.flatMap((o) => (o !== id && savedLanes.has(o) ? [savedLanes.get(o)!.color] : [])));
    const color = was && was.color >= 1 && was.color <= LANE_COLORS ? was.color : colorSlot(id === '' ? 1 : undefined, taken);
    const known = about?.(id);
    lanes.push({ id, label: was?.label ?? laneLabel(id, known), root: '', color });
    const kind = was?.kind ?? (known?.subagentType && oneLine(known.subagentType));
    if (id !== '' && kind) deck.kinds.set(id, kind);
  }
  // The main conversation's lane runs for the whole session.
  const main = lanes.find((l) => l.id === '');
  if (main) timeline.defineLane({ ...main, recording: true });
  timeline.restore(events, end, undefined, { lanes, cursors, followed: saved.followed });
  const next = timeline.peek();
  const last = timeline
    .laneEvents()
    .filter((e) => timeline.stateOf(e.seq) === 'played')
    .at(-1);
  const shown = saved.isPaused && next ? shownBefore(changeOf(next), opts) : last && shownFinished(changeOf(last), opts);
  if (shown) deck.shown = shown;
  return deck;
}

/** The tag `saved` is kept under. savedFrom also reads the tags before it. */
export const SAVED_SHAPE = 'saved-5';

/** `saved` as the `saved-4` and `saved-3` tags kept it: every change in recorded order, and how many of them lead as played, of every lane. */
type SavedV4 = { changes: SavedChange[]; played: number; recorded: number; isPaused: boolean };

/** `saved` as the `saved-2` tag kept it: no change's number or tool. */
type SavedV2 = { changes: Omit<SavedChange, 'number' | 'tool'>[]; played: number; recorded: number; isPaused: boolean };

/** `saved` as the `saved-1` tag kept it: the changes still to play, the one being typed first, without kind or time. */
type SavedV1 = { changes: { id: string; path: string; isTooLarge?: boolean }[]; recorded: number; isPaused: boolean };

/**
 * The Saved a stored `saved` value holds: as stored under SAVED_SHAPE; under
 * `saved-4` and `saved-3`, which kept no lanes, in lanes by each change's
 * agent (`saved-3` kept no links, so all its changes are the main
 * conversation's); under `saved-2`, which kept no numbers or tools, numbered by
 * place; under `saved-1`, which kept neither kind nor time either, every
 * change waiting, each a modify at time 0, numbered by place; under any other
 * tag, or none, nothing. Lanes an earlier tag did not keep are left for
 * restore to label and color, the main conversation's followed when it holds
 * a change, and auto-follow on.
 */
export function savedFrom(stored: { shape: string; value: unknown } | undefined): Saved {
  if (stored?.shape === SAVED_SHAPE) return stored.value as Saved;
  if (stored?.shape === 'saved-4' || stored?.shape === 'saved-3') return laned(stored.value as SavedV4);
  if (stored?.shape === 'saved-2') return laned(numbered(stored.value as SavedV2));
  if (stored?.shape !== 'saved-1') return savedOf(newDeck());
  const was = stored.value as SavedV1;
  return laned(numbered({ ...was, changes: was.changes.map((c) => ({ ...c, kind: 'modify', time: 0 })), played: 0 }));
}

/**
 * `saved` in lanes by each change's agent. Its played changes lead in
 * recorded order, so they lead every lane too: each lane's position counts its
 * changes among them.
 */
function laned(saved: SavedV4): Saved {
  const positions: Record<string, number> = {};
  saved.changes.forEach((c, i) => {
    const lane = laneOfChange(c);
    positions[lane] = (positions[lane] ?? 0) + (i < saved.played ? 1 : 0);
  });
  const lanes = Object.keys(positions);
  const followed = lanes.includes('') ? '' : (lanes[0] ?? '');
  return { changes: saved.changes, recorded: saved.recorded, isPaused: saved.isPaused, lanes: [], positions, followed, autoFollow: true };
}

/**
 * `saved` with its changes numbered by place, the last taking the count of
 * changes recorded and each earlier one the number before. Exact unless a
 * change between two kept ones was dropped or lost its texts.
 */
function numbered(saved: SavedV2): SavedV4 {
  const last = Math.max(saved.recorded, saved.changes.length);
  return { ...saved, changes: saved.changes.map((c, i) => ({ ...c, number: last - (saved.changes.length - 1 - i) })) };
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
    ? { id: change.id, path: change.path, text: '', caret: 0, isTooLarge: true, ...captionOf(change) }
    : { id: change.id, path: change.path, text: change.after, caret, ...captionOf(change) };
}

/** `change` shown done, the caret where typing it ends. */
function shownFinished(change: Change, opts: PlayOptions): Shown {
  return shownDone(change, change.isTooLarge ? 0 : finalCaret(plan(change, opts)));
}

/** `change` shown before it plays: its before text, the caret where typing it starts. A too-large one shows its note. */
function shownBefore(change: Change, opts: PlayOptions): Shown {
  if (change.isTooLarge) return shownDone(change, 0);
  return { id: change.id, path: change.path, text: change.before, caret: caretBefore(plan(change, opts)[0], 0), ...captionOf(change) };
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
  deck.shown = { id: change.id, path: change.path, text: change.before, caret, ...captionOf(change) };
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
    // A long deletion first waits a beat of its own, its lines drawn removed.
    if (isLongDeletion(h) && p.preview === undefined) return { p: { ...p, preview: PREVIEW_TICKS }, used: 0, endsTick: true };
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
    q = { ...q, hunk: q.hunk + 1, deleted: 0, typed: 0, caret: caretBefore(q.hunks[q.hunk + 1], q.caret), preview: undefined };
  }
}

/**
 * Moves playback one tick on. Returns false when nothing moved. `now`, the
 * time in epoch milliseconds, is what auto-follow measures the followed
 * lane's quiet by; without it, auto-follow waits.
 */
export function tick(deck: Deck, opts: PlayOptions, now?: number): boolean {
  if (deck.isPaused) return false;
  if (deck.hold > 0) {
    deck.hold--;
    return true;
  }
  if (!deck.playing) {
    if (startNext(deck, opts)) {
      if (now !== undefined) deck.quietSince = now;
      return true;
    }
    return now !== undefined && autoFollow(deck, opts, now);
  }
  if (now !== undefined) deck.quietSince = now;

  const rate = (opts.charsPerMinute / 60) * (TICK_MS / 1000);
  let budget = deck.playing.credit + rate;
  let p = settle(deck.playing);
  // The beat before a long deletion counts down; on its last tick the deletion lands.
  if (p.preview !== undefined && p.preview > 1) {
    deck.playing = { ...p, preview: p.preview - 1 };
    return true;
  }
  if (p.preview === 1) p = { ...p, preview: 0 };
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
  deck.shown = { id: p.change.id, path: p.change.path, text: p.text, caret: p.caret, ...captionOf(p.change) };
  return true;
}

export function togglePause(deck: Deck): void {
  deck.isPaused = !deck.isPaused;
}

/**
 * Follows another lane when auto-follow is on, the followed lane has nothing
 * queued, nothing is typed, and the lane has been quiet AUTO_FOLLOW_IDLE_MS:
 * the lane whose oldest queued change was recorded first. Returns whether it
 * followed one.
 */
function autoFollow(deck: Deck, opts: PlayOptions, now: number): boolean {
  const { timeline } = deck;
  const lanes = timeline.lanesInBuffer().map((id) => {
    const first = timeline.firstPending(id);
    return { id, recording: timeline.laneInfo(id)?.recording ?? false, lastActivity: 0, ...(first !== undefined && { firstPendingSeq: first }) };
  });
  const decision = autoFollowDecision({ enabled: deck.autoFollow, playing: deck.playing !== undefined, followed: timeline.followed, lanes, quietSince: deck.quietSince, now });
  return decision.follow !== undefined && follow(deck, decision.follow, opts, now);
}

/**
 * Follows lane `lane` (an agent's id, '' for the main conversation's): the
 * change being typed stops and stays queued in its lane, and the lane resumes
 * at its own position. The pane shows the lane's next change cued, or, with
 * nothing queued, its last change done. The pause state stays. Returns false,
 * changing nothing, when the lane is already followed or holds no change.
 */
export function follow(deck: Deck, lane: string, opts: PlayOptions, now?: number): boolean {
  const { timeline } = deck;
  if (lane === timeline.followed || !timeline.lanesInBuffer().includes(lane)) return false;
  timeline.follow(lane);
  deck.playing = undefined;
  deck.hold = 0;
  if (now !== undefined) deck.quietSince = now;
  const next = timeline.peek();
  const last = timeline
    .laneEvents()
    .filter((e) => timeline.stateOf(e.seq) === 'played')
    .at(-1);
  const shown = next ? shownBefore(changeOf(next), opts) : last && shownFinished(changeOf(last), opts);
  if (shown) deck.shown = shown;
  else delete deck.shown;
  return true;
}

/** Turns auto-follow on or off. */
export function toggleAutoFollow(deck: Deck): void {
  deck.autoFollow = !deck.autoFollow;
}

/**
 * Finishes the current change at once: the one being typed, or one cued by a
 * pick while paused. The next one starts on the next tick that is not paused.
 */
export function finish(deck: Deck, opts: PlayOptions): void {
  const p = deck.playing;
  deck.hold = 0;
  if (p) {
    deck.timeline.complete(p.seq, p.token);
    deck.playing = undefined;
    deck.shown = shownDone(p.change, finalCaret(p.hunks));
    return;
  }
  const next = deck.timeline.peek();
  if (!next || (next as Event).id !== deck.shown?.id) return;
  deck.timeline.complete(next.seq);
  deck.shown = shownFinished(changeOf(next), opts);
}

/**
 * Makes the kept change `id` the next one played, as the extension's seek
 * does: its lane is followed, the change being typed stops, the ones recorded
 * after `id` in its lane follow, the ones before it count as played, and the
 * pause state stays. Other lanes keep their positions. The pane shows it cued,
 * as it is before it plays. Picking the change being typed starts it over.
 * Returns false, changing nothing, when the change is no longer kept.
 */
export function seek(deck: Deck, id: string, opts: PlayOptions): boolean {
  const e = eventById(deck, id);
  const p = deck.playing;
  if (!e) {
    // Only the change being typed outlives its place in the timeline; it starts over where it is.
    if (p?.change.id !== id) return false;
    deck.timeline.follow(laneOfChange(p.change));
    deck.playing = { ...p, hunk: 0, deleted: 0, typed: 0, text: p.change.before, caret: caretBefore(p.hunks[0], 0), credit: 0 };
    deck.hold = 0;
    deck.shown = shownBefore(p.change, opts);
    return true;
  }
  deck.timeline.follow(laneOf(e));
  deck.timeline.seek(e.seq);
  deck.playing = undefined;
  deck.hold = 0;
  deck.shown = shownBefore(changeOf(e), opts);
  return true;
}

/**
 * Plays the kept changes `ids` again, in recorded order: every lane holding
 * one of them moves back to its first one there, which waits, and the lane
 * of the first one is followed, as a pick of it does. Lanes holding none of
 * them keep their positions. Returns false when the first is no longer kept.
 */
export function playFrom(deck: Deck, ids: readonly string[], opts: PlayOptions): boolean {
  const first = ids[0];
  if (first === undefined || !changeById(deck, first)) return false;
  const { timeline } = deck;
  const firsts = new Map<string, number>();
  for (const id of ids) {
    const e = eventById(deck, id);
    if (e && !firsts.has(laneOf(e))) firsts.set(laneOf(e), e.seq);
  }
  for (const [lane, seq] of firsts) {
    timeline.follow(lane);
    timeline.seek(seq);
  }
  return seek(deck, first, opts);
}

/** Plays every lane from its first kept change again, following the lane of the first change kept. Returns false when none is kept. */
export function replayFromStart(deck: Deck, opts: PlayOptions): boolean {
  return playFrom(
    deck,
    listingOf(deck).rows.map((r) => r.id),
    opts,
  );
}

/** Finishes every recorded change in every lane at once, keeps the followed lane, and shows its last change. */
export function skipToLatest(deck: Deck, opts: PlayOptions): void {
  const { timeline } = deck;
  if (timeline.pendingTotal() === 0) return finish(deck, opts);
  const followed = timeline.followed;
  for (const lane of timeline.lanesInBuffer()) {
    timeline.follow(lane);
    timeline.seekToEnd();
  }
  timeline.follow(followed);
  // Seeking the followed lane last overtakes the change being typed.
  timeline.seekToEnd();
  deck.playing = undefined;
  deck.hold = 0;
  const last = timeline.laneEvents().at(-1);
  if (last) deck.shown = shownFinished(changeOf(last), opts);
}

function rowOf(e: Event, state: Row['state']): Row {
  const lane = laneOf(e);
  return {
    id: e.id,
    number: e.number,
    ...(e.tool && { tool: e.tool }),
    path: e.path,
    state,
    added: e.linesAdded,
    removed: e.linesRemoved,
    ...(e.isTooLarge && { isTooLarge: true }),
    ...(e.mainTurnId && { mainTurnId: e.mainTurnId }),
    ...(e.agentCallId && { agentCallId: e.agentCallId }),
    ...(e.caption && { caption: cutCaption(e.caption, MAX_ROW_CAPTION) }),
    ...(lane !== '' && { lane }),
  };
}

/** The lanes holding kept changes as the chips show them: Main first, the others by their first kept change. */
function laneChipsOf(deck: Deck, rows: readonly Row[]): LaneChip[] {
  const { timeline } = deck;
  const ids = [...new Set(rows.map((r) => r.lane ?? ''))].sort((x, y) => (x === '' ? -1 : y === '' ? 1 : 0));
  return ids.map((id) => {
    const info = timeline.laneInfo(id);
    const queued = timeline.pendingCount(id);
    const isTyping = id === timeline.followed && deck.playing !== undefined;
    const state = isTyping ? (deck.isPaused ? 'paused' : 'typing') : queued > 0 ? 'queued' : 'caught up';
    return { id, label: info?.label ?? laneLabel(id), color: info?.color ?? 1, state, queued };
  });
}

/**
 * The pane's list: a row per kept change, oldest first, the change being typed
 * included once the timeline has dropped it; how many changes recorded before
 * the oldest kept one are gone; the id of the change the pane shows; whether
 * playback is paused; the lanes holding the changes, the followed one, and
 * whether auto-follow is on.
 */
export function listingOf(deck: Deck): Listing {
  const { timeline, playing } = deck;
  // A change being typed that the timeline dropped is older than every change it keeps.
  const outside = playing && !timeline.get(playing.seq) ? [rowOf({ ...eventOf(playing.change, undefined), seq: playing.seq }, 'playing')] : [];
  const rows = [...outside, ...timeline.all().map((e) => rowOf(e as Event, timeline.stateOf(e.seq)))];
  return {
    rows,
    dropped: Math.max(0, (rows[0]?.number ?? 1) - 1),
    ...(deck.shown && { current: deck.shown.id }),
    isPaused: deck.isPaused,
    lanes: laneChipsOf(deck, rows),
    followed: timeline.followed,
    autoFollow: deck.autoFollow,
  };
}

/** Longest prompt a turn keeps, in characters, its ellipsis included; the pane cuts it again to fit. */
export const MAX_PROMPT = 200;

/**
 * `text` on one line as a header draws it: whitespace runs as single spaces
 * and trimmed, other control characters as visible stand-ins, and cut with `…`
 * to MAX_PROMPT characters.
 */
export function promptOf(text: string): string {
  const line = oneLine(text);
  return line.length > MAX_PROMPT ? cutAt(line, MAX_PROMPT - 1) + '…' : line;
}

/** `text` on one line: whitespace runs as single spaces, trimmed, and other control characters as visible stand-ins. */
function oneLine(text: string): string {
  return showControls(text.replace(/\s+/g, ' ').trim());
}

/** `s` at most `n` code units long, never ending on half a surrogate pair. */
function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A run of the list's rows under one header. `turn` is a main conversation
 * turn the plugin numbered, keyed by its id; `earlier` a turn the plugin knows
 * by id only; `outside` the changes in no known turn, keyed ''. Rows are in
 * recorded order.
 */
export type Chapter = {
  key: string;
  kind: 'turn' | 'earlier' | 'outside';
  number?: number;
  prompt?: string;
  isEnded?: boolean;
  rows: Row[];
};

/**
 * The listing's rows grouped by the main conversation's turn: a chapter per
 * turn some row names, rows in recorded order, chapters in the order of their
 * first row. Rows naming no turn share the `outside` chapter; a turn missing
 * from `turns` makes an `earlier` one.
 */
export function chaptersOf(listing: Listing, turns: readonly TurnInfo[]): Chapter[] {
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const chapters = new Map<string, Chapter>();
  for (const row of listing.rows) {
    const key = row.mainTurnId ?? '';
    let ch = chapters.get(key);
    if (!ch) {
      const t = row.mainTurnId === undefined ? undefined : byId.get(row.mainTurnId);
      if (row.mainTurnId === undefined) ch = { key, kind: 'outside', rows: [] };
      else if (!t) ch = { key, kind: 'earlier', rows: [] };
      else ch = { key, kind: 'turn', number: t.number, prompt: t.prompt, ...(t.isEnded && { isEnded: true }), rows: [] };
      chapters.set(key, ch);
    }
    ch.rows.push(row);
  }
  return [...chapters.values()];
}

/** How many kept changes `n` is, as a header and a chip say it. */
function changeCount(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`;
}

/** A chapter's header as the pane draws it: its title, its prompt cut to fit, its count, and its play button's words. */
export type HeaderLabel = { title: string; prompt: string; count: string; play: string };

/** Columns a header's play button takes beyond its words: its padding and the gap before it. */
const PLAY_PADDING = 3;

/**
 * How the pane draws `ch`'s header in `width` columns, its play button
 * included: `Turn <n>`, `Earlier turn` or `Outside a turn`; the prompt on one
 * line, cut with `…` to the columns the rest leaves, '' when none fits or the
 * turn had none; the count; and the play button's words, Play turn, or Play
 * from first for the changes in no turn.
 */
export function headerLabel(ch: Chapter, width: number): HeaderLabel {
  const title = ch.kind === 'turn' ? `Turn ${ch.number}` : ch.kind === 'earlier' ? 'Earlier turn' : 'Outside a turn';
  const count = changeCount(ch.rows.length);
  const play = ch.kind === 'outside' ? 'Play from first' : 'Play turn';
  const line = oneLine(ch.prompt ?? '');
  // The title, prompt and count are each a gap apart.
  const room = width - title.length - count.length - 2 - play.length - PLAY_PADDING;
  let prompt = line;
  if (line.length > room) prompt = room < 2 ? '' : cutAt(line, room - 1) + '…';
  return { title, prompt, count, play };
}

/** A file's kept changes under one header: the path as its changes recorded it, and its rows in recorded order. */
export type FileGroup = { path: string; rows: Row[] };

/**
 * The file `path` names, as grouping by file tells files apart: a Windows path
 * with either separator and in any letter case, since Windows reads them all
 * as one file; any other path exactly as spelled.
 */
export function fileKey(path: string): string {
  return WINDOWS_PATH.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path;
}

/**
 * The listing's rows grouped by file: a group per file some row names (see
 * fileKey), shown by the path its first row recorded, rows in recorded order,
 * groups in the order of their first row, so the file first changed most
 * recently comes last.
 */
export function fileGroupsOf(listing: Listing): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const row of listing.rows) {
    const key = fileKey(row.path);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { path: row.path, rows: [] }));
    g.rows.push(row);
  }
  return [...groups.values()];
}

/** A file group's header as the pane draws it: the file name, its folder cut to fit, its count, and its play button's words. */
export type FileHeaderLabel = { file: string; dir: string; count: string; play: string };

/**
 * How the pane draws `group`'s header in `width` columns, its path named
 * `name`, its play button included: the file name; its folder with its
 * trailing separator, cut with `…` to the columns the rest leaves, '' when
 * none fits; the count; and Play from first. The folder goes before the file
 * name does, and the count and the button are never cut.
 */
export function fileHeaderLabel(group: FileGroup, name: string, width: number): FileHeaderLabel {
  const count = changeCount(group.rows.length);
  const play = 'Play from first';
  const at = name.search(/[^\\/]*$/);
  let dir = name.slice(0, at);
  let file = name.slice(at);
  // The file name, folder and count are each a gap apart.
  const room = Math.max(1, width - count.length - 2 - play.length - PLAY_PADDING);
  if (file.length + dir.length > room) {
    dir = file.length + 2 <= room ? cutAt(dir, room - file.length - 1) + '…' : '';
    if (file.length > room) file = cutAt(file, Math.max(0, room - 1)) + '…';
  }
  return { file, dir, count, play };
}

/**
 * The call row a turn's Play turn chip sits on: its last kept change's own
 * call, or for an agent's change the `Agent` or `Workflow` call that started
 * its chain, since an agent's own calls are not rows of the conversation.
 */
export function turnChipAnchor(ch: Chapter): string {
  const last = ch.rows.at(-1)!;
  return last.agentCallId ?? last.id;
}

/** The words of a turn's Play turn chip: `Play turn · ` and its kept change count. */
export function turnChipLabel(ch: Chapter): string {
  return `Play turn · ${changeCount(ch.rows.length)}`;
}

/** The ended turns' chapters by the call row their chip sits on. */
export function turnChips(chapters: readonly Chapter[]): Map<string, Chapter> {
  return new Map(chapters.filter((ch) => ch.kind === 'turn' && ch.isEnded).map((ch) => [turnChipAnchor(ch), ch]));
}

/**
 * The turns worth keeping: the running one (the newest, while not ended) and
 * every turn named in `named`, the main turns of kept changes and of agents
 * still known.
 */
export function keptTurns(turns: Turns, named: ReadonlySet<string>): Turns {
  const newest = turns.turns.at(-1);
  return { next: turns.next, turns: turns.turns.filter((t) => named.has(t.turnId) || (t === newest && !t.isEnded)) };
}

/** One line of the pane's changes list: the note on dropped changes, a chapter's header, a file group's header, or a change's row. */
export type ListLine = { kind: 'dropped' } | { kind: 'header'; chapter: Chapter } | { kind: 'file'; group: FileGroup } | { kind: 'row'; row: Row };

/**
 * The list's lines, top to bottom: the dropped note when changes were
 * dropped, then each group's header and rows, the groups being the chapters
 * by turn or the groups by file, as the person chose.
 */
export function listLines(listing: Listing, groups: readonly Chapter[] | readonly FileGroup[]): ListLine[] {
  const lines: ListLine[] = listing.dropped > 0 ? [{ kind: 'dropped' }] : [];
  for (const group of groups) {
    lines.push('path' in group ? { kind: 'file', group } : { kind: 'header', chapter: group });
    for (const row of group.rows) lines.push({ kind: 'row', row });
  }
  return lines;
}

/**
 * The first of the list's `count` lines (the note on dropped changes, chapter
 * headers and rows) a window `height` lines high shows: line `top` when the
 * person has scrolled the list, else the one that puts line `current`, the
 * current row's, a third of the way down. Clamped so the window stays within
 * the lines.
 */
export function listWindow(count: number, current: number | undefined, height: number, top?: number): number {
  const want = top ?? (current === undefined ? 0 : current - Math.floor(height / 3));
  return Math.max(0, Math.min(want, count - height));
}

/** A scroll of the pane as `ui.scroll` reports it: the rows asked for, the body's and the tree's heights, and for a wheel the body row under the pointer. */
export type PaneScroll = { by: number; bodyRows: number; contentRows: number; pointerRow?: number };

/** The changes list as the pane last drew it: its first line shown, the lines it shows and has, and the body row its first line is on. */
export type ListGeometry = { top: number; height: number; count: number; firstRow: number };

/**
 * The list's first line once scroll `s` has moved it, or undefined when the
 * scroll is not the list's: the list fits, or a wheel is over the rows above
 * it. The engine tells the kinds apart as follows: a wheel carries the pointer
 * and moves by its ticks; a page key asks for `bodyRows` and moves by the
 * list's own height; Home and End ask for `contentRows` and go to its ends;
 * an arrow moves a line. When the tree fills the body exactly, Home and End
 * cannot be told from a page and move a page.
 */
export function scrolledTop(s: PaneScroll, list: ListGeometry): number | undefined {
  const last = list.count - list.height;
  if (last <= 0) return undefined;
  const n = Math.abs(s.by);
  let top = list.top + s.by;
  if (s.pointerRow !== undefined) {
    if (s.pointerRow < list.firstRow) return undefined;
  } else if (n >= s.bodyRows) top = list.top + Math.sign(s.by) * list.height;
  else if (n === s.contentRows) top = s.by < 0 ? 0 : last;
  return Math.max(0, Math.min(top, last));
}

/** A row as the pane draws it: the lead, the path's folder and file name, the lane tag, and the tail, together at most the width asked for. */
export type RowLabel = { lead: string; dir: string; file: string; tag: string; tail: string };

/** Most characters of a lane's label a chip shows, its ellipsis included. */
export const MAX_CHIP_LABEL = 24;
/** Most characters of a lane's label a row's tag shows, its ellipsis included. */
export const MAX_TAG_LABEL = 16;
/** Most rows the lane chips and the auto-follow switch take. */
export const CHIP_ROWS = 2;

/** `label` cut with `…` to `max` characters, as it is when it fits. */
function cutLabel(label: string, max: number): string {
  return label.length > max ? cutAt(label, max - 1) + '…' : label;
}

/** The words a lane chip shows after its color: its label cut to MAX_CHIP_LABEL, then its state. */
export function laneChipText(chip: LaneChip): string {
  const queued = chip.queued > 0 ? `${chip.queued} queued` : '';
  const state = chip.state === 'typing' || chip.state === 'paused' ? [chip.state, queued].filter(Boolean).join(' · ') : chip.state === 'queued' ? queued : 'caught up';
  return `${cutLabel(chip.label, MAX_CHIP_LABEL)} · ${state}`;
}

/** The words of a row's lane tag after its color: the lane's label cut to MAX_TAG_LABEL. */
export function laneTagText(label: string): string {
  return cutLabel(label, MAX_TAG_LABEL);
}

/** The words of the auto-follow switch. */
export function autoFollowText(isOn: boolean): string {
  return `Auto-follow: ${isOn ? 'on' : 'off'}`;
}

/**
 * The lane chips laid into at most CHIP_ROWS rows `columns` wide, a column
 * between items, each chip as wide as its color, a space and its words plus
 * `padding`, the auto-follow switch `switchWidth` wide at the end. When they
 * do not fit, the chips of unfollowed lanes with nothing queued go first,
 * earliest first, then other chips but the followed lane's, latest first, and
 * a note of how many went (`+N more`) goes before the switch. Returns each
 * row's chips in the listing's order, and how many were left out.
 */
export function laneChipRows(chips: readonly LaneChip[], followed: string, columns: number, padding: number, switchWidth: number): { rows: LaneChip[][]; left: number } {
  const width = (c: LaneChip) => 2 + cellWidth(laneChipText(c)) + padding;
  const order = chips.map((_, k) => k);
  const isIdle = (k: number) => chips[k]!.id !== followed && chips[k]!.state === 'caught up';
  // Kept first: the followed lane, then the busy ones earliest first, then the idle ones latest first.
  const priority = [
    ...order.filter((k) => chips[k]!.id === followed),
    ...order.filter((k) => chips[k]!.id !== followed && !isIdle(k)),
    ...order.filter(isIdle).reverse(),
  ];
  const layout = (chosen: ReadonlySet<number>) => {
    const left = chips.length - chosen.size;
    const items: { k: number; w: number }[] = order.filter((k) => chosen.has(k)).map((k) => ({ k, w: width(chips[k]!) }));
    if (left > 0) items.push({ k: -1, w: `+${left} more`.length });
    items.push({ k: -2, w: switchWidth });
    const rows: number[][] = [];
    let used = 0;
    for (const { k, w } of items) {
      if (rows.length === 0 || (used > 0 && used + 1 + w > columns)) {
        rows.push([]);
        used = 0;
      }
      rows.at(-1)!.push(k);
      used += (used > 0 ? 1 : 0) + w;
    }
    return { rows: rows.map((r) => r.filter((k) => k >= 0).map((k) => chips[k]!)), count: rows.length, left };
  };
  const chosen = new Set<number>();
  let best = layout(chosen);
  for (const k of priority) {
    chosen.add(k);
    const next = layout(chosen);
    if (next.count > CHIP_ROWS && chosen.size > 1) {
      chosen.delete(k);
      break;
    }
    best = next;
  }
  return { rows: best.rows, left: best.left };
}

/**
 * How the pane draws `row`, its path named `name`, in `width` columns. The
 * lead is a glyph (✓ played, ▸ typing, paused or next, ○ queued, ⊘ a
 * too-large change played), the number and the tool. The tail is the state
 * word, on the current row and on a too-large change passed, and the lines
 * added and removed. A too-large current row reads Too large whether it is
 * shown or cued, since the pane shows its note either way. `tag`, a lane
 * tag's words, takes its columns too. The folder is cut before the file name,
 * each at its end.
 */
export function rowLabel(row: Row, name: string, at: { isCurrent: boolean; isPaused: boolean }, width: number, tag = ''): RowLabel {
  const tooLargePlayed = row.isTooLarge && row.state === 'played';
  const glyph = row.state === 'played' ? (tooLargePlayed ? '⊘' : '✓') : row.state === 'playing' || at.isCurrent ? '▸' : '○';
  let word = '';
  if (at.isCurrent && row.isTooLarge) word = 'Too large';
  else if (at.isCurrent && row.state === 'playing') word = at.isPaused ? 'Paused' : 'Typing';
  else if (at.isCurrent && row.state === 'pending') word = 'Next';
  else if (tooLargePlayed) word = 'Not typed';
  const delta = row.isTooLarge ? '' : [row.added > 0 && `+${row.added}`, row.removed > 0 && `−${row.removed}`].filter(Boolean).join(' ');
  const lead = [glyph, `#${row.number}`, row.tool].filter(Boolean).join(' ') + ' ';
  const tail = [word, delta].filter(Boolean).join(' ');
  const cut = name.search(/[^\\/]*$/);
  let dir = name.slice(0, cut);
  let file = name.slice(cut);
  // A tag is two spaces, its color, a space and its words.
  const tagWidth = tag ? cellWidth(tag) + 4 : 0;
  const room = Math.max(1, width - lead.length - tagWidth - (tail ? tail.length + 1 : 0));
  if (dir.length + file.length > room) {
    dir = file.length + 2 <= room ? dir.slice(0, room - file.length - 1) + '…' : '';
    if (file.length > room) file = file.slice(0, Math.max(0, room - 1)) + '…';
  }
  return { lead, dir, file, tag, tail: tail ? ' ' + tail : '' };
}

/**
 * The words a chip on a change's call row in the conversation shows: its
 * state, then `#<number>`. The state follows rowLabel's: Too large for the
 * current too-large change, Typing or Paused for the one being typed, Next
 * for one cued, Not typed for a too-large one passed, Replay for one played,
 * and Queued for one waiting.
 */
export function chipLabel(row: Row, at: { isCurrent: boolean; isPaused: boolean }): string {
  let word: string;
  if (at.isCurrent && row.isTooLarge) word = 'Too large';
  else if (row.state === 'playing') word = at.isPaused ? 'Paused' : 'Typing';
  else if (at.isCurrent && row.state === 'pending') word = 'Next';
  else if (row.state === 'played') word = row.isTooLarge ? 'Not typed' : 'Replay';
  else word = 'Queued';
  return `${word} #${row.number}`;
}

/** The kept change `id`: one the timeline holds, or the change being typed once it has dropped it. */
export function changeById(deck: Deck, id: string): Change | undefined {
  const e = deck.timeline.all().find((x) => (x as Event).id === id);
  if (e) return changeOf(e);
  return deck.playing?.change.id === id ? deck.playing.change : undefined;
}

/**
 * The conversation rows Show in conversation tries for `change`, in order: the
 * call that made it, then, for an agent's change, the `Agent` call that
 * started the agent.
 */
export function scrollTargets(change: { id: string } & CallLinks): string[] {
  return change.agentCallId && change.agentCallId !== change.id ? [change.id, change.agentCallId] : [change.id];
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

/** The lane a clear belongs to: the lane followed when it was made. */
function laneOfClear(c: Clear): string {
  return c.lane ?? '';
}

/** The recording number of lane `lane`'s first change not played yet, or the next number to record when none waits. */
function nextNumber(deck: Deck, lane: string): number {
  const seq = deck.timeline.firstPending(lane);
  const next = seq === undefined ? undefined : (deck.timeline.get(seq) as Event | undefined);
  return next ? next.number : deck.recorded + 1;
}

/**
 * The recording number of the followed lane's first change not played yet,
 * the change being typed counting as played: where a press of Clear marks now
 * takes effect.
 */
export function clearPoint(deck: Deck): number {
  if (deck.playing) return deck.playing.change.number + 1;
  return nextNumber(deck, deck.timeline.followed);
}

/** `clears` with a press of Clear marks now added for the followed lane, the oldest dropped past MAX_CLEARS. */
export function clearMarks(deck: Deck, clears: readonly Clear[]): Clear[] {
  const lane = deck.timeline.followed;
  return [...clears, { at: clearPoint(deck), ...(lane !== '' && { lane }) }].slice(-MAX_CLEARS);
}

/**
 * `clears` without those a move of playback undid: every clear made after the
 * change its lane now starts from (the change being typed, or the lane's next
 * one to play) was next.
 */
export function pruneClears(deck: Deck, clears: readonly Clear[]): Clear[] {
  const p = deck.playing;
  return clears.filter((c) => {
    const lane = laneOfClear(c);
    const next = p && laneOfChange(p.change) === lane ? p.change.number : nextNumber(deck, lane);
    return c.at <= next;
  });
}

/** Whether `path` is the file of the change being typed while a clear made during it holds that file's marks back. */
function isHeldBack(deck: Deck, path: string, clears: readonly Clear[]): boolean {
  const p = deck.playing;
  return p !== undefined && fileKey(p.change.path) === fileKey(path) && clears.some((c) => c.at === p.change.number + 1 && laneOfClear(c) === laneOfChange(p.change));
}

/**
 * The baseline of the file at `path`, as the extension's baselines() finds it:
 * the before text of the followed lane's first kept change to it, made over by
 * each of the lane's clears that has taken effect into the file's text then.
 * Only played changes count; a too-large one leaves no text, so the next
 * change starts the file afresh. Undefined when no played change names the
 * file.
 */
function playedBaseline(deck: Deck, path: string, clears: readonly Clear[]): string | undefined {
  const lane = deck.timeline.followed;
  const sorted = clears.filter((c) => laneOfClear(c) === lane).sort((x, y) => x.at - y.at);
  const base = new Map<string, string>();
  const text = new Map<string, string>();
  let k = 0;
  const apply = (upTo: number) => {
    for (; k < sorted.length && sorted[k]!.at <= upTo; k++) for (const [p, t] of text) base.set(p, t);
  };
  const { timeline, playing } = deck;
  // A change being typed that the timeline dropped is older than every change it keeps.
  let stop = playing && !timeline.get(playing.seq) ? playing.change.number : Infinity;
  for (const e of timeline.laneEvents(lane) as Event[]) {
    if (e.number >= stop) break;
    if (timeline.stateOf(e.seq) !== 'played') {
      stop = e.number;
      break;
    }
    apply(e.number);
    const p = fileKey(e.path);
    if (e.isTooLarge) {
      base.delete(p);
      text.delete(p);
      continue;
    }
    if (!base.has(p)) base.set(p, e.before);
    text.set(p, e.after);
  }
  // A clear made while a change is typed takes effect for every other file at once; isHeldBack keeps that change's own file unmarked.
  apply(playing && stop === playing.change.number ? stop + 1 : stop);
  return base.get(fileKey(path));
}

/**
 * The file tabs: one per file the followed lane has played a change to or the
 * pane shows, in the order of its first such change, each with the number and
 * id of the latest.
 */
export function tabsOf(deck: Deck): (Tab & { id: string })[] {
  const tabs = new Map<string, Tab & { id: string }>();
  const shown = deck.shown?.id;
  const lane = deck.timeline.followed;
  for (const c of keptChanges(deck)) {
    if (c.id !== shown && (laneOfChange(c) !== lane || !isPlayed(deck, c))) continue;
    const key = fileKey(c.path);
    const was = tabs.get(key);
    tabs.set(key, { path: was?.path ?? c.path, last: c.number, id: c.id });
  }
  return [...tabs.values()];
}

/** Where typing each change kept ends, by its id, so a pinned tab need not plan its change again on every tick. */
const typedTo = new Map<string, number>();

function caretAfter(change: Change, opts: PlayOptions): number {
  let at = typedTo.get(change.id);
  if (at === undefined) {
    at = finalCaret(plan(change, opts));
    if (typedTo.size >= 2 * MAX_WAITING) typedTo.clear();
    typedTo.set(change.id, at);
  }
  return at;
}

/** What viewOf needs beyond the deck: the clears in effect, the pinned file, and how changes are planned. */
export type ViewOptions = { clears?: readonly Clear[]; pin?: string; opts?: PlayOptions };

/**
 * What the pane draws for `deck`: status, and a window of the code view's
 * diff rows around the caret, of the file playback shows or of the pinned
 * file. Rows are whole lines; during the beat before a long deletion lands,
 * the lines it removes are drawn removed.
 */
export function viewOf(deck: Deck, o: ViewOptions = {}): View {
  const clears = o.clears ?? [];
  const status = deck.isPaused ? 'paused' : deck.playing ? 'typing' : 'idle';
  const s = deck.shown;
  const { timeline } = deck;
  const queued = timeline.pendingCount();
  const info = timeline.lanesInBuffer().length > 1 ? timeline.laneInfo(timeline.followed) : undefined;
  const kind = deck.kinds.get(timeline.followed);
  const lane = info && { lane: { label: info.label, ...(kind && { kind }), color: info.color } };
  const base = { status, queued, otherQueued: timeline.pendingTotal() - queued, isTyping: deck.playing !== undefined, ...(s && captionOf(s)), ...lane } as const;
  const empty = { rows: [], oldBefore: 0, newBefore: 0, firstColumn: 0, caretRow: 0, caretLine: 0, caretColumn: 0 };
  if (!s) return { ...base, ...empty };
  const at = s.isTooLarge ? { path: s.path, isTooLarge: true as const } : { path: s.path };

  const tab = o.pin !== undefined && fileKey(o.pin) !== fileKey(s.path) ? tabsOf(deck).find((x) => fileKey(x.path) === fileKey(o.pin!)) : undefined;
  const pinned = tab && changeById(deck, tab.id);
  if (pinned) {
    if (pinned.isTooLarge) return { ...base, ...empty, ...at, isTyping: false, pinned: { path: pinned.path, isTooLarge: true } };
    const baseline = playedBaseline(deck, pinned.path, clears) ?? pinned.after;
    const caret = o.opts ? caretAfter(pinned, o.opts) : pinned.after.length;
    return { ...base, ...at, isTyping: false, pinned: { path: pinned.path }, ...windowOf(diffRows(baseline, pinned.after), pinned.after, caret) };
  }
  if (s.isTooLarge) return { ...base, ...empty, ...at };

  // Only a held-back file draws its text against itself: a second diffRows call would evict the one-entry memo every flush.
  let rows: DiffRow[];
  if (isHeldBack(deck, s.path, clears)) rows = diffRows(s.text, s.text);
  else {
    const before = changeById(deck, s.id)?.before ?? s.text;
    rows = diffRows(playedBaseline(deck, s.path, clears) ?? before, s.text);
    const p = deck.playing;
    const h = p && p.change.id === s.id && p.preview !== undefined && p.preview > 0 ? p.hunks[p.hunk] : undefined;
    if (p && h) {
      // The lines the pending deletion takes, drawn removed until it lands.
      const starts = lineStarts(s.text);
      const from = lineAt(starts, h.offset);
      const to = lineAt(starts, h.offset + h.deleteText.length - p.deleted - 1);
      rows = rows.map((r) => (r.kind !== '-' && r.cur !== undefined && r.cur >= from && r.cur <= to ? { ...r, kind: '-' } : r));
    }
  }
  return { ...base, ...at, ...windowOf(rows, s.text, s.caret) };
}

/** The rows around the caret at offset `caret` of `text`, each a marker then its line cut to the window's columns, made safe to draw. */
function windowOf(all: readonly DiffRow[], text: string, caret: number): Pick<View, 'rows' | 'oldBefore' | 'newBefore' | 'firstColumn' | 'caretRow' | 'caretLine' | 'caretColumn'> {
  const at = Math.max(0, Math.min(caret, text.length));
  const starts = lineStarts(text);
  const caretLine = lineAt(starts, at);
  const caretColumn = at - starts[caretLine]!;
  const index = Math.max(0, all.findIndex((r) => r.cur === caretLine));
  const first = Math.max(0, index - VIEW_LINES / 2);
  const firstColumn = caretColumn < VIEW_COLUMNS - 100 ? 0 : caretColumn - VIEW_COLUMNS / 2;
  let oldBefore = 0;
  let newBefore = 0;
  for (let i = 0; i < first; i++) {
    // By kind alone, as frame() counts the rows it keeps.
    if (all[i]!.kind !== '+') oldBefore++;
    if (all[i]!.kind !== '-') newBefore++;
  }
  const rows = all.slice(first, first + VIEW_LINES).map((r) => r.kind + showControls(cutColumns(r.text, firstColumn, VIEW_COLUMNS)));
  return { rows, oldBefore, newBefore, firstColumn, caretRow: index - first, caretLine, caretColumn };
}

/**
 * The code view's rows that fit a pane `rows` high, the hunk header among
 * them, and `columns` wide: shifted left when the caret would be past the
 * right edge and cut at it, with the caret marked while typing. Returns the
 * source to draw under the Code element's `diff` format, one hunk whose
 * header counts the rows it keeps.
 */
export function frame(view: View, rows: number, columns: number): { source: string } {
  const body = Math.max(1, rows - 1);
  const top = Math.max(0, Math.min(view.caretRow - Math.floor(body / 2), view.rows.length - body));
  const caretX = view.caretColumn - view.firstColumn;
  const shift = caretX < columns - 2 ? 0 : caretX - columns + Math.ceil(columns / 3);
  let oldStart = view.oldBefore;
  let newStart = view.newBefore;
  for (const r of view.rows.slice(0, top)) {
    if (r[0] !== '+') oldStart++;
    if (r[0] !== '-') newStart++;
  }
  let oldCount = 0;
  let newCount = 0;
  const out = view.rows.slice(top, top + body).map((row, i) => {
    const kind = row[0]!;
    if (kind !== '+') oldCount++;
    if (kind !== '-') newCount++;
    const shown = cutColumns(row.slice(1), shift, columns);
    if (!view.isTyping || top + i !== view.caretRow) return kind + shown;
    return kind + shown.slice(0, caretX - shift) + '▍' + shown.slice(caretX - shift);
  });
  // A side with no lines in the hunk is numbered by the line before it, as unified diffs do.
  const header = `@@ -${oldCount > 0 ? oldStart + 1 : oldStart},${oldCount} +${newCount > 0 ? newStart + 1 : newStart},${newCount} @@`;
  return { source: [header, ...out].join('\n') };
}

/** Longest caption a change keeps, in code units, its ellipsis included. */
export const MAX_CAPTION = 1000;
/** Longest caption a row of the list carries, in code units, its ellipsis included: enough for the hover card's lines. */
export const MAX_ROW_CAPTION = 300;

/** `text` cut with `…` to `max` code units, as it is when it fits. */
function cutCaption(text: string, max: number): string {
  return text.length > max ? cutAt(text, max - 1) + '…' : text;
}

/**
 * `text` as a caption keeps it: whitespace runs and line breaks as single
 * spaces, trimmed, other control characters as visible stand-ins, and cut with
 * `…` to MAX_CAPTION code units; undefined when nothing is left.
 */
export function normalizeCaption(text: string): string | undefined {
  const line = oneLine(text);
  return line === '' ? undefined : cutCaption(line, MAX_CAPTION);
}

/** One block of a conversation row, as `session.append` hands it. */
export type RowBlock = { type: string; [field: string]: unknown };

/** One row a loop keeps: the door it came in by, the loop (an agent's id, absent for main), and its blocks. */
export type HeardRow = { door: string; agentId?: string; content: readonly RowBlock[] };

/**
 * Where each loop's current response stands, by loop key (an agent's id, ''
 * for main): the text written since its last call, and the caption of that
 * call while no text has followed it.
 */
export type Narration = Map<string, { text: string[]; last?: string; wasCall: boolean }>;

/** The file tools whose calls get a caption. */
const CAPTIONED: ReadonlySet<string> = new Set<Tool>(['Edit', 'Write']);

/**
 * Feeds one row a loop kept to the tracker. Returns the captions it settles,
 * by `tool_use_id`, for each `Edit` or `Write` call in the row that has one.
 *
 * In a response row, a text block that is not blank adds to the text since the
 * last call; a call takes that text, joined by spaces, as its caption, or,
 * with no text since, the caption of the call just before it; thinking and
 * other blocks are skipped. A row of any other door ends the response, so its
 * text never reaches a later one; a `queue` row is no row of the conversation
 * and changes nothing.
 */
export function narrate(narration: Narration, row: HeardRow): Map<string, string> {
  const answers = new Map<string, string>();
  const loop = row.agentId ?? '';
  if (row.door === 'queue') return answers;
  if (row.door !== 'response') {
    narration.delete(loop);
    return answers;
  }
  let at = narration.get(loop);
  if (!at) narration.set(loop, (at = { text: [], wasCall: false }));
  for (const block of row.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      at.text.push(block.text);
      at.wasCall = false;
      at.last = undefined;
    } else if (block.type === 'tool_use') {
      const caption = at.text.length > 0 ? normalizeCaption(at.text.join(' ')) : at.wasCall ? at.last : undefined;
      if (caption !== undefined && typeof block.id === 'string' && typeof block.name === 'string' && CAPTIONED.has(block.name)) {
        answers.set(block.id, caption);
      }
      at.text = [];
      at.last = caption;
      at.wasCall = true;
    }
  }
  return answers;
}

/** Forgets the loop `agentId` (absent for main), as its turn ends. */
export function forgetLoop(narration: Narration, agentId: string | undefined): void {
  narration.delete(agentId ?? '');
}

// Code points a terminal draws two cells wide: East Asian wide and fullwidth
// characters, and emoji. The ranges lean wide (whole symbol and emoji blocks)
// since counting a cell too many only cuts a caption early, while counting one
// too few draws it on a row the pane did not allow for.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2600, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

function cellsOf(ch: string): number {
  const c = ch.codePointAt(0)!;
  return WIDE.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1;
}

/** The terminal cells `s` takes: two for each wide character, one for any other code point. */
export function cellWidth(s: string): number {
  let width = 0;
  for (const ch of s) width += cellsOf(ch);
  return width;
}

/** The longest start of `s` that fits `cells` terminal cells, never splitting a code point. */
function cutCells(s: string, cells: number): string {
  let width = 0;
  let end = 0;
  for (const ch of s) {
    width += cellsOf(ch);
    if (width > cells) break;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * `text` wrapped at spaces into lines of at most `columns` terminal cells
 * (cellWidth), a word longer than a line broken across lines, and at most
 * `maxLines` of them: when the text needs more, the last line holds what is
 * left, cut with `…`.
 */
export function captionLines(text: string, columns: number, maxLines: number): string[] {
  const width = Math.max(2, columns);
  const lines: string[] = [];
  let rest = text.trim();
  while (rest !== '' && lines.length < maxLines) {
    const fits = cutCells(rest, width);
    if (fits.length === rest.length) {
      lines.push(rest);
      break;
    }
    if (lines.length === maxLines - 1) {
      lines.push(cutCells(rest, width - 1).trimEnd() + '…');
      break;
    }
    // Break at the last space that fits, or inside a word longer than a line.
    const space = rest[fits.length] === ' ' ? fits.length : fits.lastIndexOf(' ');
    const line = space > 0 ? rest.slice(0, space) : fits;
    lines.push(line.trimEnd());
    rest = rest.slice(line.length).trimStart();
  }
  return lines;
}
