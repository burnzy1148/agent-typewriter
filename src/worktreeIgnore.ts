import { minimatch } from 'minimatch';
import { literalGlob } from './filter';

/** Prefix of an `autoIgnoreWorktrees` entry that matches a worktree's branch instead of its path. */
export const BRANCH_PREFIX = 'branch:';

/**
 * The first of `patterns` that keeps a worktree away from auto-record and
 * auto-follow, or undefined. A pattern matches the worktree's absolute path,
 * or its directory name when the pattern has no slash; a `branch:` pattern
 * matches its short branch name, and a detached worktree (no branch) never.
 */
export function ignoringPattern(
  patterns: readonly string[],
  checkoutPath: string,
  branch: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const win = platform === 'win32';
  const path = win ? checkoutPath.replace(/\\/g, '/') : checkoutPath;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.startsWith(BRANCH_PREFIX)) {
      const glob = pattern.slice(BRANCH_PREFIX.length).trim();
      if (glob && branch !== undefined && minimatch(branch, glob, { dot: true })) return raw;
      continue;
    }
    const glob = win ? pattern.replace(/\\/g, '/') : pattern;
    // Windows paths compare without case; git reports them in varying case.
    if (minimatch(path.replace(/\/+$/, ''), glob, { dot: true, matchBase: !glob.includes('/'), nocase: win })) return raw;
  }
  return undefined;
}

/**
 * A pattern for worktrees like this one: its directory name, with the last
 * `-`, `_` or `.` separated part made a wildcard when that part has a digit,
 * as in `review-mr-203` -> `review-mr-*`.
 */
export function suggestIgnorePattern(checkoutPath: string): string {
  const name = checkoutPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const m = /^(.+[-_.])([^-_.]*\d[^-_.]*)$/.exec(name);
  return m ? `${literalGlob(m[1])}*` : literalGlob(name);
}
