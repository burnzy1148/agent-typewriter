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
  /** LF-normalized text; see eol for the real file's line ending. */
  before: string;
  after: string;
  /** The real file's line ending when this change was recorded. */
  eol: '\n' | '\r\n';
  linesAdded: number;
  linesRemoved: number;
}

export type NewChangeEvent = Omit<ChangeEvent, 'seq'>;

type Listener = () => void;

/**
 * Ordered buffer of every recorded change, plus a playback cursor.
 *
 * Recording and playback are decoupled: the recorder appends at the end
 * whenever a file changes, and the player consumes from the cursor at human
 * speed. Because each event carries its own before/after snapshot, an agent
 * that edits A, then B, then A again replays exactly in that order even when
 * playback is minutes behind, and any earlier point can be replayed again.
 */
export class Timeline {
  private events: ChangeEvent[] = [];
  private nextSeq = 1;
  /** Seq of the next event to play. Anything below it has been played (or skipped). */
  private cursorSeq = 1;
  /** Seq currently being typed, if any. */
  private playingSeq: number | undefined;
  /** Bumped on every cursor jump so an in-flight playback can tell it was overtaken. */
  private generation = 0;
  private listeners = new Set<Listener>();
  /** Count of unplayed events dropped because the buffer overflowed. */
  droppedUnplayed = 0;
  /** Every Clear Highlights still in effect, oldest first. A later clear never replaces an earlier one, so undoing it brings the earlier back. */
  private clears: HighlightClear[] = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.trim();
    this.emit();
  }

  push(e: NewChangeEvent): ChangeEvent {
    const event: ChangeEvent = { ...e, seq: this.nextSeq++ };
    this.events.push(event);
    this.trim();
    this.emit();
    return event;
  }

  /** The next event to play, without consuming it. */
  peek(): ChangeEvent | undefined {
    const idx = this.indexOfSeq(this.cursorSeq);
    return idx === -1 ? undefined : this.events[idx];
  }

  /**
   * Marks `seq` as the one being typed. Returns a token for `complete`; if the
   * cursor is moved (seek, skip, clear) while the event is playing, completing
   * with a stale token leaves the new cursor alone.
   */
  begin(seq: number): number {
    this.playingSeq = seq;
    this.emit();
    return this.generation;
  }

  /** Marks the event done and, unless a seek happened meanwhile, moves past it. */
  complete(seq: number, token?: number): void {
    if (this.playingSeq === seq) this.playingSeq = undefined;
    const stale = token !== undefined && token !== this.generation;
    if (!stale && this.cursorSeq <= seq) this.cursorSeq = seq + 1;
    this.emit();
  }

  /**
   * Moves the cursor so playback resumes at `seq` (earlier = replay, later =
   * skip). The change being typed is overtaken, so it stops counting as playing.
   */
  seek(seq: number): void {
    const first = this.events[0]?.seq ?? this.nextSeq;
    this.cursorSeq = Math.min(Math.max(seq, first), this.nextSeq);
    this.generation++;
    this.playingSeq = undefined;
    this.dropClearsAfter(this.cursorSeq);
    this.emit();
  }

  /** Skip everything queued: the cursor jumps past the newest event. */
  seekToEnd(): void {
    this.cursorSeq = this.nextSeq;
    this.generation++;
    this.playingSeq = undefined;
    this.emit();
  }

  seekToStart(): void {
    this.seek(this.events[0]?.seq ?? this.nextSeq);
  }

  clear(): void {
    this.events = [];
    this.cursorSeq = this.nextSeq;
    this.generation++;
    this.playingSeq = undefined;
    this.droppedUnplayed = 0;
    this.clears = [];
    this.emit();
  }

  /**
   * Clears highlights for every file, or for `relPath`: the text at the cursor
   * becomes the baseline. While a change is typed, that change counts as part
   * of the baseline; when it renames `relPath`, the clear follows the file to
   * its new path.
   */
  clearHighlights(relPath?: string): void {
    const playing = this.playingSeq !== undefined ? this.get(this.playingSeq) : undefined;
    const seq = playing ? playing.seq + 1 : this.cursorSeq;
    const path = relPath !== undefined && playing?.fromRelPath === relPath ? playing.relPath : relPath;
    // Pressing it again at the same point changes nothing.
    if (this.clears.some((c) => c.seq === seq && c.relPath === path)) return;
    this.clears.push(path === undefined ? { seq } : { seq, relPath: path });
    this.emit();
  }

  get highlightClears(): HighlightClears {
    return this.clears.map((c) => ({ ...c }));
  }

  /**
   * Replaces the buffer with saved events, oldest first. They get fresh seqs
   * so seqs stay unique for the life of the timeline; `cursor` (a seq from the
   * same save) maps by position, so played events stay played, and so do
   * highlight `clears`. A clear at or before the first kept event changes
   * nothing, so it is dropped. One made while the saved cursor's change was
   * typed sits just past the cursor and is kept. The current limit applies,
   * newest kept.
   */
  restore(events: readonly ChangeEvent[], cursor: number, clears?: HighlightClears): void {
    const kept = events.slice(Math.max(0, events.length - this.limit));
    const first = this.nextSeq;
    const map = (seq: number) => first + kept.filter((e) => e.seq < seq).length;
    this.events = kept.map((e, i) => ({ ...e, seq: first + i }));
    this.nextSeq = first + kept.length;
    this.cursorSeq = map(cursor);
    this.generation++;
    this.playingSeq = undefined;
    this.droppedUnplayed = 0;
    this.clears = (clears ?? []).map((c) => ({ ...c, seq: map(c.seq) })).filter((c) => c.seq > first);
    this.emit();
  }

  /** Undoes clears made later than `cursor`, so replayed changes are highlighted again. */
  private dropClearsAfter(cursor: number): void {
    this.clears = this.clears.filter((c) => c.seq <= cursor);
  }

  get(seq: number): ChangeEvent | undefined {
    const idx = this.indexOfSeq(seq);
    return idx === -1 ? undefined : this.events[idx];
  }

  all(): readonly ChangeEvent[] {
    return this.events;
  }

  /** Events at or after the cursor, excluding the one currently being typed. */
  pendingCount(): number {
    let n = 0;
    for (const e of this.events) {
      if (e.seq >= this.cursorSeq && e.seq !== this.playingSeq) n++;
    }
    return n;
  }

  /**
   * The newest recorded content of every file in the buffer, newest event
   * winning. Used to snap mirror editors to the latest state on "skip to latest".
   */
  latestStates(): Map<string, ChangeEvent> {
    const out = new Map<string, ChangeEvent>();
    for (const e of this.events) {
      // A path renamed away has no state of its own any more.
      if (e.fromRelPath !== undefined) out.delete(e.fromRelPath);
      out.set(e.relPath, e);
    }
    return out;
  }

  /**
   * The text each file's mirror shows at the cursor: the after text of its
   * newest played change, or the before text of its earliest change when none
   * was played. A played rename leaves no mirror at its old path; a queued
   * one leaves its before text there and no mirror yet at its new path.
   * Used to refill mirrors after a reload.
   */
  mirrorStates(): Map<string, { text: string; eol: ChangeEvent['eol'] }> {
    const out = new Map<string, { text: string; eol: ChangeEvent['eol'] }>();
    /** Paths with no mirror at the cursor: renamed away, or not yet renamed to. */
    const absent = new Set<string>();
    const decide = (relPath: string, text: string | undefined, eol: ChangeEvent['eol']) => {
      if (out.has(relPath) || absent.has(relPath)) return;
      if (text === undefined) absent.add(relPath);
      else out.set(relPath, { text, eol });
    };
    for (const e of this.events) {
      const from = e.fromRelPath;
      if (e.seq < this.cursorSeq) {
        if (from !== undefined) {
          out.delete(from);
          absent.add(from);
        }
        out.set(e.relPath, { text: e.after, eol: e.eol });
        absent.delete(e.relPath);
      } else if (from !== undefined) {
        decide(from, e.before, e.eol);
        decide(e.relPath, undefined, e.eol);
      } else decide(e.relPath, e.before, e.eol);
    }
    return out;
  }

  stateOf(seq: number): 'played' | 'playing' | 'pending' {
    if (seq === this.playingSeq) return 'playing';
    return seq < this.cursorSeq ? 'played' : 'pending';
  }

  get cursor(): number {
    return this.cursorSeq;
  }

  /** Seq being typed right now, if any. */
  get playing(): number | undefined {
    return this.playingSeq;
  }

  /** Changes on every cursor jump (seek, skip, clear, restore), so a caller can tell one happened while it waited. */
  get jumps(): number {
    return this.generation;
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private trim(): void {
    const overflow = this.events.length - this.limit;
    if (overflow <= 0) return;
    const dropped = this.events.splice(0, overflow);
    for (const e of dropped) {
      if (e.seq >= this.cursorSeq && e.seq !== this.playingSeq) this.droppedUnplayed++;
    }
    const first = this.events[0]?.seq ?? this.nextSeq;
    if (this.cursorSeq < first) this.cursorSeq = first;
    // A clear at or before the first kept change no longer changes any baseline.
    this.clears = this.clears.filter((c) => c.seq > first);
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

// ------------------------------------------------------------------ sessions

/**
 * The on-disk form of a timeline, shared by workspace persistence and session
 * files. Bump SESSION_VERSION when the shape or the set of kinds changes, and
 * teach parseSession to read every older version. An optional field older
 * versions can safely ignore, like highlightsFrom, needs no bump.
 */
export const SESSION_FORMAT = 'agent-typewriter-session';
export const SESSION_VERSION = 2;

/** The first session version with the 'rename' kind and its fromUri/fromRelPath fields. */
const RENAME_VERSION = 2;

export interface Session {
  format: typeof SESSION_FORMAT;
  version: number;
  /** Epoch millis when the session was written. */
  savedAt: number;
  /** Seq of the next event to play; events below it were played. */
  cursor: number;
  /** Oldest first, seqs increasing. */
  events: ChangeEvent[];
  /** Highlight clears in effect, oldest first, with seqs like `cursor`. Absent when there are none. */
  highlightsFrom?: HighlightClear[];
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
    used += e.before.length + e.after.length;
    if (used > maxTextChars) break;
    start--;
  }
  return {
    session: {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      savedAt: Date.now(),
      cursor: timeline.cursor,
      events: events.slice(start),
      ...(timeline.highlightClears.length > 0 && { highlightsFrom: [...timeline.highlightClears] }),
    },
    omitted: start,
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
    });
  }
  const savedAt = typeof s.savedAt === 'number' ? s.savedAt : 0;
  const highlights = parseHighlightsFrom(s.highlightsFrom);
  return { format: SESSION_FORMAT, version: SESSION_VERSION, savedAt, cursor: s.cursor as number, events, ...(highlights && { highlightsFrom: highlights }) };
}

/** A saved highlightsFrom with malformed entries left out; losing a clear only shows older highlights. */
function parseHighlightsFrom(raw: unknown): Session['highlightsFrom'] {
  if (!Array.isArray(raw)) return undefined;
  const clears = raw.flatMap((c): HighlightClear[] => {
    if (!isObject(c) || !isInt(c.seq)) return [];
    if (c.relPath === undefined) return [{ seq: c.seq as number }];
    return typeof c.relPath === 'string' ? [{ seq: c.seq as number, relPath: c.relPath }] : [];
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
