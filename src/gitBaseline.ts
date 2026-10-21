/**
 * Read-only git access for baselines: which files in a workspace folder are
 * tracked and unchanged in the working tree, and what such a file's content
 * is. A clean tracked file's index blob, with the repo's filters applied, is
 * exactly what is on disk, so it can stand in for an in-memory snapshot.
 *
 * Every command runs with --no-optional-locks so git never rewrites the index,
 * and paths are relative to the folder (git's cwd), never to the repo root.
 */
import { execFile } from 'node:child_process';

export interface LsFilesEntry {
  mode: string;
  sha: string;
  stage: number;
  /** Relative to the folder git ran in, forward slashes. */
  path: string;
}

/** Parses `git ls-files -s -z`: `<mode> <sha> <stage>\t<path>` records separated by NUL. */
export function parseLsFiles(out: string): LsFilesEntry[] {
  const entries: LsFilesEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    if (!mode || !sha || stage === undefined) continue;
    entries.push({ mode, sha, stage: Number(stage), path: rec.slice(tab + 1) });
  }
  return entries;
}

/** Parses NUL-separated paths, as from `git ls-files -m -z`. */
export function parsePathList(out: string): Set<string> {
  return new Set(out.split('\0').filter(Boolean));
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/** Tracked regular files at stage 0 that are not modified in the working tree. */
export function classifyClean(entries: LsFilesEntry[], modified: Set<string>): Map<string, string> {
  const clean = new Map<string, string>();
  for (const e of entries) {
    if (e.stage !== 0 || !REGULAR_FILE_MODES.has(e.mode) || modified.has(e.path)) continue;
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

/** Runs git with the given args in cwd and resolves its stdout, or rejects with the process error. */
export type GitRunner = (args: string[], cwd: string) => Promise<Buffer>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

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
    const [staged, modified] = await Promise.all([run(['ls-files', '-s', '-z'], folder), run(['ls-files', '-m', '-z'], folder)]);
    return { kind: 'ok', files: classifyClean(parseLsFiles(staged.toString('utf8')), parsePathList(modified.toString('utf8'))) };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    return { kind: 'not-repo' };
  }
}

/** The blob as git would check it out at `path` (eol and smudge filters applied), or undefined on any failure. */
export async function readBlob(folder: string, path: string, sha: string, run: GitRunner = runGit): Promise<Buffer | undefined> {
  try {
    return await run(['cat-file', '--filters', `--path=${path}`, sha], folder);
  } catch {
    return undefined;
  }
}
