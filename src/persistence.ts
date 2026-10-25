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
}

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
    this.forget();
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
        fs.rmSync(this.path, { recursive: true, force: true });
        return this.loadLegacy();
      }
      // Migrated, but removing the earlier file did not happen.
      fs.rmSync(legacy, { force: true });
    }
    if (st.kind === 'damaged') this.log(`The saved timeline's state could not be read (${st.why}); its changes are restored as pending.`);
    const state = st.kind === 'ok' ? st.state : undefined;
    const records = this.scanLogs();
    if (records === undefined) return undefined;
    const first = state?.first ?? -Infinity;
    const live = records.filter((r) => r.o >= first).sort((a, b) => a.o - b.o);
    this.next = records.reduce((n, r) => Math.max(n, r.o + 1), state?.next ?? 1);
    for (const r of records) {
      if (r.o < first) continue;
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
      },
    };
  }

  /**
   * Reads every segment, oldest first per lane, checking each change's text.
   * A damaged change ends its lane's log there. Undefined when a segment was
   * written by a newer version.
   */
  private scanLogs(): LoadedRecord[] | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(this.path);
    } catch {
      return [];
    }
    const byLane = new Map<string, Array<{ file: string; n: number; scan: SegmentScan }>>();
    for (const name of names) {
      const file = path.join(this.path, name);
      if (name.endsWith('.tmp')) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const m = SEGMENT_NAME.exec(name);
      if (!m) continue;
      const scan = scanSegment(file);
      if (scan.newer !== undefined) {
        this.log(`The saved timeline was saved by a newer version of Agent Typewriter (log version ${scan.newer}, this one reads up to ${LOG_VERSION}). Starting empty.`);
        this.forget();
        this.setAside(this.historyAside());
        return undefined;
      }
      const n = Number(m[2]);
      this.segmentNumbers.set(m[1], Math.max(this.segmentNumbers.get(m[1]) ?? 1, n + 1));
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
      let damage: string | undefined;
      let last = -Infinity;
      for (const { file, n, scan } of list) {
        if (damage !== undefined) {
          // Its changes came after the lost ones.
          lost += scan.records.length;
          this.doomed.push(file);
          continue;
        }
        let records = scan.records;
        let end = scan.end;
        damage = scan.damage;
        const disordered = records.findIndex((r, i) => r.o <= (i > 0 ? records[i - 1].o : last));
        if (disordered !== -1) {
          damage = 'its changes are out of order';
          end = records[disordered].start;
          records = records.slice(0, disordered);
        }
        if (damage !== undefined) {
          lost++;
          try {
            fs.truncateSync(file, end);
          } catch (err) {
            this.log(`Could not cut the damaged end off ${path.basename(file)}: ${errorText(err)}`);
          }
        }
        const segment: Segment = { file, n, bytes: end, holders: records.map(() => undefined) };
        log.segments.push(segment);
        records.forEach((r, index) => {
          last = r.o;
          const holder = new TextHolder(r.c, () => readText(file, r.at, r.b, r.a, r.crc), this);
          out.push({ o: r.o, lane: id, fields: r.fields, holder, segment, index });
        });
      }
      if (damage !== undefined) this.log(`The saved timeline was cut short (${damage}); left out ${lost} change(s) that were not completely saved.`);
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
    for (const e of this.timeline.all()) {
      const holder = textHolder(e);
      if (holder.owner === this) holder.pin();
    }
    this.forget();
    this.aside = undefined;
    this.migrating = false;
    for (const f of [DIR, ASIDE, LEGACY, LEGACY + '.tmp', LEGACY + '.sync.tmp', LEGACY_UNREADABLE]) {
      try {
        fs.rmSync(path.join(this.folder, f), { recursive: true, force: true });
      } catch {
        // Nothing to remove.
      }
    }
  }

  dispose(): void {
    if (this.isRunning) this.flushSync();
    this.stop();
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
    // Still dirty, so the next save (at the latest the final one) tries the move again.
    if (!this.canSave()) return;
    this.dirty = false;
    try {
      this.write();
    } catch (err) {
      this.dirty = true;
      this.log(`Could not save the timeline: ${errorText(err)}`);
    }
  }

  private write(): void {
    const events = this.timeline.all();
    fs.mkdirSync(this.path, { recursive: true });
    if (this.markGone(events)) this.rewriteAll();
    const appended = this.append(events.filter((e) => !this.orders.has(textHolder(e))));
    this.compact();
    const state = this.stateOf(events);
    const { savedAt, ...rest } = state;
    const json = JSON.stringify(rest);
    if (json !== this.lastState || appended > 0 || this.migrating) {
      const file = path.join(this.path, STATE);
      fs.writeFileSync(file + '.tmp', JSON.stringify(state));
      fs.renameSync(file + '.tmp', file);
      this.lastState = json;
    }
    if (this.migrating) {
      fs.rmSync(path.join(this.folder, LEGACY), { force: true });
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

  /** Writes every lane again from scratch: the kept changes' text comes back into memory and every segment goes. */
  private rewriteAll(): void {
    for (const h of this.orders.keys()) h.pin();
    for (const log of this.lanes.values()) for (const s of log.segments) this.doomed.push(s.file);
    this.lanes.clear();
    this.orders.clear();
  }

  /** Appends `events`, oldest first, one write per segment, then lets go of their text. Returns how many were written. */
  private append(events: readonly ChangeEvent[]): number {
    if (events.length === 0) return 0;
    const batches = new Map<Segment, { parts: Buffer[]; size: number; isNew: boolean; records: Array<{ holder: TextHolder; order: number; at: number; b: number; a: number; crc: number }> }>();
    const batchOf = (segment: Segment, isNew: boolean) => {
      let batch = batches.get(segment);
      if (!batch) batches.set(segment, (batch = { parts: [], size: segment.bytes, isNew, records: [] }));
      return batch;
    };
    for (const e of events) {
      const log = this.laneLog(laneOf(e));
      let segment = log.segments[log.segments.length - 1];
      let batch = segment && batchOf(segment, false);
      if (!segment || batch.size >= this.segmentBytes) {
        segment = this.newSegment(log);
        batch = batchOf(segment, true);
        const header = Buffer.from(JSON.stringify({ format: LOG_FORMAT, version: LOG_VERSION, lane: log.id }) + '\n', 'utf8');
        batch.parts.push(header);
        batch.size += header.length;
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
        fs.appendFileSync(segment.file, Buffer.concat(batch.parts));
      } catch (err) {
        failure ??= err;
        // Leave no partial record for later appends to follow.
        try {
          if (batch.isNew) fs.rmSync(segment.file, { force: true });
          else fs.truncateSync(segment.file, segment.bytes);
        } catch {
          // Load cuts a damaged end off.
        }
        if (batch.isNew) {
          const log = [...this.lanes.values()].find((l) => l.segments.includes(segment));
          if (log) log.segments.splice(log.segments.indexOf(segment), 1);
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

  /** Deletes segments with no change left in the buffer, and forgets lanes with no segment left. */
  private compact(): void {
    for (const [id, log] of this.lanes) {
      log.segments = log.segments.filter((s) => {
        if (s.holders.some((h) => h !== undefined)) return true;
        this.doomed.push(s.file);
        return false;
      });
      if (log.segments.length === 0) this.lanes.delete(id);
    }
    this.removeDoomed();
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
    };
  }

  /** Forgets what is known about the log on disk. */
  private forget(): void {
    this.lanes.clear();
    this.orders.clear();
    this.doomed = [];
    this.lastState = '';
    this.next = 1;
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
  /** Why the segment ends early, if it does. */
  damage?: string;
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
  if (!isObject(head) || head.format !== LOG_FORMAT || typeof head.lane !== 'string' || !isInt(head.version)) return { records: [], end: 0 };
  if ((head.version as number) > LOG_VERSION) return { records: [], end: 0, newer: head.version as number };
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
  return { lane: head.lane as string, records, end: pos, ...(damage !== undefined && { damage }) };
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
