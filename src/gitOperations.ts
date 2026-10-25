/**
 * Tells the writes a git operation made (merge, pull, checkout, rebase,
 * cherry-pick, revert, reset to another commit, stash push and pop) from
 * writes anyone else made, so the recorder can skip them.
 *
 * A write is git's only when git itself shows it: a ref or state file in the
 * checkout's git directory changed, the operation changed that path's index
 * entry (or the stash recorded the path), and the file agrees with git's
 * result. A change to the index alone, such as a background `git status`,
 * `git add` or `git restore`, is never an operation.
 *
 * Markers are stat'ed when a write is classified, never watched: watchers can
 * miss a short-lived `index.lock` and may not see `.git` at all. Like the rest
 * of the extension's git use, every command only reads (--no-optional-locks).
 * Paths are relative to the directory git runs in, forward slashes.
 */
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { CAPTURE_SKEW_MS, isGitUnavailable, parseLsFiles, runGit, type GitRunner, type LsFilesEntry } from './gitBaseline';

/** Files and directories in a checkout's own git directory that change when an operation runs. */
export const GIT_DIR_MARKERS = [
  'HEAD',
  'ORIG_HEAD',
  'logs/HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'AUTO_MERGE',
  'rebase-merge',
  'rebase-apply',
] as const;

/** Markers in the repository's common git directory; the branch HEAD names is added per look. */
export const COMMON_DIR_MARKERS = ['packed-refs', 'reftable/tables.list', 'refs/stash', 'logs/refs/stash'] as const;

const STASH_MARKERS = new Set(['refs/stash', 'logs/refs/stash']);

/** State files an operation that stops leaves behind, and what to call it when one appears. */
const STATE_LABELS: ReadonlyArray<[string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['REBASE_HEAD', 'rebase'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
];

export interface GitWatchTiming {
  /** How often a held write looks again while `index.lock` exists. */
  pollMs: number;
  /** Longest wait on `index.lock`; a stale lock past this is ignored. */
  lockMaxMs: number;
  /** Wait for a ref marker after the index changed alone, since git updates HEAD just after the index. */
  graceMs: number;
  /** Marker stats younger than this are reused by the next look. */
  lookCacheMs: number;
  /** How long operation records are kept for late flushes. */
  retainMs: number;
  /** How far before its earliest changed marker an operation's span starts. */
  leadMs: number;
  /** Clock slack before a span's start. */
  skewMs: number;
  /**
   * Slack after a span's end, the last marker git wrote. Git writes the
   * working tree before the index and refs, on the same clock, so this only
   * covers rounding; an edit made after the operation stays outside it.
   */
  endSlackMs: number;
}

export const DEFAULT_TIMING: GitWatchTiming = {
  pollMs: 100,
  lockMaxMs: 10_000,
  graceMs: 250,
  lookCacheMs: 20,
  retainMs: 60_000,
  leadMs: 10_000,
  skewMs: CAPTURE_SKEW_MS,
  endSlackMs: 50,
};

export interface GitWatchClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: GitWatchClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Index entries per path in compact form: stage, mode and a blob prefix for each stage, enough to see any change. */
export type IndexDigest = Map<string, string>;

/** Groups parsed `ls-files -s` entries by path, stages in order. */
export function groupEntries(entries: LsFilesEntry[]): Map<string, LsFilesEntry[]> {
  const byPath = new Map<string, LsFilesEntry[]>();
  for (const e of entries) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  for (const list of byPath.values()) list.sort((a, b) => a.stage - b.stage);
  return byPath;
}

export function digestIndex(byPath: Map<string, LsFilesEntry[]>): IndexDigest {
  const digest: IndexDigest = new Map();
  for (const [path, list] of byPath) digest.set(path, list.map((e) => `${e.stage}${e.mode}${e.sha.slice(0, 16)}`).join(' '));
  return digest;
}

/** Paths added, removed, or whose blob, mode or stages differ between two index states. */
export function changedPaths(before: IndexDigest, after: IndexDigest): Set<string> {
  const changed = new Set<string>();
  for (const [path, d] of after) if (before.get(path) !== d) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return changed;
}

/** What one settled operation wrote, as far as git can vouch for it. */
export interface GitOperation {
  /** What git did, for the output channel: `merge f`, `checkout`, `stash pop`, ... */
  label: string;
  /** Writes before this are not the operation's. */
  from: number;
  /** Writes after this are not the operation's. */
  to: number;
  /** Paths whose write is git's when the file exists afterwards. */
  present: Set<string>;
  /** Paths whose write is git's when the file is gone afterwards. */
  absent: Set<string>;
  /** Index blob of each present path git left clean at stage 0. */
  blobs: Map<string, string>;
  /**
   * When each of those blobs was written as a loose object, if it was. Git
   * writes a file from a blob that already exists; `git add` and `commit -a`
   * make the blob from the file after it was written. A blob newer than the
   * file means git took the file in, not that git wrote it.
   */
  blobAt: Map<string, number>;
  /** Writes skipped so far, for the summary line. */
  skipped: number;
}

export interface OperationInput {
  label: string;
  from: number;
  to: number;
  /** Paths whose index entry the operation changed, plus the paths a pushed stash recorded. */
  candidates: Iterable<string>;
  /** Index entries after the operation. */
  after: Map<string, LsFilesEntry[]>;
  /** Paths whose working-tree text differs from the index after the operation. */
  dirty: Set<string>;
  /** Paths a popped stash recorded: git's whatever the index says, since a pop leaves them unstaged. */
  popped?: Iterable<string>;
}

/**
 * A candidate is git's when the file agrees with the index after the
 * operation: still conflicted, clean at stage 0, or gone from the index (and
 * so from disk).
 */
export function buildOperation(input: OperationInput): GitOperation {
  const op: GitOperation = {
    label: input.label,
    from: input.from,
    to: input.to,
    present: new Set(),
    absent: new Set(),
    blobs: new Map(),
    blobAt: new Map(),
    skipped: 0,
  };
  for (const path of input.candidates) {
    const entries = input.after.get(path);
    if (!entries) op.absent.add(path);
    else if (entries.some((e) => e.stage > 0)) op.present.add(path);
    else if (!input.dirty.has(path)) {
      op.present.add(path);
      op.blobs.set(path, entries[0].sha);
    }
  }
  for (const path of input.popped ?? []) {
    op.present.add(path);
    op.absent.add(path);
  }
  return op;
}

/**
 * The operation that made a write to `path` at `writtenAt`, leaving it
 * existing or not, if any did. `ops` are oldest first; spans can overlap
 * (a pop right after a push), so the newest that fits wins. `lateMs`
 * stretches the span's end, for a delete timed by when the watcher reported it.
 */
export function findGitWrite(ops: readonly GitOperation[], path: string, writtenAt: number, exists: boolean, lateMs = 0): GitOperation | undefined {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (writtenAt < op.from || writtenAt > op.to + lateMs || !(exists ? op.present : op.absent).has(path)) continue;
    if (exists && (op.blobAt.get(path) ?? -Infinity) > writtenAt) continue;
    return op;
  }
  return undefined;
}

/** A stat of every marker: whether each exists, and its mtime and size. */
export interface MarkerLook {
  /** When the look was taken. */
  at: number;
  /** Fingerprint of the ref and state markers. */
  markers: string;
  /** Fingerprint of the stash markers alone. */
  stash: string;
  /** Fingerprint of `index`. */
  index: string;
  indexMtime: number;
  lock: boolean;
  /** Marker name to mtime, for the ones that exist. */
  mtimes: Map<string, number>;
  /**
   * For markers that do not exist, the mtime of the directory they would be
   * in: removing a file stamps its directory, and a removal can be the last
   * thing an operation does (a pop drops `refs/stash` after restoring files).
   */
  goneAt: Map<string, number>;
}

/**
 * The earliest and latest mtimes of markers that differ between two looks.
 * A removed marker counts by its directory's mtime, toward the latest only:
 * that directory may have changed long before for other reasons.
 */
export function changeSpan(before: MarkerLook, after: MarkerLook): { earliest?: number; latest?: number } {
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const [name, mtime] of after.mtimes) {
    if (before.mtimes.get(name) === mtime) continue;
    if (earliest === undefined || mtime < earliest) earliest = mtime;
    if (latest === undefined || mtime > latest) latest = mtime;
  }
  for (const name of before.mtimes.keys()) {
    const removedAt = after.mtimes.has(name) ? undefined : after.goneAt.get(name);
    if (removedAt !== undefined && (latest === undefined || removedAt > latest)) latest = removedAt;
  }
  return { earliest, latest };
}

/** Splits `stash list --format=%H` output into commits, newest first. */
export function parseStashList(out: string): string[] {
  return out.split('\n').filter(Boolean);
}

/** What happened to the stash between two lists: a push of the new top, a pop or drop of the old top, or neither. */
export function stashChange(before: readonly string[], after: readonly string[]): { pushed?: string; popped?: string } {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (after.length === before.length + 1 && same(after.slice(1), before)) return { pushed: after[0] };
  if (before.length === after.length + 1 && same(before.slice(1), after)) return { popped: before[0] };
  return {};
}

/**
 * What git did between two looks: an operation that stopped names itself by
 * the state file it left, anything else by its reflog line, which is only
 * read when the reflog changed (a stopped merge writes none).
 */
export function operationLabel(before: MarkerLook, after: MarkerLook, reflogTail: string): string {
  for (const [marker, label] of STATE_LABELS) if (after.mtimes.has(marker) && !before.mtimes.has(marker)) return label;
  const reflogMoved = after.mtimes.get('logs/HEAD') !== before.mtimes.get('logs/HEAD');
  return (reflogMoved && reflogLabel(reflogTail)) || 'git operation';
}

/** A commit, amend or merge commit only records what is staged; it writes no working-tree files. */
export function writesNoFiles(label: string): boolean {
  return /^commit\b/.test(label);
}

/** What the last reflog line says git did, up to its first colon: `merge f`, `checkout`, `pull`, `reset`. */
export function reflogLabel(tail: string): string | undefined {
  const line = tail.split('\n').filter(Boolean).at(-1);
  const message = line?.slice(line.indexOf('\t') + 1);
  if (!message || message === line) return undefined;
  const colon = message.indexOf(':');
  return (colon === -1 ? message : message.slice(0, colon)).trim() || undefined;
}

export type WatchStatus = 'ok' | 'not-repo' | 'unavailable';

interface WatchState {
  takenAt: number;
  look: MarkerLook;
  index: IndexDigest;
  stash: string[];
}

/**
 * Follows git operations in one checkout and classifies its writes. Each
 * recorded checkout (lane) gets its own; `root` is the directory git runs in.
 */
export class GitOperationWatch {
  /** Why git could not run, once it could not; the watch then classifies nothing. */
  failure: string | undefined;
  /** Why git failed while it could run, the latest time; writes are recorded meanwhile. */
  problem: string | undefined;
  private readonly ready: Promise<WatchStatus>;
  private gitDir = '';
  private commonDir = '';
  private state: WatchState | undefined;
  private ops: GitOperation[] = [];
  private refreshing: Promise<void> | undefined;
  private looking: Promise<MarkerLook> | undefined;
  private lastLook: MarkerLook | undefined;
  private lockSeenAt: number | undefined;
  private disposed = false;

  constructor(
    readonly root: string,
    private readonly run: GitRunner = runGit,
    private readonly clock: GitWatchClock = realClock,
    private readonly timing: GitWatchTiming = DEFAULT_TIMING,
  ) {
    this.ready = this.init();
  }

  /** Settles once the initial index state is read. */
  status(): Promise<WatchStatus> {
    return this.ready;
  }

  /** Stops classifying; the state is dropped. */
  dispose(): void {
    this.disposed = true;
    this.state = undefined;
    this.ops = [];
  }

  /**
   * The operation that made this write, after waiting for any operation in
   * progress to settle; undefined when it is not git's or git cannot tell.
   * `writtenAt` is the file's mtime, `exists` whether the file is there now,
   * and `lateMs` how much later than git's last marker `writtenAt` may be.
   * `onWait` hears, once, that the answer will take a wait or a git call.
   */
  async classify(path: string, writtenAt: number, exists: boolean, lateMs = 0, onWait?: () => void): Promise<GitOperation | undefined> {
    if ((await this.ready) !== 'ok' || this.disposed) return undefined;
    await this.settle(onWait);
    if (!this.state) return undefined;
    const cutoff = this.clock.now() - this.timing.retainMs;
    this.ops = this.ops.filter((op) => op.to >= cutoff);
    return findGitWrite(this.ops, path, writtenAt, exists, lateMs);
  }

  private async init(): Promise<WatchStatus> {
    try {
      const out = (await this.run(['rev-parse', '--absolute-git-dir', '--git-common-dir'], this.root)).toString('utf8').split('\n');
      if (!out[0] || !out[1]) return 'not-repo';
      this.gitDir = out[0];
      this.commonDir = nodePath.resolve(this.root, out[1]);
    } catch (err) {
      return this.failed(err) ? 'unavailable' : 'not-repo';
    }
    try {
      const look = await this.look(true);
      const [entries, stash] = await Promise.all([this.readIndex(), this.readStash()]);
      if (this.disposed) return 'ok';
      this.state = { takenAt: this.clock.now(), look, index: digestIndex(entries), stash };
      return 'ok';
    } catch (err) {
      if (this.failed(err)) return 'unavailable';
      this.problem = String((err as Error).message ?? err);
      return 'not-repo';
    }
  }

  /** Records why git could not run; true when that is the error. */
  private failed(err: unknown): boolean {
    if (!isGitUnavailable(err)) return false;
    this.failure ??= String((err as Error).message ?? err);
    this.state = undefined;
    return true;
  }

  /** Waits out `index.lock` and the HEAD-after-index gap, then refreshes once if a ref or state marker changed. */
  private async settle(onWait?: () => void): Promise<void> {
    const deadline = this.clock.now() + this.timing.lockMaxMs;
    let graced = false;
    let waiting = false;
    const wait = () => {
      if (!waiting) onWait?.();
      waiting = true;
    };
    for (;;) {
      if (!this.state) return;
      const look = await this.look();
      if (look.lock && this.clock.now() < deadline) {
        this.lockSeenAt ??= look.at;
        wait();
        await this.clock.sleep(this.timing.pollMs);
        continue;
      }
      const state = this.state;
      if (!state) return;
      if (look.markers !== state.look.markers) {
        wait();
        await this.refresh();
        return;
      }
      if (look.index !== state.look.index) {
        const age = this.clock.now() - look.indexMtime;
        if (!graced && age < this.timing.graceMs) {
          graced = true;
          wait();
          await this.clock.sleep(this.timing.graceMs - age);
          continue;
        }
        // The index changed alone: no operation. Later looks need not wait for it again.
        state.look = { ...state.look, index: look.index, indexMtime: look.indexMtime };
      }
      return;
    }
  }

  /** Reads the index and stash after an operation and records what it wrote. One at a time per checkout. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const prev = this.state;
    if (!prev) return;
    let look: MarkerLook | undefined;
    try {
      look = await this.look(true);
      if (look.markers === prev.look.markers) return;
      const stashMoved = look.stash !== prev.look.stash;
      const [byPath, dirtyOut, stash, labelTail] = await Promise.all([
        this.readIndex(),
        this.run(['diff', '--name-only', '--relative', '-z'], this.root),
        stashMoved ? this.readStash() : Promise.resolve(prev.stash),
        this.reflogTail(),
      ]);
      if (this.disposed || this.state !== prev) return;
      const index = digestIndex(byPath);
      const candidates = changedPaths(prev.index, index);
      // The stash is shared by every worktree; a push or pop writes the index of the one it ran in.
      const { pushed, popped } = stashMoved && look.index !== prev.look.index ? stashChange(prev.stash, stash) : {};
      if (pushed) for (const p of await this.stashPaths(pushed)) candidates.add(p);
      const poppedPaths = popped ? await this.stashPaths(popped) : [];
      if (this.disposed || this.state !== prev) return;
      const now = this.clock.now();
      const span = changeSpan(prev.look, look);
      const start = Math.min(this.lockSeenAt ?? Infinity, span.earliest ?? now) - this.timing.leadMs;
      const end = Math.max(span.latest ?? 0, look.index !== prev.look.index ? look.indexMtime : 0) || now;
      const label = pushed ? 'stash push' : popped ? 'stash pop' : operationLabel(prev.look, look, labelTail);
      const op = buildOperation({
        label,
        from: Math.max(prev.takenAt, start) - this.timing.skewMs,
        to: end + this.timing.endSlackMs,
        candidates,
        after: byPath,
        dirty: new Set(dirtyOut.toString('utf8').split('\0').filter(Boolean)),
        popped: poppedPaths,
      });
      if (!writesNoFiles(label) && (op.present.size > 0 || op.absent.size > 0)) {
        await this.stampBlobs(op);
        if (this.disposed || this.state !== prev) return;
        this.ops.push(op);
      }
      this.state = { takenAt: now, look, index, stash };
      this.lockSeenAt = undefined;
    } catch (err) {
      if (this.failed(err) || !look || this.state !== prev) return;
      // Git failing for another reason: this operation goes unrecognized, so
      // its writes are recorded, and git is not asked again until a marker changes.
      this.problem = String((err as Error).message ?? err);
      this.state = { ...prev, look };
      this.lockSeenAt = undefined;
    }
  }

  /** Fills `op.blobAt` from the loose objects of its blobs; a packed or missing object is old. */
  private async stampBlobs(op: GitOperation): Promise<void> {
    const entries = [...op.blobs];
    for (let i = 0; i < entries.length; i += 256) {
      await Promise.all(
        entries.slice(i, i + 256).map(async ([path, sha]) => {
          const s = await statOf(nodePath.join(this.commonDir, 'objects', sha.slice(0, 2), sha.slice(2)));
          if (s) op.blobAt.set(path, s.mtimeMs);
        }),
      );
    }
  }

  private async readIndex(): Promise<Map<string, LsFilesEntry[]>> {
    return groupEntries(parseLsFiles((await this.run(['ls-files', '-s', '-z'], this.root)).toString('utf8')));
  }

  private async readStash(): Promise<string[]> {
    return parseStashList((await this.run(['stash', 'list', '--format=%H'], this.root)).toString('utf8'));
  }

  /** Paths a stash commit recorded: its changes against the commit it was made on, and its untracked files. */
  private async stashPaths(commit: string): Promise<string[]> {
    const [changed, untracked] = await Promise.all([
      this.run(['diff-tree', '-r', '--name-only', '--relative', '-z', `${commit}^1`, commit], this.root),
      this.run(['ls-tree', '-r', '--name-only', '-z', `${commit}^3`], this.root).catch(() => Buffer.alloc(0)),
    ]);
    return [...changed.toString('utf8').split('\0'), ...untracked.toString('utf8').split('\0')].filter(Boolean);
  }

  /** The last few KB of `logs/HEAD`, or '' without a reflog. */
  private async reflogTail(): Promise<string> {
    const file = nodePath.join(this.gitDir, 'logs', 'HEAD');
    const handle = await fsp.open(file, 'r').catch(() => undefined);
    if (!handle) return '';
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 4096);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /** Stats every marker, reusing a look younger than `lookCacheMs` unless `fresh`. */
  private look(fresh = false): Promise<MarkerLook> {
    const last = this.lastLook;
    if (!fresh && last && this.clock.now() - last.at < this.timing.lookCacheMs) return Promise.resolve(last);
    if (!fresh && this.looking) return this.looking;
    const p = this.doLook().then((look) => {
      this.lastLook = look;
      return look;
    });
    if (!fresh) {
      this.looking = p;
      void p.finally(() => {
        if (this.looking === p) this.looking = undefined;
      }).catch(() => {});
    }
    return p;
  }

  private async doLook(): Promise<MarkerLook> {
    const at = this.clock.now();
    const branch = await branchRef(nodePath.join(this.gitDir, 'HEAD'));
    const names: Array<[string, string]> = [
      ...GIT_DIR_MARKERS.map((m): [string, string] => [m, nodePath.join(this.gitDir, m)]),
      ...COMMON_DIR_MARKERS.map((m): [string, string] => [m, nodePath.join(this.commonDir, m)]),
      ...(branch ? [[branch, nodePath.join(this.commonDir, branch)] as [string, string]] : []),
    ];
    const [stats, index, lock] = await Promise.all([
      Promise.all(names.map(([, file]) => statOf(file))),
      statOf(nodePath.join(this.gitDir, 'index')),
      statOf(nodePath.join(this.gitDir, 'index.lock')),
    ]);
    const dirs = new Map<string, Promise<number | undefined>>();
    const dirOf = (file: string) => {
      const dir = nodePath.dirname(file);
      if (!dirs.has(dir)) dirs.set(dir, statOf(dir).then((d) => d?.mtimeMs));
      return dirs.get(dir)!;
    };
    const goneAt = new Map<string, number>();
    await Promise.all(
      names.map(async ([name, file], i) => {
        if (stats[i]) return;
        const at = await dirOf(file);
        if (at !== undefined) goneAt.set(name, at);
      }),
    );
    const mtimes = new Map<string, number>();
    const markers: string[] = [];
    const stash: string[] = [];
    names.forEach(([name], i) => {
      const s = stats[i];
      const fp = s ? `${name}:${s.mtimeMs}:${s.size}` : `${name}:-`;
      markers.push(fp);
      if (STASH_MARKERS.has(name)) stash.push(fp);
      if (s) mtimes.set(name, s.mtimeMs);
    });
    return {
      at,
      markers: markers.join('|'),
      stash: stash.join('|'),
      index: index ? `${index.mtimeMs}:${index.size}` : '-',
      indexMtime: index?.mtimeMs ?? 0,
      lock: lock !== undefined,
      mtimes,
      goneAt,
    };
  }
}

async function statOf(file: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  return fsp.stat(file).then(
    (s) => ({ mtimeMs: s.mtimeMs, size: s.size }),
    () => undefined,
  );
}

/** The ref a symbolic HEAD names, like `refs/heads/main`; undefined when HEAD is detached or unreadable. */
async function branchRef(headFile: string): Promise<string | undefined> {
  const text = await fsp.readFile(headFile, 'utf8').catch(() => '');
  const m = /^ref: (refs\/\S+)/.exec(text);
  return m?.[1];
}
