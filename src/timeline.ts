import { rebind, textChars } from './changeText';
import type { HighlightClear, HighlightClears } from './highlights';

export type ChangeKind = 'create' | 'modify' | 'delete' | 'rename';

export interface ChangeEvent {
  /** Monotonic sequence number, unique for the life of the timeline. */
  seq: number;
  /** URI string of the real file. */
  uri: string;
  /** Workspace-relative path, forward slashes. Also the mirror document's path. */
  relPath: string;
  /** A rename's old URI and path; set exactly when kind is 'rename'. */
  fromUri?: string;
  fromRelPath?: string;
  /** Epoch millis when the change was recorded. */
  time: number;
  kind: ChangeKind;
  /**
   * LF-normalized text; see eol for the real file's line ending. In the
   * timeline these read through the change's text holder (see changeText.ts).
   */
  before: string;
  after: string;
  /** The real file's line ending when this change was recorded. */
  eol: '\n' | '\r\n';
  linesAdded: number;
  linesRemoved: number;
  /** The lane (recorded checkout) it belongs to; absent for the default lane ''. */
  lane?: string;
}

export type NewChangeEvent = Omit<ChangeEvent, 'seq'>;

/** A recorded checkout whose changes queue and play separately from other lanes'. */
export interface LaneInfo {
  /** Opaque and stable for the checkout; '' is the default lane of changes recorded or saved without one. */
  id: string;
  /** Branch, short commit or folder name, as shown to the user. */
  label: string;
  /** Directory recorded, for display. */
  root: string;
  /** Color slot, 1 to LANE_COLORS. */
  color: number;
  /** Still recording, as opposed to stopped with its changes kept. */
  recording: boolean;
  /** Epoch millis when it started recording. */
  since?: number;
}

/** What a saved session keeps about each lane. */
export type SavedLane = Omit<LaneInfo, 'recording' | 'since'>;

/** Lanes, a cursor per lane and the followed lane, as restore takes them. */
export interface LaneRestore {
  lanes?: readonly SavedLane[];
  /** Per lane id, a cursor seq from the same save as the events. */
  cursors?: Readonly<Record<string, number>>;
  followed?: string;
}

/** The lane an event or clear belongs to. */
export function laneOf(x: { lane?: string }): string {
  return x.lane ?? '';
}

type Listener = () => void;

/**
 * Ordered buffer of every recorded change, plus a playback cursor per lane.
 *
 * Recording and playback are decoupled: the recorder appends at the end
 * whenever a file changes, and the player consumes from the cursor at human
 * speed. Because each event carries its own before/after snapshot, an agent
 * that edits A, then B, then A again replays exactly in that order even when
 * playback is minutes behind, and any earlier point can be replayed again.
 *
 * Each change belongs to a lane, one per recorded checkout. Lanes share the
 * buffer and its seqs, but each keeps its own cursor, and only the followed
 * lane is played: the single-cursor API (peek, seek, cursor, pendingCount...)
 * acts on it.
 */
export class Timeline {
  private events: ChangeEvent[] = [];
  private nextSeq = 1;
  /** Per lane, seq of the next event to play. Anything of that lane below it has been played (or skipped). */
  private cursors = new Map<string, number>();
  private laneInfos = new Map<string, LaneInfo>();
  private followedLane = '';
  /** Seq currently being typed, if any. */
  private playingSeq: number | undefined;
  /** Bumped on every cursor jump so an in-flight playback can tell it was overtaken. */
  private generation = 0;
  private listeners = new Set<Listener>();
  /** Count of unplayed events dropped because the buffer overflowed. */
  droppedUnplayed = 0;
  /** Every Clear Highlights still in effect, oldest first. A later clear never replaces an earlier one, so undoing it brings the earlier back. */
  private clears: HighlightClear[] = [];
  /** Characters of before and after text in the buffer. */
  private chars = 0;

  /** At most `limit` changes and `maxChars` characters of their text; the newest change is always kept. */
  constructor(
    private limit: number,
    private maxChars = Infinity,
  ) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.trim();
    this.emit();
  }

  setSizeLimit(maxChars: number): void {
    this.maxChars = Math.max(1, Math.floor(maxChars));
    this.trim();
    this.emit();
  }

  /** Characters of before and after text in the buffer. */
  get textChars(): number {
    return this.chars;
  }

  push(e: NewChangeEvent): ChangeEvent {
    // The text the recorder captured, kept as it is now.
    const event = rebind(e as ChangeEvent, { seq: this.nextSeq++ });
    if (event.lane === '') delete event.lane;
    const lane = laneOf(event);
    if (!this.cursors.has(lane)) this.cursors.set(lane, event.seq);
    if (!this.hasLane(this.followedLane)) this.followedLane = lane;
    // A followed lane that is not recording and has been played out gives way to new changes.
    else if (lane !== this.followedLane && this.playedOut()) this.followedLane = lane;
    this.events.push(event);
    this.chars += textChars(event);
    this.trim();
    this.emit();
    return event;
  }

  // ------------------------------------------------------------- lanes

  /** Registers a lane, or updates what is known about it. */
  defineLane(info: LaneInfo): void {
    this.laneInfos.set(info.id, { ...info });
    if (!this.hasLane(this.followedLane)) this.followedLane = info.id;
    this.emit();
  }

  /** Marks a lane as recording or stopped. A stopped lane keeps its changes until they are trimmed or cleared. */
  setLaneRecording(id: string, recording: boolean): void {
    const info = this.laneInfos.get(id);
    if (!info || info.recording === recording) return;
    this.laneInfos.set(id, { ...info, recording, ...(recording && { since: Date.now() }) });
    this.dropEmptyLanes();
    this.giveWay();
    this.emit();
  }

  laneInfo(id: string): LaneInfo | undefined {
    const info = this.laneInfos.get(id);
    return info && { ...info };
  }

  /**
   * Every lane that is recording or has changes in the buffer: registered
   * ones in the order they were registered, then any others (such as the
   * default lane '') with a placeholder.
   */
  laneList(): LaneInfo[] {
    const withEvents = new Set(this.events.map(laneOf));
    const out: LaneInfo[] = [];
    for (const info of this.laneInfos.values()) if (info.recording || withEvents.has(info.id)) out.push({ ...info });
    for (const id of withEvents) if (!this.laneInfos.has(id)) out.push({ id, label: '', root: '', color: 0, recording: false });
    return out;
  }

  /** Lane ids that have changes in the buffer. */
  lanesInBuffer(): string[] {
    return [...new Set(this.events.map(laneOf))];
  }

  get followed(): string {
    return this.followedLane;
  }

  /**
   * Plays `lane` from its own cursor from now on. The change being typed is
   * overtaken, as by a seek, and stays pending in its lane.
   */
  follow(lane: string): void {
    if (lane === this.followedLane) return;
    this.followedLane = lane;
    this.generation++;
    this.playingSeq = undefined;
    this.emit();
  }

  /** The lane's changes in the buffer, oldest first. */
  laneEvents(lane = this.followedLane): ChangeEvent[] {
    return this.events.filter((e) => laneOf(e) === lane);
  }

  cursorOf(lane: string): number {
    return this.cursors.get(lane) ?? this.nextSeq;
  }

  private hasLane(lane: string): boolean {
    return this.laneInfos.has(lane) || this.events.some((e) => laneOf(e) === lane);
  }

  /** The followed lane is not recording, has nothing queued, and nothing is being typed. */
  private playedOut(): boolean {
    return this.playingSeq === undefined && !this.laneInfos.get(this.followedLane)?.recording && this.pendingCount() === 0;
  }

  /**
   * A played-out followed lane that is not recording gives way to the
   * recording lane whose oldest queued change came first, so live changes
   * already queued play on without waiting for the next one.
   */
  private giveWay(): void {
    if (!this.playedOut()) return;
    const next = this.oldestQueued((id) => this.laneInfos.get(id)?.recording === true);
    if (next !== undefined) this.followedLane = next;
  }

  /** Among lanes other than the followed one that pass `keep`, the one whose oldest queued change came first. */
  private oldestQueued(keep: (id: string) => boolean = () => true): string | undefined {
    let best: string | undefined;
    let bestSeq = Infinity;
    for (const lane of new Set([...this.lanesInBuffer(), ...this.laneInfos.keys()])) {
      if (lane === this.followedLane || !keep(lane)) continue;
      const first = this.firstPending(lane);
      if (first !== undefined && first < bestSeq) {
        best = lane;
        bestSeq = first;
      }
    }
    return best;
  }

  /** Forgets lanes with no changes left that are not recording, and follows another lane if the followed one went. */
  private dropEmptyLanes(): void {
    const withEvents = new Set(this.events.map(laneOf));
    for (const [id, info] of this.laneInfos) if (!info.recording && !withEvents.has(id)) this.laneInfos.delete(id);
    for (const id of this.cursors.keys()) if (!withEvents.has(id) && !this.laneInfos.has(id)) this.cursors.delete(id);
    if (!this.hasLane(this.followedLane)) {
      // A lane with changes queued, else the first one left.
      const next = this.oldestQueued() ?? this.laneList()[0]?.id;
      if (next !== undefined && next !== this.followedLane) {
        this.followedLane = next;
        this.generation++;
        this.playingSeq = undefined;
      }
    }
  }

  // ----------------------------------------------------------- playback

  /** The next event of the followed lane to play, without consuming it. */
  peek(): ChangeEvent | undefined {
    const lane = this.followedLane;
    const first = this.events[0]?.seq;
    if (first === undefined) return undefined;
    for (let i = Math.max(0, this.cursorOf(lane) - first); i < this.events.length; i++) {
      if (laneOf(this.events[i]) === lane) return this.events[i];
    }
    return undefined;
  }

  /**
   * Marks `seq` as the one being typed. Returns a token for `complete`; if the
   * cursor is moved (seek, skip, clear, follow) while the event is playing,
   * completing with a stale token leaves the new cursor alone.
   */
  begin(seq: number): number {
    this.playingSeq = seq;
    this.emit();
    return this.generation;
  }

  /** Marks the event done and, unless a seek happened meanwhile, moves its lane past it. */
  complete(seq: number, token?: number): void {
    if (this.playingSeq === seq) this.playingSeq = undefined;
    const stale = token !== undefined && token !== this.generation;
    const event = this.get(seq);
    const lane = event ? laneOf(event) : this.followedLane;
    if (!stale && this.cursorOf(lane) <= seq) this.cursors.set(lane, seq + 1);
    // An overtaken change (a follow or seek moved on) hands nothing over: the user just chose where to be.
    if (!stale) this.giveWay();
    this.emit();
  }

  /**
   * Moves the followed lane's cursor so playback resumes at `seq` (earlier =
   * replay, later = skip). The change being typed is overtaken, so it stops
   * counting as playing.
   */
  seek(seq: number): void {
    const first = this.events[0]?.seq ?? this.nextSeq;
    const cursor = Math.min(Math.max(seq, first), this.nextSeq);
    this.cursors.set(this.followedLane, cursor);
    this.generation++;
    this.playingSeq = undefined;
    this.dropClearsAfter(cursor);
    this.emit();
  }

  /** Skip everything queued in the followed lane: its cursor jumps past the newest event. */
  seekToEnd(): void {
    this.cursors.set(this.followedLane, this.nextSeq);
    this.generation++;
    this.playingSeq = undefined;
    this.emit();
  }

  seekToStart(): void {
    this.seek(this.events.find((e) => laneOf(e) === this.followedLane)?.seq ?? this.nextSeq);
  }

  clear(): void {
    this.events = [];
    this.chars = 0;
    this.cursors.clear();
    this.generation++;
    this.playingSeq = undefined;
    this.droppedUnplayed = 0;
    this.clears = [];
    this.dropEmptyLanes();
    this.emit();
  }

  /**
   * Clears highlights for every file, or for `relPath`: the text at the cursor
   * becomes the baseline. A clear for every file applies to every lane, each
   * at its own cursor. While a change is typed, that change counts as part of
   * the baseline; when it renames `relPath`, the clear follows the file to its
   * new path.
   */
  clearHighlights(relPath?: string): void {
    const playing = this.playingSeq !== undefined ? this.get(this.playingSeq) : undefined;
    const at = (lane: string) => (playing && laneOf(playing) === lane ? playing.seq + 1 : this.cursorOf(lane));
    const add = (c: HighlightClear) => {
      // Pressing it again at the same point changes nothing.
      if (this.clears.some((o) => o.seq === c.seq && o.relPath === c.relPath && laneOf(o) === laneOf(c))) return;
      this.clears.push(c);
    };
    if (relPath === undefined) {
      const lanes = this.lanesInBuffer();
      for (const lane of lanes.length > 0 ? lanes : [this.followedLane]) add({ seq: at(lane), ...(lane !== '' && { lane }) });
    } else {
      const owner = [...this.events].reverse().find((e) => e.relPath === relPath || e.fromRelPath === relPath);
      const lane = owner ? laneOf(owner) : this.followedLane;
      const path = playing?.fromRelPath === relPath && laneOf(playing) === lane ? playing.relPath : relPath;
      add({ seq: at(lane), relPath: path, ...(lane !== '' && { lane }) });
    }
    this.emit();
  }

  get highlightClears(): HighlightClears {
    return this.clears.map((c) => ({ ...c }));
  }

  /**
   * Replaces the buffer with saved events, oldest first. They get fresh seqs
   * so seqs stay unique for the life of the timeline; `cursor` (a seq from the
   * same save) maps by position for every lane without its own entry in
   * `saved.cursors`, so played events stay played, and so do highlight
   * `clears`. A clear at or before the first kept event changes nothing, so it
   * is dropped. One made while the saved cursor's change was typed sits just
   * past the cursor and is kept. The current limits apply, newest kept.
   * Lanes still recording keep their place; saved lanes are added as stopped.
   * Each change keeps its text holder, so saved text is not read.
   */
  restore(events: readonly ChangeEvent[], cursor: number, clears?: HighlightClears, saved: LaneRestore = {}): void {
    const kept = events.slice(events.length - newestFitting(events, this.limit, this.maxChars));
    const first = this.nextSeq;
    const map = (seq: number) => first + kept.filter((e) => e.seq < seq).length;
    this.events = kept.map((e, i) => rebind(e, { seq: first + i }));
    this.chars = this.events.reduce((n, e) => n + textChars(e), 0);
    this.nextSeq = first + kept.length;
    const recording = [...this.laneInfos.values()].filter((l) => l.recording);
    this.laneInfos = new Map(recording.map((l) => [l.id, l]));
    for (const l of saved.lanes ?? []) if (!this.laneInfos.has(l.id)) this.laneInfos.set(l.id, { ...l, recording: false });
    this.cursors = new Map();
    for (const lane of new Set([...kept.map(laneOf), ...Object.keys(saved.cursors ?? {})])) {
      this.cursors.set(lane, map(saved.cursors?.[lane] ?? cursor));
    }
    for (const l of recording) if (!this.cursors.has(l.id)) this.cursors.set(l.id, this.nextSeq);
    if (saved.followed !== undefined && this.hasLane(saved.followed)) this.followedLane = saved.followed;
    // The buffer was replaced: play what it now holds, from its first change, not a lane recording beside it.
    else if (kept.length > 0) this.followedLane = laneOf(kept[0]);
    else if (!this.hasLane(this.followedLane)) this.followedLane = recording[0]?.id ?? '';
    this.generation++;
    this.playingSeq = undefined;
    this.droppedUnplayed = 0;
    this.clears = (clears ?? []).map((c) => ({ ...c, seq: map(c.seq) })).filter((c) => c.seq > first);
    this.dropEmptyLanes();
    this.emit();
  }

  /** Undoes the followed lane's clears made later than `cursor`, so replayed changes are highlighted again. */
  private dropClearsAfter(cursor: number): void {
    this.clears = this.clears.filter((c) => laneOf(c) !== this.followedLane || c.seq <= cursor);
  }

  get(seq: number): ChangeEvent | undefined {
    const idx = this.indexOfSeq(seq);
    return idx === -1 ? undefined : this.events[idx];
  }

  all(): readonly ChangeEvent[] {
    return this.events;
  }

  /** Events of `lane` (the followed one by default) at or after its cursor, excluding the one being typed. */
  pendingCount(lane = this.followedLane): number {
    const cursor = this.cursorOf(lane);
    let n = 0;
    for (const e of this.events) {
      if (laneOf(e) === lane && e.seq >= cursor && e.seq !== this.playingSeq) n++;
    }
    return n;
  }

  /** Pending changes in every lane, as `pendingCount` counts them. */
  pendingTotal(): number {
    let n = 0;
    for (const lane of this.lanesInBuffer()) n += this.pendingCount(lane);
    return n;
  }

  /** Seq of the lane's oldest pending change, if any. */
  firstPending(lane: string): number | undefined {
    const cursor = this.cursorOf(lane);
    return this.events.find((e) => laneOf(e) === lane && e.seq >= cursor && e.seq !== this.playingSeq)?.seq;
  }

  /**
   * The newest recorded content of every file in the buffer, or in `lane`,
   * newest event winning. Used to snap mirror editors to the latest state on
   * "skip to latest".
   */
  latestStates(lane?: string): Map<string, ChangeEvent> {
    const out = new Map<string, ChangeEvent>();
    for (const e of this.events) {
      if (lane !== undefined && laneOf(e) !== lane) continue;
      // A path renamed away has no state of its own any more.
      if (e.fromRelPath !== undefined) out.delete(e.fromRelPath);
      out.set(e.relPath, e);
    }
    return out;
  }

  /**
   * What skip to latest settles for `lane` (the followed one by default): the
   * newest change of each of its files, and the paths its renames moved away
   * from, whose mirrors go. Other lanes' mirrors are left as they are.
   */
  snapTargets(lane = this.followedLane): { states: Map<string, ChangeEvent>; renamedAway: string[] } {
    const states = this.latestStates(lane);
    const renamedAway = new Set(
      this.events.flatMap((e) => (laneOf(e) === lane && e.fromRelPath !== undefined && !states.has(e.fromRelPath) ? [e.fromRelPath] : [])),
    );
    return { states, renamedAway: [...renamedAway] };
  }

  /**
   * The text each file's mirror shows at its lane's cursor: the after text of
   * its newest played change, or the before text of its earliest change when
   * none was played. A played rename leaves no mirror at its old path; a
   * queued one leaves its before text there and no mirror yet at its new path.
   * Used to refill mirrors after a reload.
   */
  mirrorStates(): Map<string, { text: string; eol: ChangeEvent['eol'] }> {
    /** The change and side whose text each mirror shows; read once at the end, so saved text is read once per file. */
    const shown = new Map<string, { e: ChangeEvent; side: 'before' | 'after' }>();
    /** Paths with no mirror at the cursor: renamed away, or not yet renamed to. */
    const absent = new Set<string>();
    const decide = (relPath: string, e: ChangeEvent | undefined) => {
      if (shown.has(relPath) || absent.has(relPath)) return;
      if (e === undefined) absent.add(relPath);
      else shown.set(relPath, { e, side: 'before' });
    };
    for (const e of this.events) {
      const from = e.fromRelPath;
      if (e.seq < this.cursorOf(laneOf(e))) {
        if (from !== undefined) {
          shown.delete(from);
          absent.add(from);
        }
        shown.set(e.relPath, { e, side: 'after' });
        absent.delete(e.relPath);
      } else if (from !== undefined) {
        decide(from, e);
        decide(e.relPath, undefined);
      } else decide(e.relPath, e);
    }
    const out = new Map<string, { text: string; eol: ChangeEvent['eol'] }>();
    for (const [relPath, { e, side }] of shown) out.set(relPath, { text: e[side], eol: e.eol });
    return out;
  }

  stateOf(seq: number): 'played' | 'playing' | 'pending' {
    if (seq === this.playingSeq) return 'playing';
    const e = this.get(seq);
    return seq < this.cursorOf(e ? laneOf(e) : this.followedLane) ? 'played' : 'pending';
  }

  /** The followed lane's cursor. */
  get cursor(): number {
    return this.cursorOf(this.followedLane);
  }

  /** Seq being typed right now, if any. */
  get playing(): number | undefined {
    return this.playingSeq;
  }

  /** Changes on every cursor jump (seek, skip, clear, restore, follow), so a caller can tell one happened while it waited. */
  get jumps(): number {
    return this.generation;
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private trim(): void {
    let overflow = Math.max(0, this.events.length - this.limit);
    let chars = this.chars;
    for (let i = 0; i < overflow; i++) chars -= textChars(this.events[i]);
    while (chars > this.maxChars && overflow < this.events.length - 1) chars -= textChars(this.events[overflow++]);
    if (overflow <= 0) return;
    this.chars = chars;
    const dropped = this.events.splice(0, overflow);
    for (const e of dropped) {
      if (e.seq >= this.cursorOf(laneOf(e)) && e.seq !== this.playingSeq) this.droppedUnplayed++;
    }
    const first = this.events[0]?.seq ?? this.nextSeq;
    for (const [lane, cursor] of this.cursors) if (cursor < first) this.cursors.set(lane, first);
    // A clear at or before the first kept change no longer changes any baseline.
    this.clears = this.clears.filter((c) => c.seq > first);
    this.dropEmptyLanes();
  }

  private indexOfSeq(seq: number): number {
    // Seqs are contiguous within the buffer, so this is O(1).
    if (this.events.length === 0) return -1;
    const idx = seq - this.events[0].seq;
    return idx >= 0 && idx < this.events.length ? idx : -1;
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // A broken listener must never stop recording.
      }
    }
  }
}

/**
 * How many of the newest `events` fit in `limit` changes and `maxChars`
 * characters of text. At least one, when there are any.
 */
export function newestFitting(events: readonly ChangeEvent[], limit: number, maxChars: number): number {
  let n = 0;
  let chars = 0;
  for (let i = events.length - 1; i >= 0 && n < limit; i--) {
    chars += textChars(events[i]);
    if (chars > maxChars && n > 0) break;
    n++;
  }
  return n;
}

/** Characters the historySizeMB setting counts as one megabyte. */
export const MB_CHARS = 1024 * 1024;

/**
 * How many of the newest `events` fit `historyLimit` and `historySizeMB`, and
 * the smallest values of both that would fit every one of them.
 */
export function fitLimits(
  events: readonly ChangeEvent[],
  historyLimit: number,
  historySizeMB: number,
): { fits: number; historyLimit: number; historySizeMB: number } {
  const chars = events.reduce((n, e) => n + textChars(e), 0);
  return {
    fits: newestFitting(events, historyLimit, historySizeMB * MB_CHARS),
    historyLimit: Math.max(historyLimit, events.length),
    historySizeMB: Math.max(historySizeMB, Math.ceil(chars / MB_CHARS)),
  };
}

// ------------------------------------------------------------------ sessions

/**
 * The on-disk form of a timeline, shared by workspace persistence and session
 * files. Bump SESSION_VERSION when the shape or the set of kinds changes, and
 * teach parseSession to read every older version. An optional field older
 * versions can safely ignore, like highlightsFrom, needs no bump.
 */
export const SESSION_FORMAT = 'agent-typewriter-session';
export const SESSION_VERSION = 3;

/** The first session version with the 'rename' kind and its fromUri/fromRelPath fields. */
const RENAME_VERSION = 2;
/** The first session version with lanes: `lane` on changes and clears, `lanes`, `cursors` and `followed`. */
const LANES_VERSION = 3;

export interface Session {
  format: typeof SESSION_FORMAT;
  version: number;
  /** Epoch millis when the session was written. */
  savedAt: number;
  /** Seq of the followed lane's next event to play; its events below it were played. */
  cursor: number;
  /** Oldest first, seqs increasing. */
  events: ChangeEvent[];
  /** Highlight clears in effect, oldest first, with seqs like `cursor`. Absent when there are none. */
  highlightsFrom?: HighlightClear[];
  /** Every lane a change names, other than the default lane ''. Absent when there is only that one. */
  lanes?: SavedLane[];
  /** Per lane id, the seq of its next event to play. Absent when there is only the default lane. */
  cursors?: Record<string, number>;
  /** The lane being played. Absent when there is only the default lane. */
  followed?: string;
}

export class SessionFormatError extends Error {}

const KINDS: readonly ChangeKind[] = ['create', 'modify', 'delete', 'rename'];

/**
 * The newest events whose before and after text fit in `maxTextChars`, as a
 * session, plus how many older events were left out to fit.
 */
export function toSession(timeline: Timeline, maxTextChars = Infinity): { session: Session; omitted: number } {
  const events = timeline.all();
  let start = events.length;
  let used = 0;
  while (start > 0) {
    const e = events[start - 1];
    used += textChars(e);
    if (used > maxTextChars) break;
    start--;
  }
  const kept = events.slice(start);
  const ids = [...new Set(kept.map(laneOf))];
  const lanes = ids.length > 1 || (ids.length === 1 && ids[0] !== '');
  return {
    session: {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      savedAt: Date.now(),
      cursor: timeline.cursor,
      events: kept,
      ...(timeline.highlightClears.length > 0 && { highlightsFrom: [...timeline.highlightClears] }),
      ...(lanes && {
        lanes: ids.filter((id) => id !== '').map((id) => savedLane(timeline.laneInfo(id) ?? { id, label: id, root: '', color: 0, recording: false })),
        cursors: Object.fromEntries(ids.map((id) => [id, timeline.cursorOf(id)])),
        followed: ids.includes(timeline.followed) ? timeline.followed : ids[ids.length - 1],
      }),
    },
    omitted: start,
  };
}

function savedLane(info: LaneInfo): SavedLane {
  return { id: info.id, label: info.label, root: info.root, color: info.color };
}

/** A session's lanes, lane cursors and followed lane, for Timeline.restore. */
export function sessionLanes(session: Session): LaneRestore {
  return {
    ...(session.lanes && { lanes: session.lanes }),
    ...(session.cursors && { cursors: session.cursors }),
    ...(session.followed !== undefined && { followed: session.followed }),
  };
}

/** Validates a parsed session of any supported version. Throws SessionFormatError saying what is wrong. */
export function parseSession(raw: unknown): Session {
  const fail = (why: string): never => {
    throw new SessionFormatError(why);
  };
  if (!isObject(raw) || raw.format !== SESSION_FORMAT) fail('not an Agent Typewriter session');
  const s = raw as Record<string, unknown>;
  const version = s.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('missing or invalid version');
  if ((version as number) > SESSION_VERSION) {
    fail(`saved by a newer version of Agent Typewriter (session version ${version}, this one reads up to ${SESSION_VERSION})`);
  }
  if (!isInt(s.cursor)) fail('missing or invalid cursor');
  if (!Array.isArray(s.events)) fail('missing events');
  const lanes = (version as number) >= LANES_VERSION ? parseLanes(s.lanes, fail) : undefined;
  const declared = new Set(lanes?.map((l) => l.id));
  const events: ChangeEvent[] = [];
  let lastSeq = -Infinity;
  for (const [i, e] of (s.events as unknown[]).entries()) {
    const at = `event ${i + 1}`;
    if (!isObject(e)) fail(`${at} is not an object`);
    const r = e as Record<string, unknown>;
    if (!isInt(r.seq) || (r.seq as number) <= lastSeq) fail(`${at} has a missing or out-of-order seq`);
    lastSeq = r.seq as number;
    for (const k of ['uri', 'relPath', 'before', 'after'] as const) if (typeof r[k] !== 'string') fail(`${at} has no ${k}`);
    if (!KINDS.includes(r.kind as ChangeKind) || (r.kind === 'rename' && (version as number) < RENAME_VERSION)) {
      fail(`${at} has unknown kind ${JSON.stringify(r.kind)}`);
    }
    const rename = r.kind === 'rename';
    if (rename) for (const k of ['fromUri', 'fromRelPath'] as const) if (typeof r[k] !== 'string') fail(`${at} is a rename with no ${k}`);
    if (r.eol !== '\n' && r.eol !== '\r\n') fail(`${at} has an invalid eol`);
    for (const k of ['time', 'linesAdded', 'linesRemoved'] as const) if (typeof r[k] !== 'number') fail(`${at} has no ${k}`);
    const lane = (version as number) >= LANES_VERSION && r.lane !== undefined && r.lane !== '' ? r.lane : undefined;
    if (lane !== undefined && (typeof lane !== 'string' || !declared.has(lane))) fail(`${at} names an undeclared lane ${JSON.stringify(lane)}`);
    events.push({
      seq: r.seq as number,
      uri: r.uri as string,
      relPath: r.relPath as string,
      ...(rename && { fromUri: r.fromUri as string, fromRelPath: r.fromRelPath as string }),
      time: r.time as number,
      kind: r.kind as ChangeKind,
      before: r.before as string,
      after: r.after as string,
      eol: r.eol as '\n' | '\r\n',
      linesAdded: r.linesAdded as number,
      linesRemoved: r.linesRemoved as number,
      ...(lane !== undefined && { lane: lane as string }),
    });
  }
  const savedAt = typeof s.savedAt === 'number' ? s.savedAt : 0;
  const highlights = parseHighlightsFrom(s.highlightsFrom);
  const cursors = isObject(s.cursors) ? Object.fromEntries(Object.entries(s.cursors).filter(([, v]) => isInt(v)) as Array<[string, number]>) : undefined;
  const followed = typeof s.followed === 'string' ? s.followed : undefined;
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt,
    cursor: s.cursor as number,
    events,
    ...(highlights && { highlightsFrom: highlights }),
    ...(lanes && lanes.length > 0 && { lanes }),
    ...(lanes && cursors && { cursors }),
    ...(lanes && followed !== undefined && { followed }),
  };
}

/** A v3 session's lanes. Each needs an id and a label; root and color are optional. */
function parseLanes(raw: unknown, fail: (why: string) => never): SavedLane[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail('lanes is not a list');
  return (raw as unknown[]).map((l, i) => {
    if (!isObject(l) || typeof l.id !== 'string' || l.id === '' || typeof l.label !== 'string') fail(`lane ${i + 1} has no id or label`);
    const r = l as Record<string, unknown>;
    return { id: r.id as string, label: r.label as string, root: typeof r.root === 'string' ? r.root : '', color: isInt(r.color) ? (r.color as number) : 0 };
  });
}

/** A saved highlightsFrom with malformed entries left out; losing a clear only shows older highlights. */
function parseHighlightsFrom(raw: unknown): Session['highlightsFrom'] {
  if (!Array.isArray(raw)) return undefined;
  const clears = raw.flatMap((c): HighlightClear[] => {
    if (!isObject(c) || !isInt(c.seq)) return [];
    const lane = typeof c.lane === 'string' && c.lane !== '' ? { lane: c.lane } : {};
    if (c.relPath === undefined) return [{ seq: c.seq as number, ...lane }];
    return typeof c.relPath === 'string' ? [{ seq: c.seq as number, relPath: c.relPath, ...lane }] : [];
  });
  return clears.length > 0 ? clears : undefined;
}

/** A session's highlightsFrom as clears for Timeline.restore. */
export function sessionClears(session: Session): HighlightClears {
  return session.highlightsFrom ?? [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v);
}
