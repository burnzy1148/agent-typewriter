import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { parseSession, toSession, SessionFormatError, type Session, type Timeline } from './timeline';

const gzip = promisify(zlib.gzip);

/** Change text kept in the saved timeline; older events beyond it are left out. */
export const MAX_SAVED_TEXT_CHARS = 64 * 1024 * 1024;
/** How often a changing timeline is saved at most. */
export const SAVE_INTERVAL_MS = 2000;

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

const FILE = 'timeline.json.gz';
const UNREADABLE = 'timeline.unreadable.json.gz';

/**
 * Keeps the timeline in a workspace storage folder so a reload does not lose
 * it. Plain Node on purpose: the folder is VS Code's per-workspace extension
 * storage, never the workspace itself.
 *
 * Saving is throttled rather than debounced, so continuous playback still
 * saves every SAVE_INTERVAL_MS. Each write goes to a temp file first and is
 * renamed into place, so the saved file is always a complete session.
 */
export class TimelineStore {
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing: Promise<void> | undefined;
  private subscription: { dispose(): void } | undefined;
  /** JSON of the last saved event list, keyed by its first and last seq (events are immutable). */
  private cachedEvents: { key: string; json: string } | undefined;
  private lastOmitted = 0;
  /** Bumped by every write; a slower async write that was overtaken does not replace a newer file. */
  private writeId = 0;
  /** writeId of the async write in flight, if any. */
  private writingId: number | undefined;
  /** The saved file could not be read or moved aside; saving waits until it can be moved. */
  private unreadableInPlace = false;

  constructor(
    private readonly folder: string,
    private readonly timeline: Timeline,
    private readonly log: (line: string) => void,
    private readonly intervalMs = SAVE_INTERVAL_MS,
    private readonly maxTextChars = MAX_SAVED_TEXT_CHARS,
  ) {}

  get path(): string {
    return path.join(this.folder, FILE);
  }

  get isRunning(): boolean {
    return this.subscription !== undefined;
  }

  /**
   * Reads the saved session. A missing file is undefined; an unreadable one is
   * logged, moved aside so it is not overwritten, and also undefined.
   */
  load(): Session | undefined {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.log(`Could not read the saved timeline (${errorText(err)}). Starting empty.`);
      this.setAside();
      return undefined;
    }
    try {
      return sessionFromBytes(bytes);
    } catch (err) {
      this.log(`Could not restore the saved timeline: ${err instanceof Error ? err.message : String(err)}. Starting empty.`);
      this.setAside();
      return undefined;
    }
  }

  /** Moves an unreadable saved file aside. If that fails, saving holds off so the file is not replaced. */
  private setAside(): void {
    if (this.moveAside()) return;
    this.unreadableInPlace = true;
    this.log(`Could not move it to ${UNREADABLE} either; the timeline will not be saved until it can be.`);
  }

  private moveAside(): boolean {
    try {
      fs.renameSync(this.path, path.join(this.folder, UNREADABLE));
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  /** False while an unreadable saved file is still in the way of saving. */
  private canSave(): boolean {
    if (this.unreadableInPlace && this.moveAside()) {
      this.unreadableInPlace = false;
      this.log(`Moved the unreadable saved timeline to ${UNREADABLE}.`);
    }
    return !this.unreadableInPlace;
  }

  /** Saves on every timeline change from now on, and once right away. */
  start(): void {
    if (this.subscription) return;
    this.subscription = this.timeline.onDidChange(() => this.markDirty());
    this.markDirty();
  }

  /** Stops saving. Pending changes are not written, and a write in flight does not replace the file. */
  stop(): void {
    this.writeId++;
    this.subscription?.dispose();
    this.subscription = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
  }

  /** Writes now if anything changed since the last save, and waits for it. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.writing;
    // The awaited write re-arms the timer for changes made meanwhile; this write covers them.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) await this.write();
  }

  /** Synchronous final save, for deactivation. Also covers an async write still in flight, which may never finish. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const inFlight = this.writing !== undefined && this.writingId === this.writeId;
    if (!this.dirty && !inFlight) return;
    if (!this.canSave()) return;
    this.dirty = false;
    // Overtakes the write in flight, which then skips its rename.
    this.writeId++;
    try {
      fs.mkdirSync(this.folder, { recursive: true });
      const tmp = this.path + '.sync.tmp';
      fs.writeFileSync(tmp, zlib.gzipSync(this.serialize()));
      fs.renameSync(tmp, this.path);
    } catch (err) {
      this.log(`Could not save the timeline: ${String(err)}`);
    }
  }

  /** Removes the saved timeline, including a copy moved aside as unreadable. */
  deleteSaved(): void {
    for (const f of [this.path, this.path + '.tmp', this.path + '.sync.tmp', path.join(this.folder, UNREADABLE)]) {
      try {
        fs.rmSync(f, { force: true });
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
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.dirty) void this.write();
    }, this.intervalMs);
  }

  private write(): Promise<void> {
    // Still dirty, so the next save (at the latest the final one) tries the move again.
    if (!this.canSave()) return Promise.resolve();
    this.dirty = false;
    const id = ++this.writeId;
    const json = this.serialize();
    this.writingId = id;
    this.writing = (async () => {
      const tmp = this.path + '.tmp';
      try {
        await fs.promises.mkdir(this.folder, { recursive: true });
        await fs.promises.writeFile(tmp, await gzip(json));
        // Synchronous from the check to the rename, so a final save in between cannot be overwritten.
        if (id === this.writeId) fs.renameSync(tmp, this.path);
        // Overtaken or stopped: leave no copy of the code text behind. Writes are serialized, so tmp is ours.
        else fs.rmSync(tmp, { force: true });
      } catch (err) {
        this.log(`Could not save the timeline: ${String(err)}`);
      }
    })().finally(() => {
      this.writing = undefined;
      this.writingId = undefined;
      // Changes that came in while writing get their own save.
      if (this.dirty && this.isRunning) this.markDirty();
    });
    return this.writing;
  }

  private serialize(): string {
    const { session, omitted } = toSession(this.timeline, this.maxTextChars);
    if (omitted > 0 && omitted !== this.lastOmitted) {
      this.log(`The saved timeline leaves out the ${omitted} oldest change(s) to stay within ${Math.round(this.maxTextChars / 1024 / 1024)} MB of text.`);
    }
    this.lastOmitted = omitted;
    const events = session.events;
    const key = events.length === 0 ? '' : `${events[0].seq}-${events[events.length - 1].seq}`;
    if (this.cachedEvents?.key !== key) this.cachedEvents = { key, json: JSON.stringify(events) };
    const { format, version, savedAt, cursor, highlightsFrom } = session;
    const envelope = JSON.stringify({ format, version, savedAt, cursor, ...(highlightsFrom && { highlightsFrom }) });
    return envelope.slice(0, -1) + `,"events":${this.cachedEvents.json}}`;
  }
}

function errorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const message = err instanceof Error ? err.message : String(err);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}
