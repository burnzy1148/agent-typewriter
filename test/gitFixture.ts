/** Real-git fixtures for unit tests: temporary repositories built in a clean git environment. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitChildEnv } from '../src/gitBaseline';

/** Undefined when git can run here; otherwise the reason, for `test(..., { skip })`. */
export const noGit: string | undefined = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', env: gitChildEnv(process.env) });
    return undefined;
  } catch {
    return 'git is not available';
  }
})();

/** A hooks directory that does not exist, so the user's hooks never run. */
const NO_HOOKS = path.join(os.tmpdir(), 'at-git-no-hooks');

/** Runs git in cwd, ignoring the user's config that would change commits, and returns stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${NO_HOOKS}`, ...args],
    { cwd, encoding: 'utf8', env: gitChildEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** A fresh directory under the OS temp dir, symlinks resolved. */
export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A new repository in a fresh temp dir, with no global excludes and no eol conversion. */
export function tempRepo(prefix = 'at-git-'): string {
  const dir = tempDir(prefix);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.excludesFile', path.join(dir, '.git', 'no-such-excludes'));
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

/** Writes a file under root, creating its directories. */
export function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
