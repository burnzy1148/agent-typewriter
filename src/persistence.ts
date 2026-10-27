import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { TextHolder, textHolder, withText, type ChangeText } from './changeText';
import {
  laneOf,
  parseSession,
  toSession,
  SESSION_FORMAT,
  SESSION_VERSION,
  SessionFormatError,
  type ChangeEvent,
  type ChangeKind,
  type Session,
  type Timeline,
} from './timeline';

/** How often a changing timeline is saved at most. */
export const SAVE_INTERVAL_MS = 2000;
/** A lane's log starts a new segment file once the current one holds this many bytes. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;

export const HISTORY_FORMAT = 'agent-typewriter-history';
export const HISTORY_VERSION = 1;
export const LOG_FORMAT = 'agent-typewriter-log';
export const LOG_VERSION = 1;

/**
 * A session as file bytes: JSON, gzip-compressed when asked. Session files
 * the user saves are plain JSON so they can be read and diffed.
 */
export function sessionToBytes(session: Session, opts: { gzip: boolean }): Uint8Array {
  const json = Buffer.from(JSON.stringify(session), 'utf8');
  return opts.gzip ? zlib.gzipSync(json) : json;
}

/** Reads a session from plain or gzip-compressed JSON. Throws SessionFormatError saying what is wrong. */
export function sessionFromBytes(bytes: Uint8Array): Session {
  return parseSession(parseJson(bytes));
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    text = (gzipped ? zlib.gunzipSync(bytes) : Buffer.from(bytes)).toString('utf8');
  } catch {
    throw new SessionFormatError('the file is damaged (it could not be decompressed)');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionFormatError('not an Agent Typewriter session (the file is not JSON)');
  }
}

const DIR = 'history';
const ASIDE = 'history.unreadable';
const STATE = 'state.json';
/** The whole timeline in one file, as versions before the log saved it. */
const LEGACY = 'timeline.json.gz';
const LEGACY_UNREADABLE = 'timeline.unreadable.json.gz';
const SEGMENT_NAME = /^([0-9a-f]{16})\.(\d+)\.log$/;

/** One segment file of a lane's log, and the change each of its records holds, undefined once it left the buffer. */
interface Segment {
  file: string;
  n: number;
  bytes: number;
  holders: Array<TextHolder | undefined>;
  /** Its size on disk is not known for sure (a damaged end could not be cut off): nothing more is appended to it. */
  sealed?: boolean;
}

interface LaneLog {
  id: string;
  key: string;
  segments: Segment[];
}

/** The small part of a save that is rewritten every time: positions are orders, not seqs. */
interface HistoryState {
  format: typeof HISTORY_FORMAT;
  version: number;
  savedAt: number;
  /** Order of the buffer's oldest change; records below it left the buffer. */
  first: number;
  /** Order the next record gets. */
  next: number;
  cursor: number;
  cursors?: Record<string, number>;
  followed?: string;
  lanes?: Session['lanes'];
  highlightsFrom?: Session['highlightsFrom'];
  /**
   * Per segment a load could not read, the `first` in effect then: its
   * changes are judged by that, not by the later `first`, which was worked out
   * without them, once a load can read it.
   */
  unread?: Record<string, number>;
  /** Per sealed segment, the bytes that hold its changes; anything after them is not part of the log. */
  sealed?: Record<string, number>;
}

/** Orders after a segment that could not be read, when nothing says how far its orders go. */
const UNKNOWN_ORDERS_FLOOR = 2 ** 50;

/**
 * Keeps the timeline in a workspace storage folder so a reload does not lose
 * it. Plain Node on purpose: the folder is VS Code's per-workspace extension
 * storage, never the workspace itself.
 *
 * The buffer is kept as an append-only log per lane, in segment files under
 * `history/`, plus `state.json` with the playback position, lanes and
 * highlight clears. A save appends the changes recorded since the last one,
 * lets go of their text (it is read back from the log when needed), deletes
 * segments whose changes have all left the buffer, and rewrites the state
 * through a temp file. Saving is throttled rather than debounced, so
 * continuous playback still saves every SAVE_INTERVAL_MS. Saves are
 * synchronous: they write only what changed.
 */
export class TimelineStore {
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private subscription: { dispose(): void } | undefined;
  private lanes = new Map<string, LaneLog>();
  /** Order of every change written to the log that has not been found gone from the buffer yet. */
  private orders = new Map<TextHolder, number>();
  /** Per lane key, the number for its next segment file; never reused, so a file that could not be deleted is not appended to. */
  private segmentNumbers = new Map<string, number>();
  private next = 1;
  /** Segment files to delete; a failed delete is tried again on the next save. */
  private doomed: string[] = [];
  /** The last state written, without savedAt, so an unchanged state is not written again. */
  private lastState = '';
  /** Restored from an earlier version's file, which is removed once the log holds it. */
  private migrating = false;
  /** Moves an unreadable saved timeline aside; set while that has not worked yet, and saving waits for it. */
  private aside: { move: () => boolean; name: string } | undefined;
  /** Segment files the last load could not read, by name, with the `first` their changes are judged by. */
  private unread = new Map<string, number>();
  /** Retries a delete that had to wait for the saved text to be readable. */
  private deleteRetry: NodeJS.Timeout | undefined;
  /** The last save error logged, so a save failing the same way again is not logged again. */
  private lastSaveError: string | undefined;
  /** Changes appended to the log so far, for tests. */
  appendedCount = 0;

  constructor(
    private readonly folder: string,
    private readonly timeline: Timeline,
    private readonly log: (line: string) => void,
    private readonly intervalMs = SAVE_INTERVAL_MS,
    private readonly segmentBytes = SEGMENT_BYTES,
  ) {}

  /** The folder the log is kept in. */
  get path(): string {
    return path.join(this.folder, DIR);
  }

  get isRunning(): boolean {
    return this.subscription !== undefined;
  }

  // ---------------------------------------------------------------- load

  /**
   * Reads the saved timeline, as a session whose seqs are log orders. Its
   * changes read their text from the log when it is needed. Nothing saved is
   * undefined; a timeline saved by a newer version or that cannot be read is
   * logged, moved aside so it is not overwritten, and also undefined. A log
   * cut short by a crash is truncated after its last complete change.
   */
  load(): Session | undefined {
    try {
      return this.loadSaved();
    } catch (err) {
      // Whatever went wrong, the extension starts; saving waits until the history can be moved aside.
      this.log(`Could not restore the saved timeline (${errorText(err)}). Starting empty.`);
      this.forget();
      this.setAside(this.historyAside());
      return undefined;
    }
  }

  private loadSaved(): Session | undefined {
    this.forget();
    // Left by an earlier version that stopped mid-save.
    for (const f of [LEGACY + '.tmp', LEGACY + '.sync.tmp']) removeQuietly(path.join(this.folder, f));
    const st = this.readState();
    if (st.kind === 'unreadable' || st.kind === 'newer') {
      this.log(st.kind === 'newer' ? `The saved timeline was saved by a newer version of Agent Typewriter (history version ${st.version}, this one reads up to ${HISTORY_VERSION}). Starting empty.` : `Could not read the saved timeline (${st.why}). Starting empty.`);
      this.setAside(this.historyAside());
      return undefined;
    }
    const legacy = path.join(this.folder, LEGACY);
    const legacySaved = fileTime(legacy);
    if (legacySaved !== undefined) {
      // A migration that never wrote its first state, or an earlier version
      // saved after this one (a downgrade): start over from its file.
      if (st.kind !== 'ok' || legacySaved > st.state.savedAt) {
        this.discardLogs();
        return this.loadLegacy();
      }
      // Migrated, but removing the earlier file did not happen.
      removeQuietly(legacy);
    }
    if (st.kind === 'damaged') this.log(`The saved timeline's state could not be read (${st.why}); its changes are restored as pending.`);
    const state = st.kind === 'ok' ? st.state : undefined;
    const records = this.scanLogs(state);
    if (records === undefined) return undefined;
    const first = state?.first ?? -Infinity;
    // A segment an earlier load could not read was left out of `first` too.
    const isLive = (r: LoadedRecord) => r.o >= (state?.unread?.[path.basename(r.segment.file)] ?? first);
    const live = records.filter(isLive).sort((a, b) => a.o - b.o);
    this.next = records.reduce((n, r) => Math.max(n, r.o + 1), Math.max(this.next, state?.next ?? 1));
    // Orders of a segment that could not be read are not known; keep clear of them.
    if (this.unread.size > 0 && state === undefined) this.next = Math.max(this.next, UNKNOWN_ORDERS_FLOOR);
    for (const r of records) {
      if (!isLive(r)) continue;
      this.orders.set(r.holder, r.o);
      r.segment.holders[r.index] = r.holder;
    }
    if (live.length === 0) return undefined;
    const events = live.map((r) => withText({ seq: r.o, ...r.fields, ...(r.lane !== '' && { lane: r.lane }) }, r.holder) as ChangeEvent);
    return {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      savedAt: state?.savedAt ?? 0,
      // Without a state every change is pending.
      cursor: state?.cursor ?? events[0].seq,
      events,
      ...(state?.highlightsFrom && { highlightsFrom: state.highlightsFrom }),
      ...(state?.lanes && { lanes: state.lanes }),
      ...(state?.cursors && { cursors: state.cursors }),
      ...(state?.followed !== undefined && { followed: state.followed }),
    };
  }

  private readState():
    | { kind: 'missing' }
    | { kind: 'ok'; state: HistoryState }
    | { kind: 'damaged'; why: string }
    | { kind: 'unreadable'; why: string }
    | { kind: 'newer'; version: number } {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.path, STATE), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unreadable', why: errorText(err) };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'damaged', why: 'it is not JSON' };
    }
    if (!isObject(raw) || raw.format !== HISTORY_FORMAT || !isInt(raw.version) || (raw.version as number) < 1) {
      return { kind: 'damaged', why: 'it is not an Agent Typewriter history' };
    }
    if ((raw.version as number) > HISTORY_VERSION) return { kind: 'newer', version: raw.version as number };
    if (!isInt(raw.first) || !isInt(raw.next) || !isInt(raw.cursor)) return { kind: 'damaged', why: 'its positions are missing' };
    // The lanes, cursors and clears read as a session's do.
    let positions: Session;
    try {
      positions = parseSession({ ...raw, format: SESSION_FORMAT, version: SESSION_VERSION, events: [] });
    } catch (err) {
      return { kind: 'damaged', why: err instanceof Error ? err.message : String(err) };
    }
    const { lanes, cursors, followed, highlightsFrom } = positions;
    return {
      kind: 'ok',
      state: {
        format: HISTORY_FORMAT,
        version: HISTORY_VERSION,
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
        first: raw.first as number,
        next: raw.next as number,
        cursor: raw.cursor as number,
        ...(lanes && { lanes }),
        ...(cursors && { cursors }),
        ...(followed !== undefined && { followed }),
        ...(highlightsFrom && { highlightsFrom }),
        ...(isObject(raw.unread) && {
          unread: Object.fromEntries(Object.entries(raw.unread).filter(([, v]) => isInt(v))) as Record<string, number>,
        }),
        ...(isObject(raw.sealed) && {
          sealed: Object.fromEntries(Object.entries(raw.sealed).filter(([, v]) => isInt(v) && (v as number) >= 0)) as Record<string, number>,
        }),
      },
    };
  }

  /**
   * Reads every segment, oldest first per lane, checking each change's text.
   * A damaged change ends its segment there. Undefined when a segment was
   * written by a newer version.
   */
  private scanLogs(state?: HistoryState): LoadedRecord[] | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Without the file names, new segments could land on old ones.
      throw err;
    }
    const byLane = new Map<string, Array<{ file: string; n: number; scan: SegmentScan }>>();
    for (const name of names) {
      const file = path.join(this.path, name);
      if (name.endsWith('.tmp')) {
        removeQuietly(file);
        continue;
      }
      const m = SEGMENT_NAME.exec(name);
      if (!m) continue;
      const n = Number(m[2]);
      this.segmentNumbers.set(m[1], Math.max(this.segmentNumbers.get(m[1]) ?? 1, n + 1));
      let scan: SegmentScan;
      try {
        scan = scanSegment(file);
      } catch (err) {
        // Left for a later load, which restores its changes; its number stays taken, so nothing is appended to it.
        this.log(`Could not read ${name} of the saved timeline (${errorText(err)}); its changes are left out this time.`);
        this.unread.set(name, state?.unread?.[name] ?? state?.first ?? 0);
        continue;
      }
      if (scan.newer !== undefined) {
        this.log(`The saved timeline was saved by a newer version of Agent Typewriter (log version ${scan.newer}, this one reads up to ${LOG_VERSION}). Starting empty.`);
        this.forget();
        this.setAside(this.historyAside());
        return undefined;
      }
      if (scan.lane === undefined) {
        // Not even its header was written: it holds no change.
        this.doomed.push(file);
        continue;
      }
      const list = byLane.get(scan.lane) ?? [];
      list.push({ file, n, scan });
      byLane.set(scan.lane, list);
    }
    const out: LoadedRecord[] = [];
    for (const [id, list] of byLane) {
      list.sort((a, b) => a.n - b.n);
      const log: LaneLog = { id, key: laneKey(id), segments: [] };
      let lost = 0;
      let why: string | undefined;
      let last = -Infinity;
      for (const { file, n, scan } of list) {
        // Damage cuts its own segment short; later segments hold changes saved after it, complete ones.
        let { records, end, damage, dropped } = scan;
        const limit = state?.sealed?.[path.basename(file)];
        if (limit !== undefined && limit < scan.size) {
          // Sealed: past `limit` is what a failed append left, changes saved again elsewhere.
          records = records.filter((r) => r.at + r.b + r.a <= limit);
          if (end >= limit) {
            damage = undefined;
            dropped = 0;
          }
          end = Math.min(end, limit);
        }
        lost += dropped;
        // Changes not after the ones before them (left by a delete that did not finish) are skipped, not cut off.
        const ordered = records.filter((r) => (r.o > last ? ((last = r.o), true) : false));
        if (ordered.length < records.length) {
          why ??= 'some changes are out of order';
          lost += records.length - ordered.length;
        }
        let sealed = false;
        if (damage !== undefined || end < scan.size) {
          if (damage !== undefined) why ??= damage;
          try {
            fs.truncateSync(file, end);
          } catch (err) {
            sealed = true;
            this.log(`Could not cut the damaged end off ${path.basename(file)}: ${errorText(err)}`);
          }
        }
        const segment: Segment = { file, n, bytes: end, holders: ordered.map(() => undefined), ...(sealed && { sealed }) };
        log.segments.push(segment);
        ordered.forEach((r, index) => {
          const holder = new TextHolder(r.c, () => readText(file, r.at, r.b, r.a, r.crc), this);
          out.push({ o: r.o, lane: id, fields: r.fields, holder, segment, index });
        });
      }
      if (why !== undefined) this.log(`The saved timeline was cut short (${why}); left out ${lost} change(s) that were not completely saved.`);
      this.lanes.set(id, log);
    }
    this.removeDoomed();
    return out;
  }

  /** Restores the whole timeline saved in one file by an earlier version, to be written to the log by the next save. */
  private loadLegacy(): Session | undefined {
    const file = path.join(this.folder, LEGACY);
    const aside = {
      name: LEGACY_UNREADABLE,
      move: () => moveAside(file, path.join(this.folder, LEGACY_UNREADABLE)),
    };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.log(`Could not read the saved timeline (${errorText(err)}). Starting empty.`);
      this.setAside(aside);
      return undefined;
    }
    try {
      const session = sessionFromBytes(bytes);
      this.migrating = true;
      return session;
    } catch (err) {
      this.log(`Could not restore the saved timeline: ${err instanceof Error ? err.message : String(err)}. Starting empty.`);
      this.setAside(aside);
      return undefined;
    }
  }

  /**
   * Gets rid of the log, as a migration from the earlier file starts over.
   * Order and segment numbers stay taken, so a file that cannot be deleted yet
   * is never mistaken for a newer one.
   */
  private discardLogs(): void {
    const records = this.scanLogs() ?? [];
    this.next = records.reduce((n, r) => Math.max(n, r.o + 1), this.next);
    for (const log of this.lanes.values()) for (const s of log.segments) this.doomed.push(s.file);
    this.lanes.clear();
    this.removeDoomed();
    removeQuietly(path.join(this.path, STATE));
  }

  private historyAside(): { move: () => boolean; name: string } {
    return {
      name: ASIDE,
      move: () => {
        try {
          fs.rmSync(path.join(this.folder, ASIDE), { recursive: true, force: true });
        } catch {
          // The rename below says whether it is in the way.
        }
        return moveAside(this.path, path.join(this.folder, ASIDE));
      },
    };
  }

  /** Moves an unreadable saved timeline aside. If that fails, saving holds off so it is not replaced. */
  private setAside(aside: { move: () => boolean; name: string }): void {
    if (aside.move()) return;
    this.aside = aside;
    this.log(`Could not move it to ${aside.name} either; the timeline will not be saved until it can be.`);
  }

  /** False while an unreadable saved timeline is still in the way of saving. */
  private canSave(): boolean {
    if (this.aside?.move()) {
      this.log(`Moved the unreadable saved timeline to ${this.aside.name}.`);
      this.aside = undefined;
    }
    return this.aside === undefined;
  }

  // ---------------------------------------------------------------- save

  /** Saves on every timeline change from now on, and once soon. */
  start(): void {
    this.cancelDeleteRetry();
    if (this.subscription) return;
    this.subscription = this.timeline.onDidChange(() => this.markDirty());
    this.markDirty();
  }

  /** Stops saving. Pending changes are not written. */
  stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
  }

  /** Writes now if anything changed since the last save. */
  async flush(): Promise<void> {
    this.flushSync();
  }

  /** Writes now if anything changed since the last save, for deactivation. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) this.save();
  }

  /**
   * Removes the saved timeline, including a copy moved aside as unreadable.
   * Changes whose text was only in the log get it back in memory first.
   */
  deleteSaved(): void {
    this.cancelDeleteRetry();
    try {
      for (const e of this.timeline.all()) {
        const holder = textHolder(e);
        if (holder.owner === this) holder.pin();
      }
    } catch (err) {
      // Deleting now would lose the text; try again until it can be read.
      this.log(`Could not read the saved timeline back before deleting it (${errorText(err)}); it is deleted once it can be read.`);
      this.deleteRetry = setTimeout(() => {
        this.deleteRetry = undefined;
        this.deleteSaved();
      }, this.intervalMs);
      return;
    }
    // Whatever was written, nothing written from now on may be mistaken for it.
    const st = this.readState();
    if (st.kind === 'ok') this.next = Math.max(this.next, st.state.next);
    this.forget();
    this.aside = undefined;
    this.migrating = false;
    for (const f of [DIR, ASIDE, LEGACY, LEGACY + '.tmp', LEGACY + '.sync.tmp', LEGACY_UNREADABLE]) removeQuietly(path.join(this.folder, f));
    // A segment another process holds open stays behind: delete it on a later save. Orders
    // and segment numbers from now on go past it, so a load leaves its changes out.
    let left: string[] = [];
    try {
      left = fs.readdirSync(this.path).filter((name) => SEGMENT_NAME.test(name));
    } catch {
      // Nothing left.
    }
    for (const name of left) {
      const file = path.join(this.path, name);
      const m = SEGMENT_NAME.exec(name)!;
      this.segmentNumbers.set(m[1], Math.max(this.segmentNumbers.get(m[1]) ?? 1, Number(m[2]) + 1));
      try {
        this.next = scanSegment(file).records.reduce((n, r) => Math.max(n, r.o + 1), this.next);
      } catch {
        if (st.kind !== 'ok') this.next = Math.max(this.next, UNKNOWN_ORDERS_FLOOR);
      }
      this.doomed.push(file);
    }
  }

  private cancelDeleteRetry(): void {
    if (this.deleteRetry) clearTimeout(this.deleteRetry);
    this.deleteRetry = undefined;
  }

  dispose(): void {
    if (this.isRunning) this.flushSync();
    this.stop();
    this.cancelDeleteRetry();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.dirty) this.save();
    }, this.intervalMs);
  }

  private save(): void {
    // Still dirty, so the next save tries the move again.
    if (!this.canSave()) return this.retrySoon();
    this.dirty = false;
    try {
      this.write();
      this.lastSaveError = undefined;
    } catch (err) {
      this.dirty = true;
      const why = errorText(err);
      if (why !== this.lastSaveError) this.log(`Could not save the timeline: ${why}`);
      this.lastSaveError = why;
      this.retrySoon();
    }
  }

  /** Tries a save that could not happen again after the interval, without waiting for another change. */
  private retrySoon(): void {
    if (this.isRunning) this.markDirty();
  }

  private write(): void {
    const events = this.timeline.all();
    fs.mkdirSync(this.path, { recursive: true });
    if (this.markGone(events)) this.rewriteAll();
    const appended = this.append(events.filter((e) => !this.orders.has(textHolder(e))));
    this.markEmpty();
    const state = this.stateOf(events);
    const { savedAt, ...rest } = state;
    const json = JSON.stringify(rest);
    if (json !== this.lastState || appended > 0 || this.migrating) {
      const file = path.join(this.path, STATE);
      fs.writeFileSync(file + '.tmp', JSON.stringify(state));
      fs.renameSync(file + '.tmp', file);
      this.lastState = json;
    }
    // Only once the state says where the buffer starts, so a crash before it leaves the old records counted.
    this.removeDoomed();
    if (this.migrating) {
      removeQuietly(path.join(this.folder, LEGACY));
      this.migrating = false;
    }
  }

  /**
   * Marks the records of changes that left the buffer. True when the log no
   * longer matches the buffer's order: a lane's gone records are not all
   * before its kept ones, or a change not written yet is older than one that
   * is. Trimming and replacing the buffer never do that.
   */
  private markGone(events: readonly ChangeEvent[]): boolean {
    const live = new Set(events.map(textHolder));
    let broken = false;
    for (const log of this.lanes.values()) {
      let kept = false;
      for (const segment of log.segments) {
        segment.holders.forEach((h, i) => {
          if (h && live.has(h)) {
            kept = true;
            return;
          }
          if (h) {
            this.orders.delete(h);
            segment.holders[i] = undefined;
          }
          if (kept) broken = true;
        });
      }
    }
    let unwritten = false;
    for (const e of events) {
      if (!this.orders.has(textHolder(e))) unwritten = true;
      else if (unwritten) broken = true;
    }
    return broken;
  }

  /**
   * Writes every lane again from scratch: the kept changes' text comes back
   * into memory and every segment goes. Every lane, because orders run across
   * lanes: a change written out of turn in one lane would sort wrongly against
   * the others on load.
   */
  private rewriteAll(): void {
    // A text that cannot be read just now aborts the save, before anything is let go.
    for (const h of this.orders.keys()) h.pin();
    for (const log of this.lanes.values()) for (const s of log.segments) this.doomed.push(s.file);
    this.lanes.clear();
    this.orders.clear();
  }

  /** Appends `events`, oldest first, one write per segment, then lets go of their text. Returns how many were written. */
  private append(events: readonly ChangeEvent[]): number {
    if (events.length === 0) return 0;
    const batches = new Map<Segment, { parts: Buffer[]; size: number; isNew: boolean; records: Array<{ holder: TextHolder; order: number; at: number; b: number; a: number; crc: number }> }>();
    const fresh = new Set<Segment>();
    for (const e of events) {
      const log = this.laneLog(laneOf(e));
      let segment = log.segments[log.segments.length - 1];
      if (!segment || segment.sealed || (batches.get(segment)?.size ?? segment.bytes) >= this.segmentBytes) {
        segment = this.newSegment(log);
        fresh.add(segment);
      }
      let batch = batches.get(segment);
      if (!batch) {
        batches.set(segment, (batch = { parts: [], size: segment.bytes, isNew: fresh.has(segment), records: [] }));
        if (batch.isNew) {
          const header = Buffer.from(JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION, lane: log.id }) + '\n', 'utf8');
          batch.parts.push(header);
          batch.size += header.length;
        }
      }
      const order = this.next++;
      const rec = encodeRecord(order, e);
      batch.parts.push(rec.bytes);
      batch.records.push({ holder: textHolder(e), order, at: batch.size + rec.headerBytes, b: rec.b, a: rec.a, crc: rec.crc });
      batch.size += rec.bytes.length;
    }
    let written = 0;
    let failure: unknown;
    for (const [segment, batch] of batches) {
      try {
        // A new segment never lands on a file already there.
        fs.appendFileSync(segment.file, Buffer.concat(batch.parts), { flag: batch.isNew ? 'wx' : 'a' });
      } catch (err) {
        failure ??= err;
        if (batch.isNew) {
          // Whatever part of it was written goes; one that was already there is not ours.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') this.doomed.push(segment.file);
          const log = [...this.lanes.values()].find((l) => l.segments.includes(segment));
          if (log) log.segments.splice(log.segments.indexOf(segment), 1);
        } else {
          // Leave no partial record for later appends to follow; if it stays, append elsewhere.
          try {
            fs.truncateSync(segment.file, segment.bytes);
          } catch {
            segment.sealed = true;
          }
        }
        continue;
      }
      segment.bytes = batch.size;
      for (const r of batch.records) {
        const file = segment.file;
        r.holder.offload(() => readText(file, r.at, r.b, r.a, r.crc), this);
        this.orders.set(r.holder, r.order);
        segment.holders.push(r.holder);
        written++;
      }
    }
    this.appendedCount += written;
    if (failure !== undefined) throw failure;
    return written;
  }

  /** Marks segments with no change left in the buffer for deletion, and forgets lanes with no segment left. */
  private markEmpty(): void {
    for (const [id, log] of this.lanes) {
      log.segments = log.segments.filter((s) => {
        if (s.holders.some((h) => h !== undefined)) return true;
        this.doomed.push(s.file);
        return false;
      });
      if (log.segments.length === 0) this.lanes.delete(id);
    }
  }

  private removeDoomed(): void {
    this.doomed = this.doomed.filter((file) => {
      try {
        fs.rmSync(file, { force: true });
        return false;
      } catch {
        return true;
      }
    });
  }

  private laneLog(id: string): LaneLog {
    let log = this.lanes.get(id);
    if (!log) this.lanes.set(id, (log = { id, key: laneKey(id), segments: [] }));
    return log;
  }

  private newSegment(log: LaneLog): Segment {
    const n = this.segmentNumbers.get(log.key) ?? 1;
    this.segmentNumbers.set(log.key, n + 1);
    const segment: Segment = { file: path.join(this.path, `${log.key}.${String(n).padStart(6, '0')}.log`), n, bytes: 0, holders: [] };
    log.segments.push(segment);
    return segment;
  }

  /** The playback position, lanes and clears, with every seq as the order of the first change at or after it. */
  private stateOf(events: readonly ChangeEvent[]): HistoryState {
    const firstSeq = events[0]?.seq;
    const orderAt = (seq: number) => {
      if (firstSeq === undefined) return this.next;
      const e = events[Math.max(0, seq - firstSeq)];
      return e ? this.orders.get(textHolder(e)) ?? this.next : this.next;
    };
    const { session } = toSession(this.timeline);
    const sealed = [...this.lanes.values()].flatMap((l) => l.segments.filter((s) => s.sealed));
    return {
      format: HISTORY_FORMAT,
      version: HISTORY_VERSION,
      savedAt: Date.now(),
      first: firstSeq === undefined ? this.next : orderAt(firstSeq),
      next: this.next,
      cursor: orderAt(session.cursor),
      ...(session.cursors && { cursors: Object.fromEntries(Object.entries(session.cursors).map(([lane, seq]) => [lane, orderAt(seq)])) }),
      ...(session.followed !== undefined && { followed: session.followed }),
      ...(session.lanes && { lanes: session.lanes }),
      ...(session.highlightsFrom && { highlightsFrom: session.highlightsFrom.map((c) => ({ ...c, seq: orderAt(c.seq) })) }),
      ...(this.unread.size > 0 && { unread: Object.fromEntries(this.unread) }),
      ...(sealed.length > 0 && { sealed: Object.fromEntries(sealed.map((s) => [path.basename(s.file), s.bytes])) }),
    };
  }

  /**
   * Forgets what is known about the log on disk. The next order and segment
   * numbers are kept, so nothing written later can be mistaken for what was
   * there before.
   */
  private forget(): void {
    this.lanes.clear();
    this.orders.clear();
    this.doomed = [];
    this.unread.clear();
    this.lastState = '';
  }
}

/** A record of the log, as load reads it. */
interface LoadedRecord {
  o: number;
  lane: string;
  fields: RecordFields;
  holder: TextHolder;
  segment: Segment;
  index: number;
}

type RecordFields = Omit<ChangeEvent, 'seq' | 'before' | 'after' | 'lane'>;

interface ScannedRecord {
  o: number;
  fields: RecordFields;
  /** Characters of before and after text. */
  c: number;
  /** Byte lengths of the before and after text. */
  b: number;
  a: number;
  crc: number;
  /** Offset of the record, and of its text. */
  start: number;
  at: number;
}

interface SegmentScan {
  /** Undefined when the header did not make it to disk. */
  lane?: string;
  records: ScannedRecord[];
  /** Offset after the last complete record. */
  end: number;
  /** Bytes in the file. */
  size: number;
  /** Why the segment ends early, if it does. */
  damage?: string;
  /** How many changes the damage is known to leave out: the damaged one and any complete ones after it. */
  dropped: number;
  /** The log version, when it is newer than this one reads. */
  newer?: number;
}

function scanSegment(file: string): SegmentScan {
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(10);
  let head: unknown;
  try {
    head = nl < 0 ? undefined : JSON.parse(buf.toString('utf8', 0, nl));
  } catch {
    // Treated as missing below.
  }
  if (!isObject(head) || head.format !== LOG_FORMAT || typeof head.lane !== 'string' || !isInt(head.version)) return { records: [], end: 0, size: buf.length, dropped: 0 };
  if ((head.version as number) > LOG_VERSION) return { records: [], end: 0, size: buf.length, dropped: 0, newer: head.version as number };
  const records: ScannedRecord[] = [];
  let pos = nl + 1;
  let damage: string | undefined;
  while (pos < buf.length) {
    const hl = buf.indexOf(10, pos);
    if (hl < 0) {
      damage = 'a change is cut short';
      break;
    }
    let rec: Omit<ScannedRecord, 'start' | 'at'> | undefined;
    try {
      rec = parseRecordHeader(JSON.parse(buf.toString('utf8', pos, hl)));
    } catch {
      rec = undefined;
    }
    if (!rec) {
      damage = 'a change is not readable';
      break;
    }
    const at = hl + 1;
    const end = at + rec.b + rec.a;
    if (end > buf.length) {
      damage = 'a change is cut short';
      break;
    }
    if (crc32(buf.subarray(at, end)) !== rec.crc) {
      damage = "a change's text does not match its checksum";
      break;
    }
    records.push({ ...rec, start: pos, at });
    pos = end;
  }
  return { lane: head.lane as string, records, end: pos, size: buf.length, dropped: damage === undefined ? 0 : 1 + countAfter(buf, pos), ...(damage !== undefined && { damage }) };
}

/**
 * Complete records after the damaged one at `pos`, when its own length can
 * still be read: changes the damage leaves out too, as far as can be told.
 */
function countAfter(buf: Buffer, pos: number): number {
  // The damaged record itself is not counted.
  let n = -1;
  for (;;) {
    const hl = buf.indexOf(10, pos);
    let rec: Omit<ScannedRecord, 'start' | 'at'> | undefined;
    try {
      rec = hl < 0 ? undefined : parseRecordHeader(JSON.parse(buf.toString('utf8', pos, hl)));
    } catch {
      rec = undefined;
    }
    if (!rec) return Math.max(n, 0);
    pos = hl + 1 + rec.b + rec.a;
    if (pos > buf.length) return Math.max(n, 0);
    n++;
  }
}

const KINDS: readonly ChangeKind[] = ['create', 'modify', 'delete', 'rename'];

/** A record header's fields, or undefined when any is missing or malformed. */
function parseRecordHeader(r: unknown): Omit<ScannedRecord, 'start' | 'at'> | undefined {
  if (!isObject(r)) return undefined;
  const counts = ['o', 'c', 'b', 'a', 'crc'] as const;
  if (counts.some((k) => !isInt(r[k]) || (r[k] as number) < 0)) return undefined;
  if (typeof r.uri !== 'string' || typeof r.relPath !== 'string' || !KINDS.includes(r.kind as ChangeKind)) return undefined;
  const rename = r.kind === 'rename';
  if (rename && (typeof r.fromUri !== 'string' || typeof r.fromRelPath !== 'string')) return undefined;
  if (r.eol !== '\n' && r.eol !== '\r\n') return undefined;
  if (['time', 'linesAdded', 'linesRemoved'].some((k) => typeof r[k] !== 'number')) return undefined;
  return {
    o: r.o as number,
    c: r.c as number,
    b: r.b as number,
    a: r.a as number,
    crc: r.crc as number,
    fields: {
      uri: r.uri,
      relPath: r.relPath,
      ...(rename && { fromUri: r.fromUri as string, fromRelPath: r.fromRelPath as string }),
      time: r.time as number,
      kind: r.kind as ChangeKind,
      eol: r.eol,
      linesAdded: r.linesAdded as number,
      linesRemoved: r.linesRemoved as number,
    },
  };
}

/** A change as a log record: a JSON header line, then its before and after text as UTF-8. */
function encodeRecord(order: number, e: ChangeEvent): { bytes: Buffer; headerBytes: number; b: number; a: number; crc: number } {
  const before = Buffer.from(e.before, 'utf8');
  const after = Buffer.from(e.after, 'utf8');
  const text = Buffer.concat([before, after]);
  const crc = crc32(text);
  const header = Buffer.from(
    JSON.stringify({
      o: order,
      uri: e.uri,
      relPath: e.relPath,
      ...(e.kind === 'rename' && { fromUri: e.fromUri, fromRelPath: e.fromRelPath }),
      time: e.time,
      kind: e.kind,
      eol: e.eol,
      linesAdded: e.linesAdded,
      linesRemoved: e.linesRemoved,
      c: textHolder(e).chars,
      b: before.length,
      a: after.length,
      crc,
    }) + '\n',
    'utf8',
  );
  return { bytes: Buffer.concat([header, text]), headerBytes: header.length, b: before.length, a: after.length, crc };
}

/** Reads one change's text from its segment, checking it is what was written. */
function readText(file: string, at: number, b: number, a: number, crc: number): ChangeText {
  if (b + a === 0) return { before: '', after: '' };
  const buf = Buffer.allocUnsafe(b + a);
  const fd = fs.openSync(file, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, b + a, at);
    if (n !== b + a) throw new Error(`${path.basename(file)} is shorter than when it was saved`);
  } finally {
    fs.closeSync(fd);
  }
  if (crc32(buf) !== crc) throw new Error(`${path.basename(file)} changed since it was saved`);
  return { before: buf.toString('utf8', 0, b), after: buf.toString('utf8', b) };
}

/** Removes a file or folder, leaving it for later if that fails. */
function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // Another process may hold it; it is tried again next time.
  }
}

/** When `file` was last written, or undefined when it does not exist. */
function fileTime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function laneKey(id: string): string {
  return crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);
}

/** Renames `from` to `to`; true when it did or there was nothing to move. */
function moveAside(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32, natively where Node has it (20.15 and later). */
export function crc32(data: Uint8Array): number {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data);
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function errorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const message = err instanceof Error ? err.message : String(err);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v);
}
