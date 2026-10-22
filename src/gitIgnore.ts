/**
 * Read-only git access for `respectGitignore`: which untracked paths in a
 * workspace folder git ignores. Paths are relative to the folder (git's cwd).
 */
import { isGitUnavailable, parsePathList, runGit, type GitRunner } from './gitBaseline';

/** Ignored files plus wholly ignored directories (listed once, with a trailing slash). */
export class IgnoredPaths {
  private readonly files = new Set<string>();
  private readonly dirs: string[] = [];

  constructor(entries: Iterable<string> = []) {
    for (const e of entries) this.add(e);
  }

  add(relPath: string): void {
    if (relPath.endsWith('/')) this.dirs.push(relPath);
    else this.files.add(relPath);
  }

  has(relPath: string): boolean {
    return this.files.has(relPath) || this.dirs.some((d) => relPath.startsWith(d));
  }
}

export type IgnoredResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-repo' }
  | { kind: 'ok'; ignored: IgnoredPaths };

export async function listIgnored(folder: string, run: GitRunner = runGit): Promise<IgnoredResult> {
  try {
    const out = await run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], folder);
    return { kind: 'ok', ignored: new IgnoredPaths(dropCollapsedDirs([...parsePathList(out.toString('utf8'))])) };
  } catch (err) {
    // git ran and exited with an error code: not a repository. A string code
    // is git failing to start or finish (EMFILE, EAGAIN, an output too large),
    // which may pass; only a missing folder (ENOCWD) is again not a repository.
    const code = (err as { code?: unknown } | undefined)?.code;
    if (isGitUnavailable(err) || (typeof code === 'string' && code !== 'ENOCWD')) {
      return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    }
    return { kind: 'not-repo' };
  }
}

/**
 * Git also lists an untracked directory as `dir/` when everything in it happens
 * to be ignored, and then lists those ignored contents under it. It never looks
 * inside a directory it ignores itself, so a `dir/` with entries under it is a
 * collapsed one, not ignored, and is dropped.
 */
export function dropCollapsedDirs(entries: string[]): string[] {
  const sorted = [...entries].sort();
  // Everything starting with `dir/` sorts right after it.
  return sorted.filter((e, i) => !e.endsWith('/') || !sorted[i + 1]?.startsWith(e));
}

/** Whether git ignores this one path. Any failure counts as not ignored. */
export async function checkIgnored(folder: string, path: string, run: GitRunner = runGit): Promise<boolean> {
  try {
    // The ./ keeps a leading `:` from being read as pathspec magic.
    await run(['check-ignore', '-q', '--', `./${path}`], folder);
    return true;
  } catch {
    // Exit 1 means not ignored; anything else means git could not tell.
    return false;
  }
}
