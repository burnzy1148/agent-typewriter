import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { parseSession, toSession, type Session, type Timeline } from './timeline';

const gzip = promisify(zlib.gzip);

/** Change text kept in the saved timeline; older events beyond it are left out. */
export const MAX_SAVED_TEXT_CHARS = 64 * 1024 * 1024;
/** How often a changing timeline is saved at most. */
export const SAVE_INTERVAL_MS = 2000;

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
    } catch {
      return undefined;
    }
    try {
      return parseSession(JSON.parse(zlib.gunzipSync(bytes).toString('utf8')));
    } catch (err) {
      this.log(`Could not restore the saved timeline: ${err instanceof Error ? err.message : String(err)}. Starting empty.`);
      try {
        fs.renameSync(this.path, path.join(this.folder, UNREADABLE));
      } catch {
        // Leave it; the next save replaces it.
      }
      return undefined;
    }
  }

  /** Saves on every timeline change from now on, and once right away. */
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

  /** Writes now if anything changed since the last save, and waits for it. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.writing;
    if (this.dirty) await this.write();
  }

  /** Synchronous final save, for deactivation. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
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

  /** Removes the saved timeline. */
  deleteSaved(): void {
    for (const f of [this.path, this.path + '.tmp', this.path + '.sync.tmp']) {
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
    this.dirty = false;
    const id = ++this.writeId;
    const json = this.serialize();
    this.writing = (async () => {
      try {
        await fs.promises.mkdir(this.folder, { recursive: true });
        const tmp = this.path + '.tmp';
        await fs.promises.writeFile(tmp, await gzip(json));
        // Synchronous from the check to the rename, so a final save in between cannot be overwritten.
        if (id === this.writeId) fs.renameSync(tmp, this.path);
      } catch (err) {
        this.log(`Could not save the timeline: ${String(err)}`);
      }
    })().finally(() => {
      this.writing = undefined;
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
    const envelope = JSON.stringify({ format: session.format, version: session.version, savedAt: session.savedAt, cursor: session.cursor });
    return envelope.slice(0, -1) + `,"events":${this.cachedEvents.json}}`;
  }
}
