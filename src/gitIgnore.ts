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
    return { kind: 'ok', ignored: new IgnoredPaths(parsePathList(out.toString('utf8'))) };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    return { kind: 'not-repo' };
  }
}

/** Whether git ignores this one path. Any failure counts as not ignored. */
export async function checkIgnored(folder: string, path: string, run: GitRunner = runGit): Promise<boolean> {
  try {
    await run(['check-ignore', '-q', '--', path], folder);
    return true;
  } catch {
    // Exit 1 means not ignored; anything else means git could not tell.
    return false;
  }
}
