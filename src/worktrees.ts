/**
 * Read-only git access for checkout scoping: which worktrees a workspace
 * folder's repository has, which one the folder belongs to, and which sit
 * inside a directory being recorded. Worktrees are exactly what
 * `git worktree list` reports, so submodules and unrelated nested
 * repositories never count as checkouts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isGitUnavailable, runGit, type GitRunner } from './gitBaseline';

export interface Worktree {
  /** Absolute native path, as git reports it. */
  path: string;
  /** Commit sha checked out, or '' when git didn't say. */
  head: string;
  /** Short branch name, when a branch is checked out. */
  branch?: string;
}

export type WorktreeListResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-repo' }
  | { kind: 'ok'; worktrees: Worktree[] };

/**
 * Parses `git worktree list --porcelain`, NUL-terminated lines with `-z` or
 * newline-terminated without. Records are separated by an empty line. Bare and
 * prunable entries are left out: they have no files to record.
 */
export function parseWorktreeList(out: string, sep: '\0' | '\n'): Worktree[] {
  const list: Worktree[] = [];
  let current: (Worktree & { skip: boolean }) | undefined;
  const end = () => {
    if (current && !current.skip) list.push({ path: current.path, head: current.head, ...(current.branch ? { branch: current.branch } : {}) });
    current = undefined;
  };
  for (const raw of out.split(sep)) {
    const line = sep === '\n' ? raw.replace(/\r$/, '') : raw;
    if (line === '') {
      end();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      end();
      current = { path: path.resolve(value), head: '', skip: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'bare' || key === 'prunable') {
      current.skip = true;
    }
  }
  end();
  return list;
}

export async function listWorktrees(folder: string, run: GitRunner = runGit): Promise<WorktreeListResult> {
  try {
    const out = await run(['worktree', 'list', '--porcelain', '-z'], folder);
    return { kind: 'ok', worktrees: parseWorktreeList(out.toString('utf8'), '\0') };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
  }
  // Git before 2.36 has no -z here.
  try {
    const out = await run(['worktree', 'list', '--porcelain'], folder);
    return { kind: 'ok', worktrees: parseWorktreeList(out.toString('utf8'), '\n') };
  } catch (err) {
    if (isGitUnavailable(err)) return { kind: 'unavailable', reason: String((err as Error).message ?? err) };
    return { kind: 'not-repo' };
  }
}

/** True when a `.git` file's text points into a repository's `worktrees/`, as a linked worktree's does (a submodule's points into `modules/`). */
export function pointsAtLinkedWorktree(gitFileText: string): boolean {
  return /^gitdir: .*[\\/]worktrees[\\/][^\\/]+[\\/]?\s*$/m.test(gitFileText);
}

/** A path as it is on disk: absolute, symlinks and short names resolved, real case kept. */
function realPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // A path that doesn't exist (yet) compares as written.
    return resolved;
  }
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** A path in a form two spellings of the same directory share: symlinks resolved, case folded on Windows. */
export function pathKey(p: string): string {
  return fold(realPath(p));
}

/**
 * `child` relative to `parent` with forward slashes, '' when they are the
 * same, or undefined when `child` is outside. Containment ignores case on
 * Windows; the result keeps the child's real case, as VS Code reports paths.
 */
export function relativeInside(parent: string, child: string): string | undefined {
  const a = realPath(parent).replace(/[\\/]+$/, '');
  const b = realPath(child).replace(/[\\/]+$/, '');
  if (fold(a) === fold(b)) return '';
  if (!fold(b).startsWith(fold(a) + path.sep)) return undefined;
  return b.slice(a.length + 1).replace(/\\/g, '/');
}

/** The worktree a folder belongs to: the deepest listed worktree containing it. */
export function ownCheckout(folder: string, worktrees: Worktree[]): Worktree | undefined {
  let best: Worktree | undefined;
  let bestDepth = -1;
  for (const wt of worktrees) {
    if (relativeInside(wt.path, folder) === undefined) continue;
    const depth = pathKey(wt.path).length;
    if (depth > bestDepth) {
      best = wt;
      bestDepth = depth;
    }
  }
  return best;
}

/** Worktrees strictly inside `root`, as root-relative `dir/` prefixes. */
export function nestedUnder(root: string, worktrees: Worktree[]): string[] {
  const dirs: string[] = [];
  for (const wt of worktrees) {
    const rel = relativeInside(root, wt.path);
    if (rel) dirs.push(rel + '/');
  }
  return dirs;
}

/**
 * The directory to record when `chosen` is picked for a folder that sits at
 * some subpath of its own checkout: the same subpath in `chosen`.
 */
export function rootIn(chosen: Worktree, own: Worktree | undefined, folder: string): string {
  const sub = own ? relativeInside(own.path, folder) : undefined;
  return sub ? path.join(chosen.path, ...sub.split('/')) : chosen.path;
}

/** A short name per worktree path for display paths: its directory name, with the parent's name added when two share one. */
export function worktreeLabels(worktrees: Worktree[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const wt of worktrees) counts.set(path.basename(wt.path), (counts.get(path.basename(wt.path)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const wt of worktrees) {
    const base = path.basename(wt.path);
    labels.set(wt.path, (counts.get(base) ?? 0) > 1 ? `${path.basename(path.dirname(wt.path))}-${base}` : base);
  }
  return labels;
}

/** What the user sees for a checkout: its branch, or its short commit when detached. */
export function checkoutName(wt: Worktree): string {
  return wt.branch ?? (wt.head ? wt.head.slice(0, 7) : path.basename(wt.path));
}

/** Display path of a file in a chosen worktree: folder name (multi-root only), worktree label, then the root-relative path. */
export function checkoutDisplayPath(folderName: string, label: string, rel: string): string {
  return [folderName, label, rel].filter(Boolean).join('/');
}

/**
 * The checkout chosen per workspace folder, kept in a small JSON file in the
 * extension's workspace storage. A file, like the saved timeline, rather than
 * workspaceState, so the choice is on disk as soon as it is made.
 */
export class CheckoutChoiceFile {
  private readonly choices = new Map<string, string>();

  constructor(readonly file: string) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) if (typeof v === 'string') this.choices.set(k, v);
      }
    } catch {
      // Missing or unreadable: nothing chosen yet.
    }
  }

  get(folderKey: string): string | undefined {
    return this.choices.get(folderKey);
  }

  set(folderKey: string, worktreePath: string | undefined): void {
    if (worktreePath === undefined) this.choices.delete(folderKey);
    else this.choices.set(folderKey, worktreePath);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.choices), null, 2));
    fs.renameSync(tmp, this.file);
  }
}
