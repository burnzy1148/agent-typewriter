/**
 * Read-only git access for baselines: which files in a workspace folder are
 * tracked and unchanged in the working tree, and what such a file's content
 * is. A clean tracked file's index blob, with the repo's filters applied, is
 * exactly what is on disk, so it can stand in for an in-memory snapshot.
 *
 * Every command runs with --no-optional-locks so git never rewrites the index.
 * Paths passed in and returned are relative to the folder (git's cwd). The one
 * exception is inside readBlob: `cat-file --path` resolves from the repo's top
 * level, so readBlob adds the folder's prefix before passing it on.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';

export interface LsFilesEntry {
  /** The `ls-files -v` tag: `H` cached, `S` skip-worktree, lowercase for assume-unchanged. Absent without -v. */
  tag?: string;
  mode: string;
  sha: string;
  stage: number;
  /** Relative to the folder git ran in, forward slashes. */
  path: string;
}

/** Parses `git ls-files -s [-v] -z`: `[<tag> ]<mode> <sha> <stage>\t<path>` records separated by NUL. */
export function parseLsFiles(out: string): LsFilesEntry[] {
  const entries: LsFilesEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const fields = rec.slice(0, tab).split(' ');
    const tag = fields.length === 4 ? fields.shift() : undefined;
    const [mode, sha, stage] = fields;
    if (!mode || !sha || stage === undefined || fields.length !== 3) continue;
    entries.push({ ...(tag !== undefined && { tag }), mode, sha, stage: Number(stage), path: rec.slice(tab + 1) });
  }
  return entries;
}

/** Parses NUL-separated paths, as from `git ls-files -m -z`. */
export function parsePathList(out: string): Set<string> {
  return new Set(out.split('\0').filter(Boolean));
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/**
 * Tracked regular files at stage 0 that are not modified in the working tree.
 * A tagged entry counts only when tagged `H`: git never compares skip-worktree
 * (`S`) or assume-unchanged (lowercase) files with the disk, so `-m` cannot vouch for them.
 */
export function classifyClean(entries: LsFilesEntry[], modified: Set<string>): Map<string, string> {
  const clean = new Map<string, string>();
  for (const e of entries) {
    if (e.stage !== 0 || !REGULAR_FILE_MODES.has(e.mode) || modified.has(e.path)) continue;
    if (e.tag !== undefined && e.tag !== 'H') continue;
    clean.set(e.path, e.sha);
  }
  return clean;
}

export interface BudgetCandidate {
  key: string;
  size: number;
  mtime: number;
}

/** Most recently modified first, while the total size stays within the budget. */
export function selectWithinBudget(candidates: BudgetCandidate[], budgetBytes: number): Set<string> {
  const chosen = new Set<string>();
  let used = 0;
  for (const c of [...candidates].sort((a, b) => b.mtime - a.mtime)) {
    if (used + c.size > budgetBytes) continue;
    used += c.size;
    chosen.add(c.key);
  }
  return chosen;
}

/**
 * Fills the budget most recently modified first, like `selectWithinBudget`,
 * with the bytes `load` actually keeps. `load` resolves what a candidate
 * takes, or undefined when it keeps nothing (binary or unreadable); the size
 * reserved for it is then given back, and candidates skipped earlier are
 * tried again. Resolves the candidates left out because the budget ran out.
 */
export async function fillBudget(
  candidates: BudgetCandidate[],
  budgetBytes: number,
  load: (c: BudgetCandidate) => Promise<number | undefined>,
  batchSize = 64,
): Promise<BudgetCandidate[]> {
  let pending = [...candidates].sort((a, b) => b.mtime - a.mtime);
  let used = 0;
  for (;;) {
    const batch: BudgetCandidate[] = [];
    const rest: BudgetCandidate[] = [];
    for (const c of pending) {
      if (batch.length < batchSize && used + c.size <= budgetBytes) {
        used += c.size;
        batch.push(c);
      } else {
        rest.push(c);
      }
    }
    if (batch.length === 0) return rest;
    pending = rest;
    await Promise.all(
      batch.map(async (c) => {
        used += ((await load(c)) ?? 0) - c.size;
      }),
    );
  }
}

/** How far past the time of its stat a file's mtime may be and still count as written then (coarse or skewed clocks). */
export const CAPTURE_SKEW_MS = 2000;

/**
 * True when a file's mtime says it was written while a baseline capture ran,
 * from `startedAt` to its stat at `statAt`: a change still on its way through
 * the watcher. A later mtime is a file stamped in the future, not a new write.
 */
export function writtenDuringCapture(mtime: number, startedAt: number, statAt: number, skewMs = CAPTURE_SKEW_MS): boolean {
  return mtime >= startedAt && mtime <= statAt + skewMs;
}

/** Runs git with the given args in cwd and resolves its stdout, or rejects with the process error. */
export type GitRunner = (args: string[], cwd: string) => Promise<Buffer>;

/** Variables `git rev-parse --local-env-vars` lists: each one picks the repository over cwd. */
const LOCAL_GIT_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/**
 * The environment for a git child: `env` without git's repository-selection
 * variables, so git finds the repository from cwd alone. VS Code can inherit
 * them when git starts it as an editor. Names match case-insensitively on Windows.
 */
export function gitChildEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (LOCAL_GIT_ENV.has(platform === 'win32' ? name.toUpperCase() : name)) continue;
    out[name] = value;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/**
 * Runs one git process. When the spawn fails with `ENOENT` because cwd is
 * missing, not because git is, it rejects with code `ENOCWD` instead, so the
 * folder reads as not a repository rather than git being unavailable.
 */
export const execGit: GitRunner = (args, cwd) => execGitWith({})(args, cwd);

/** Like `execGit`, with `extraEnv` added to the child's environment. */
export const execGitWith = (extraEnv: NodeJS.ProcessEnv): GitRunner => (args, cwd) =>
  new Promise<Buffer>((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
        env: { ...gitChildEnv(process.env), ...extraEnv },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  }).catch(async (err: unknown) => {
    if ((err as { code?: unknown } | undefined)?.code !== 'ENOENT') throw err;
    const isDir = await fsp.stat(cwd).then(
      (st) => st.isDirectory(),
      () => false,
    );
    throw isDir ? err : Object.assign(new Error(`not a directory: ${cwd}`), { code: 'ENOCWD', cause: err });
  });

/** Spawn failures that pass once other processes exit: out of process slots or file descriptors. */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE']);

export interface GitLimit {
  /** Most git processes running at once. */
  concurrency: number;
  /** Tries per call when the spawn fails transiently, the first one included. */
  attempts: number;
  /** Wait before the first retry; doubles each time. */
  backoffMs: number;
}

/**
 * Wraps a runner so at most `concurrency` calls run at once, the rest waiting
 * in FIFO order, and retries transient spawn failures with backoff. Every other
 * error (git exit codes, ENOENT, timeouts) rejects at once, unchanged.
 */
export function limitGit(run: GitRunner, { concurrency, attempts, backoffMs }: GitLimit): GitRunner {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (args, cwd) => {
    await acquire();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await run(args, cwd);
        } catch (err) {
          const code = (err as { code?: unknown } | undefined)?.code;
          if (attempt >= attempts || typeof code !== 'string' || !TRANSIENT_SPAWN_CODES.has(code)) throw err;
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        }
      }
    } finally {
      release();
    }
  };
}

export const runGit: GitRunner = limitGit(execGit, { concurrency: 8, attempts: 5, backoffMs: 50 });

/** True when the error means git itself cannot run, as opposed to a git command failing. */
export function isGitUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: boolean } | undefined;
  return e?.code === 'ENOENT' || e?.code === 'EACCES' || e?.killed === true;
}

export type CleanTrackedResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-repo' }
  /** Folder-relative path -> index blob sha. */
  | { kind: 'ok'; files: Map<string, string> };

export async function listCleanTracked(folder: string, run: GitRunner = runGit): Promise<CleanTrackedResult> {
  try {
    const [staged, modified] = await Promise.all([run(['ls-files', '-s', '-v', '-z'], folder), run(['ls-files', '-m', '-z'], folder)]);
    return { kind: 'ok', files: classifyClean(parseLsFiles(staged.toString('utf8')), parsePathList(modified.toString('utf8'))) };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    return { kind: 'not-repo' };
  }
}

/**
 * The blob as git would check it out at the folder-relative `path` (eol and
 * smudge filters applied), or undefined on any failure.
 */
export async function readBlob(folder: string, path: string, sha: string, run: GitRunner = runGit): Promise<Buffer | undefined> {
  try {
    // cat-file looks up attributes for --path from the repo's top level, not from cwd.
    const prefix = await showPrefix(folder, run);
    return await run(['cat-file', '--filters', `--path=${prefix}${path}`, sha], folder).catch((err: unknown) => {
      prefixes.get(run)?.delete(folder);
      throw err;
    });
  } catch {
    return undefined;
  }
}

/** Successful `rev-parse --show-prefix` lookups, per runner and folder; a folder's prefix does not change. */
const prefixes = new WeakMap<GitRunner, Map<string, Promise<string>>>();

/** The folder's path below the repo's top level, with a trailing slash, or '' at the top. */
function showPrefix(folder: string, run: GitRunner): Promise<string> {
  let byFolder = prefixes.get(run);
  if (!byFolder) prefixes.set(run, (byFolder = new Map()));
  const cached = byFolder.get(folder);
  if (cached) return cached;
  const lookup = run(['rev-parse', '--show-prefix'], folder).then((out) => out.toString('utf8').replace(/\n$/, ''));
  byFolder.set(folder, lookup);
  lookup.catch(() => {
    if (byFolder.get(folder) === lookup) byFolder.delete(folder);
  });
  return lookup;
}
