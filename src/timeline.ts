export type ChangeKind = 'create' | 'modify' | 'delete';

export interface ChangeEvent {
  /** Monotonic sequence number, unique for the life of the timeline. */
  seq: number;
  /** URI string of the real file. */
  uri: string;
  /** Workspace-relative path, forward slashes. Also the mirror document's path. */
  relPath: string;
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

  /** Moves the cursor so playback resumes at `seq` (earlier = replay, later = skip). */
  seek(seq: number): void {
    const first = this.events[0]?.seq ?? this.nextSeq;
    this.cursorSeq = Math.min(Math.max(seq, first), this.nextSeq);
    this.generation++;
    this.emit();
  }

  /** Skip everything queued: the cursor jumps past the newest event. */
  seekToEnd(): void {
    this.cursorSeq = this.nextSeq;
    this.generation++;
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
    this.emit();
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
    for (const e of this.events) out.set(e.relPath, e);
    return out;
  }

  stateOf(seq: number): 'played' | 'playing' | 'pending' {
    if (seq === this.playingSeq) return 'playing';
    return seq < this.cursorSeq ? 'played' : 'pending';
  }

  get cursor(): number {
    return this.cursorSeq;
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
