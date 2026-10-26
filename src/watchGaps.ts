import * as fs from 'node:fs';
import { MAX_LANES } from './lanes';

/** A watch of one directory; `close` stops it. */
export interface DirWatch {
  close(): void;
}

/**
 * Watches one directory, not the ones inside it, naming each entry that
 * changes: 'rename' for one created, deleted or moved, 'change' for one
 * written. Throws when the directory cannot be watched.
 */
export type WatchDir = (fsPath: string, onEntry: (name: string, kind: 'rename' | 'change') => void, onError: (err: unknown) => void) => DirWatch;

/** A WatchDir on Node's fs.watch, which is one inotify watch on Linux. */
export const nodeWatchDir: WatchDir = (fsPath, onEntry, onError) => {
  const watcher = fs.watch(fsPath, { persistent: false }, (kind, name) => {
    if (name) onEntry(name, kind);
  });
  watcher.on('error', onError);
  return watcher;
};

/** Most directories one lane has watched, so a lane's large tree never takes watches from another lane. */
export const GAP_WATCH_LIMIT = 2000;

/**
 * Most directories watched at once across lanes: a quarter of the inotify
 * watches the system allows a user, which VS Code's own watcher and other
 * programs share, and no more than every lane's limit together.
 */
export function shareOfSystemWatches(file = '/proc/sys/fs/inotify/max_user_watches'): number {
  const most = MAX_LANES * GAP_WATCH_LIMIT;
  try {
    const max = Number(fs.readFileSync(file, 'utf8').trim());
    return max > 0 ? Math.min(most, Math.floor(max / 4)) : most;
  } catch {
    return most;
  }
}

/** Most directories remembered; past it, ones known only as reported are forgotten. */
const ENTRY_LIMIT = 20_000;

/** What is known of one directory, and of the ones inside it by name. */
interface Entry {
  /** VS Code's watcher reported it created, so it watches it. */
  reported?: boolean;
  /** VS Code's watcher cannot see into it. */
  blind?: boolean;
  /** Our watch of it, with each lane relying on it and when that lane last asked for it. */
  watch?: { handle: DirWatch; owners: Map<string, number> };
  children?: Map<string, Entry>;
}

/**
 * VS Code's watcher on Linux (@parcel/watcher on inotify) starts watching a
 * new directory when it hears it was created, without looking inside it. A
 * tree made several levels deep in one go (mkdir -p, git worktree add, a
 * directory moved in) is reported as its top directory alone, and nothing
 * below it is ever reported. A directory with no report of its own under one
 * that was reported is such a blind one: it was made before the watcher
 * watched its parent. This watches blind directories itself, one watch each,
 * for the lanes (`owner`s) that record them.
 *
 * Directories are named by their Uri path. What is known of them outlives
 * closeAll, since the watcher stays blind where it was.
 */
export class WatchGaps {
  private readonly root: Entry = {};
  private entries = 0;
  /** Entries past which the next trim runs: twice what one left, so one that frees little is not run again at once. */
  private trimAt = ENTRY_LIMIT;
  /** Watched directories, by path. */
  private readonly watched = new Map<string, Entry>();
  /** How many watches each lane relies on. */
  private readonly counts = new Map<string, number>();
  /** Lanes whose limit was logged since closeAll or their release. */
  private readonly limitNoted = new Set<string>();
  /** Set once the total was logged, until closeAll. */
  private totalNoted = false;
  /** Set once the system ran out of inotify watches: no more are tried until closeAll. */
  private exhausted = false;
  /** Set once a watch could not be made, so the reason is logged once until closeAll. */
  private problemNoted = false;
  /** Stamps each request for a watch, so a sweep can tell the ones made after it began. */
  private clock = 0;

  constructor(
    private readonly watchDir: WatchDir,
    /** An entry changed in a watched directory, given by its file system path. */
    private readonly onEntry: (dirFsPath: string, name: string, kind: 'rename' | 'change') => void,
    private readonly log: (line: string) => void,
    /** A lane's name, for the log. */
    private readonly nameOf: (owner: string) => string,
    /** Most directories watched at once across lanes. */
    private readonly total = shareOfSystemWatches(),
  ) {}

  /** VS Code's watcher reported this directory created, so it watches it now: ours is no longer needed. */
  noteReported(dir: string): void {
    // Before it is marked: a trim forgets directories known only as reported, as this one is about to be.
    this.trim();
    const e = this.make(dir);
    e.reported = true;
    e.blind = false;
    this.close(dir, e);
    this.trim();
  }

  /** True for a directory with no report of its own that is blind, or inside one reported or blind. */
  isBlind(dir: string): boolean {
    let inside = false;
    let e: Entry | undefined = this.root;
    const names = split(dir);
    for (const [i, name] of names.entries()) {
      e = e.children?.get(name);
      if (!e) return inside;
      if (i === names.length - 1) return !e.reported && (!!e.blind || inside);
      if (e.reported || e.blind) inside = true;
    }
    return false;
  }

  /** `isBlind` for a directory found in `parent`, whose own answer is `parentBlind`. */
  isBlindIn(parent: string, parentBlind: boolean, dir: string): boolean {
    const p = this.find(parent);
    const e = p?.children?.get(dir.slice(dir.lastIndexOf('/') + 1));
    return !e?.reported && (parentBlind || !!e?.blind || !!p?.reported);
  }

  /** True when this directory was reported, found blind, or is watched. */
  knows(dir: string): boolean {
    const e = this.find(dir);
    return !!(e?.reported || e?.blind || e?.watch);
  }

  /**
   * Watches a blind directory for `owner`; true when this started a watch.
   * One reported since it was found blind is left to VS Code. One refused for
   * a limit is not remembered as blind, so refusals take no memory.
   */
  watch(dir: string, fsPath: string, owner: string): boolean {
    const e = this.make(dir);
    if (e.reported) return false;
    const stamp = ++this.clock;
    if (e.watch) {
      if (e.watch.owners.has(owner) || this.take(owner)) e.watch.owners.set(owner, stamp);
      return false;
    }
    if (this.exhausted) return false;
    if (this.watched.size >= this.total) {
      if (!this.totalNoted) {
        this.totalNoted = true;
        this.log(
          `Over ${this.total} new folders are hidden from VS Code's file watcher, so changes in the rest are not recorded. ` +
            "Reloading the window (Developer: Reload Window) lets VS Code's watcher see them.",
        );
      }
      return false;
    }
    if (!this.take(owner)) return false;
    try {
      const handle = this.watchDir(
        fsPath,
        (name, kind) => this.onEntry(fsPath, name, kind),
        () => this.close(dir),
      );
      e.blind = true;
      e.watch = { handle, owners: new Map([[owner, stamp]]) };
      this.watched.set(dir, e);
      this.trim();
      return true;
    } catch (err) {
      this.give(owner);
      const code = (err as NodeJS.ErrnoException).code;
      // Gone already: its delete is reported where its parent is watched.
      if (code === 'ENOENT') return false;
      if (code === 'ENOSPC') {
        // VS Code's own watcher needs the rest.
        this.exhausted = true;
        this.problem(
          `The system's limit on inotify watches is reached, so changes in folders VS Code's file watcher does not see are not recorded. ` +
            'Raising fs.inotify.max_user_watches and reloading the window helps.',
        );
      } else this.problem(`Could not watch ${fsPath}, a folder VS Code's file watcher does not see: ${String(err)}. Changes in it are not recorded.`);
      return false;
    }
  }

  /** The stamp of the latest request for a watch; pass it to keepOnly after a walk. */
  mark(): number {
    return this.clock;
  }

  /**
   * After a full walk for `owner` that began at `mark` and found the blind
   * directories in `seen`: stops relying on its other watches, unless asked
   * for again since.
   */
  keepOnly(owner: string, seen: ReadonlySet<string>, mark: number): void {
    for (const [dir, e] of [...this.watched]) {
      const stamp = e.watch!.owners.get(owner);
      if (stamp !== undefined && stamp <= mark && !seen.has(dir)) this.drop(dir, e, owner);
    }
  }

  /** `owner` no longer relies on a watch of this directory. */
  unwatch(dir: string, owner: string): void {
    const e = this.find(dir);
    if (e?.watch?.owners.has(owner)) this.drop(dir, e, owner);
  }

  /** `owner` records nothing any more: it relies on no watch. */
  release(owner: string): void {
    for (const [dir, e] of [...this.watched]) if (e.watch!.owners.has(owner)) this.drop(dir, e, owner);
    this.limitNoted.delete(owner);
  }

  /** A path was deleted or replaced: stops watching it and anything in it, and forgets what was known of them. */
  deleted(path: string): void {
    const names = split(path);
    const last = names.pop();
    let parent: Entry | undefined = this.root;
    for (const name of names) parent = parent?.children?.get(name);
    const e = last === undefined ? undefined : parent?.children?.get(last);
    if (!e) return;
    this.forget(path, e);
    parent!.children!.delete(last!);
  }

  /** Stops every watch. What is known of the directories stays: the watcher stays blind where it was. */
  closeAll(): void {
    for (const e of this.watched.values()) {
      e.watch!.handle.close();
      e.watch = undefined;
    }
    this.watched.clear();
    this.counts.clear();
    this.limitNoted.clear();
    this.totalNoted = false;
    this.exhausted = false;
    this.problemNoted = false;
  }

  private find(dir: string): Entry | undefined {
    let e: Entry | undefined = this.root;
    for (const name of split(dir)) {
      e = e.children?.get(name);
      if (!e) return undefined;
    }
    return e;
  }

  private make(dir: string): Entry {
    let e = this.root;
    for (const name of split(dir)) {
      e.children ??= new Map();
      let next = e.children.get(name);
      if (!next) {
        next = {};
        e.children.set(name, next);
        this.entries++;
      }
      e = next;
    }
    return e;
  }

  /** Counts a watch `owner` relies on; false at its limit, which is logged once. */
  private take(owner: string): boolean {
    const n = this.counts.get(owner) ?? 0;
    if (n >= GAP_WATCH_LIMIT) {
      if (!this.limitNoted.has(owner)) {
        this.limitNoted.add(owner);
        this.log(
          `${this.nameOf(owner)}: over ${GAP_WATCH_LIMIT} new folders are hidden from VS Code's file watcher, so changes in the rest are not recorded. ` +
            "Reloading the window (Developer: Reload Window) lets VS Code's watcher see them.",
        );
      }
      return false;
    }
    this.counts.set(owner, n + 1);
    return true;
  }

  private give(owner: string): void {
    const n = (this.counts.get(owner) ?? 1) - 1;
    if (n > 0) this.counts.set(owner, n);
    else this.counts.delete(owner);
  }

  private drop(dir: string, e: Entry, owner: string): void {
    e.watch!.owners.delete(owner);
    this.give(owner);
    if (e.watch!.owners.size === 0) this.close(dir, e);
  }

  private close(dir: string, e = this.find(dir)): void {
    if (!e?.watch) return;
    e.watch.handle.close();
    for (const owner of e.watch.owners.keys()) this.give(owner);
    e.watch = undefined;
    this.watched.delete(dir);
  }

  private forget(path: string, e: Entry): void {
    this.close(path, e);
    this.entries--;
    for (const [name, child] of e.children ?? []) this.forget(`${path}/${name}`, child);
  }

  /** Past ENTRY_LIMIT, forgets directories known only as reported, innermost first. */
  private trim(): void {
    if (this.entries <= this.trimAt) return;
    const prune = (e: Entry) => {
      for (const [name, child] of e.children ?? []) {
        prune(child);
        if (!child.children?.size && !child.watch && !child.blind) {
          e.children!.delete(name);
          this.entries--;
        }
      }
    };
    prune(this.root);
    this.trimAt = Math.max(ENTRY_LIMIT, this.entries * 2);
  }

  private problem(line: string): void {
    if (this.problemNoted) return;
    this.problemNoted = true;
    this.log(line);
  }
}

function split(dir: string): string[] {
  return dir.split('/').filter((name) => name !== '');
}
