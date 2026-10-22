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
    const entries = [...parsePathList(out.toString('utf8'))];
    // Git also collapses an untracked directory to `dir/` when everything in it
    // happens to be ignored. Keep a directory only when git ignores it itself;
    // the ignored files inside one it does not are listed one by one.
    const keep = await Promise.all(entries.map((e) => !e.endsWith('/') || ignoresDirectory(folder, e.slice(0, -1), run)));
    return { kind: 'ok', ignored: new IgnoredPaths(entries.filter((_, i) => keep[i])) };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    return { kind: 'not-repo' };
  }
}

/**
 * Runs `git check-ignore -q` on one path: true when git ignores it, false on
 * exit 1, and `onFailure` when git could not tell.
 */
async function checkIgnore(folder: string, path: string, run: GitRunner, onFailure: boolean): Promise<boolean> {
  try {
    await run(['check-ignore', '-q', '--', path], folder);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | undefined)?.code === 1 ? false : onFailure;
  }
}

/** Whether git ignores this one path. Any failure counts as not ignored. */
export function checkIgnored(folder: string, path: string, run: GitRunner = runGit): Promise<boolean> {
  return checkIgnore(folder, path, run, false);
}

/**
 * Whether git ignores the directory itself, checked without the trailing slash
 * (with it, `star/*` reports `star/` as ignored). A failure keeps the directory.
 */
function ignoresDirectory(folder: string, dir: string, run: GitRunner): Promise<boolean> {
  return checkIgnore(folder, dir, run, true);
}
