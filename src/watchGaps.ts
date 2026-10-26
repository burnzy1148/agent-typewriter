import * as fs from 'node:fs';

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

/** How many directories reported created are remembered; the oldest are forgotten first. */
const REPORTED_LIMIT = 20_000;

/** Most directories watched at once, so gaps never use up the system's inotify watches. */
export const GAP_WATCH_LIMIT = 2000;

/**
 * VS Code's watcher on Linux (@parcel/watcher on inotify) starts watching a
 * new directory when it hears it was created, without looking inside it. A
 * tree made several levels deep in one go (mkdir -p, git worktree add, a
 * directory moved in) is reported as its top directory alone, and nothing
 * below it is ever reported. A directory with no report of its own under one
 * that was reported is such a blind one: it was made before the watcher
 * watched its parent. This watches blind directories itself, one watch each.
 *
 * Directories are named by their Uri path.
 */
export class WatchGaps {
  /** Directories VS Code's watcher reported created, oldest first. */
  private readonly reported = new Set<string>();
  private readonly watches = new Map<string, DirWatch>();
  /** Set once a watch could not be made, so the reason is logged once until closeAll. */
  private problemNoted = false;

  constructor(
    private readonly watchDir: WatchDir,
    /** An entry changed in a watched directory, given by its file system path. */
    private readonly onEntry: (dirFsPath: string, name: string, kind: 'rename' | 'change') => void,
    private readonly log: (line: string) => void,
  ) {}

  /** VS Code's watcher reported this directory created, so it watches it now: ours is no longer needed. */
  noteReported(dir: string): void {
    this.reported.delete(dir);
    this.reported.add(dir);
    if (this.reported.size > REPORTED_LIMIT) this.reported.delete(this.reported.values().next().value!);
    this.close(dir);
  }

  /** True for a directory with no report of its own inside one reported or watched here. */
  isBlind(dir: string): boolean {
    if (this.reported.has(dir)) return false;
    if (this.watches.has(dir)) return true;
    for (let end = dir.lastIndexOf('/'); end > 0; end = dir.lastIndexOf('/', end - 1)) {
      const up = dir.slice(0, end);
      if (this.reported.has(up) || this.watches.has(up)) return true;
    }
    return false;
  }

  /** `isBlind` for a directory found in `parent`, whose own answer is `parentBlind`. */
  isBlindIn(parent: string, parentBlind: boolean, dir: string): boolean {
    return !this.reported.has(dir) && (parentBlind || this.reported.has(parent));
  }

  /** Watches a blind directory; true when this started a watch. One reported since it was found blind is left to VS Code. */
  watch(dir: string, fsPath: string): boolean {
    if (this.watches.has(dir) || this.reported.has(dir)) return false;
    if (this.watches.size >= GAP_WATCH_LIMIT) {
      this.problem(
        `Over ${GAP_WATCH_LIMIT} new folders are hidden from VS Code's file watcher; changes in more of them are not recorded until recording restarts.`,
      );
      return false;
    }
    try {
      const watch = this.watchDir(
        fsPath,
        (name, kind) => this.onEntry(fsPath, name, kind),
        () => this.close(dir),
      );
      this.watches.set(dir, watch);
      return true;
    } catch (err) {
      // Gone already: its delete is reported where its parent is watched.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.problem(`Could not watch ${fsPath}, a new folder VS Code's file watcher does not see: ${String(err)}. Changes in it are not recorded.`);
      }
      return false;
    }
  }

  /** A path was deleted: stops watching it and anything in it, and forgets their reports. */
  deleted(path: string): void {
    const inside = path + '/';
    if (this.watches.size > 0) for (const dir of [...this.watches.keys()]) if (dir === path || dir.startsWith(inside)) this.close(dir);
    if (this.reported.delete(path)) for (const dir of [...this.reported]) if (dir.startsWith(inside)) this.reported.delete(dir);
  }

  /** Stops every watch. What was reported is kept: the watcher stays blind where it was. */
  closeAll(): void {
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.problemNoted = false;
  }

  private close(dir: string): void {
    this.watches.get(dir)?.close();
    this.watches.delete(dir);
  }

  private problem(line: string): void {
    if (this.problemNoted) return;
    this.problemNoted = true;
    this.log(line);
  }
}
