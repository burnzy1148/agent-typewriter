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
  /**
   * Git calls it prunable: its `.git` is gone. A worktree being removed is
   * listed like this until all its files are gone, so it still counts as a
   * checkout, but it is never offered as one.
   */
  prunable?: boolean;
}

export type WorktreeListResult =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-repo' }
  | { kind: 'ok'; worktrees: Worktree[] };

/**
 * Parses `git worktree list --porcelain`, NUL-terminated lines with `-z` or
 * newline-terminated without. Records are separated by an empty line. Bare
 * entries are left out: they have no files to record. Prunable ones are kept
 * and flagged.
 */
export function parseWorktreeList(out: string, sep: '\0' | '\n'): Worktree[] {
  const list: Worktree[] = [];
  let current: (Worktree & { skip: boolean }) | undefined;
  const end = () => {
    if (current && !current.skip) {
      list.push({
        path: current.path,
        head: current.head,
        ...(current.branch ? { branch: current.branch } : {}),
        ...(current.prunable ? { prunable: true } : {}),
      });
    }
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
    } else if (key === 'bare') {
      current.skip = true;
    } else if (key === 'prunable') {
      current.prunable = true;
    }
  }
  end();
  return list;
}

/** The worktrees git lists that still have their files: those a user can pick. */
export function liveWorktrees(worktrees: Worktree[]): Worktree[] {
  return worktrees.filter((w) => !w.prunable);
}

/**
 * Lists the folder's repository worktrees. Only a git that ran and exited with
 * an error (or a folder that is gone) means not a repository. Git that could
 * not start or finish, for good (not installed) or for now (out of processes
 * or file descriptors, a timeout), is unavailable.
 */
export async function listWorktrees(folder: string, run: GitRunner = runGit): Promise<WorktreeListResult> {
  const failure = (err: unknown): WorktreeListResult | undefined => {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (isGitUnavailable(err) || typeof code !== 'number') {
      if (code === 'ENOCWD') return { kind: 'not-repo' };
      return { kind: 'unavailable', reason: String((err as Error | undefined)?.message ?? err) };
    }
    return undefined;
  };
  try {
    const out = await run(['worktree', 'list', '--porcelain', '-z'], folder);
    return { kind: 'ok', worktrees: parseWorktreeList(out.toString('utf8'), '\0') };
  } catch (err) {
    const failed = failure(err);
    if (failed) return failed;
  }
  // Git before 2.36 has no -z here.
  try {
    const out = await run(['worktree', 'list', '--porcelain'], folder);
    return { kind: 'ok', worktrees: parseWorktreeList(out.toString('utf8'), '\n') };
  } catch (err) {
    return failure(err) ?? { kind: 'not-repo' };
  }
}

/** The `gitdir:` a `.git` file's text names, as written, or undefined for any other text. */
export function gitdirOf(gitFileText: string): string | undefined {
  return /^gitdir: (.*?)\s*$/m.exec(gitFileText)?.[1] || undefined;
}

/** The git directory a checkout's `.git` leads to: the directory itself, or the one its `.git` file names. */
function gitDirOf(checkout: string): string | undefined {
  const dotGit = path.join(checkout, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const named = gitdirOf(fs.readFileSync(dotGit, 'utf8'));
    return named === undefined ? undefined : path.resolve(checkout, named);
  } catch {
    return undefined;
  }
}

/**
 * The common git directory of the repository a checkout belongs to, as a
 * `pathKey`: every worktree of one repository has the same. Undefined when the
 * checkout's `.git` can't be read.
 */
export function commonDirKey(checkout: string): string | undefined {
  const gitDir = gitDirOf(checkout);
  if (gitDir === undefined) return undefined;
  let common = gitDir;
  try {
    // A linked worktree's git directory names the common one; the main checkout's is it.
    common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    // No commondir file: this is the common directory.
  }
  return pathKey(common);
}

/**
 * True when the `.git` file at `dotGit` makes its directory a linked worktree
 * of the repository whose common directory is `commonKey`: its gitdir,
 * resolved against the file's directory, is `<common dir>/worktrees/<name>`.
 * A submodule's (`modules/...`) or another repository's worktree is not.
 */
export function isWorktreeOf(dotGit: string, commonKey: string): boolean {
  let named: string | undefined;
  try {
    if (!fs.statSync(dotGit).isFile()) return false;
    named = gitdirOf(fs.readFileSync(dotGit, 'utf8'));
  } catch {
    return false;
  }
  if (named === undefined) return false;
  const gitdir = path.resolve(path.dirname(dotGit), named.replace(/[\\/]+$/, ''));
  return path.basename(path.dirname(gitdir)) === 'worktrees' && pathKey(path.dirname(path.dirname(gitdir))) === commonKey;
}

/** A nested directory hidden from recording because a worktree's `.git` file appeared there, until git lists it. */
export interface ProvisionalDir {
  /** Root-relative `dir/` prefix. */
  dir: string;
  /** Order in which the `.git` file was noticed, against the order a worktree listing started. */
  seq: number;
}

/**
 * The provisional directories a scope built from a worktree listing still has
 * to hide: those noticed after the listing started, which it may have missed,
 * and that git did not list. One noticed before the listing is settled by it:
 * git listed it, or it is not a worktree of this repository.
 */
export function carriedProvisional<T extends ProvisionalDir>(entries: T[], listedAt: number, listed: string[]): T[] {
  return entries.filter((e) => e.seq > listedAt && !listed.includes(e.dir));
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

/**
 * Innermost of `roots` that strictly contains `target`, as an index, or -1.
 * Paths are '/'-separated (URI paths); case is ignored when `foldCase`, as on
 * Windows. A tie goes to the first root listed.
 */
export function innermostRoot(roots: string[], target: string, foldCase = process.platform === 'win32'): number {
  const fold = (p: string) => (foldCase ? p.toLowerCase() : p);
  const t = fold(target);
  let best = -1;
  let bestLength = -1;
  roots.forEach((root, i) => {
    const r = fold(root.replace(/\/+$/, ''));
    if (t.startsWith(r + '/') && r.length > bestLength) {
      best = i;
      bestLength = r.length;
    }
  });
  return best;
}

/** One path segment for a display path: separators in a name become '-'. */
function segment(name: string): string {
  const s = name.replace(/[\\/]+/g, '-');
  return s === '' || /^\.+$/.test(s) ? `_${s}` : s;
}

/**
 * Display-path prefixes that never collide: one per entry, different from
 * each other and from every `taken` name. An entry's label is its first name,
 * with more of its names joined in front ('parent-base') while that is shared,
 * and then a number. `names` go most specific first: a directory's own name,
 * then its parent's, and so on. An entry with a `given` label keeps it.
 */
export function uniqueLabels(entries: Array<{ names: string[]; given?: string }>, taken: Iterable<string> = []): string[] {
  const used = new Set(taken);
  for (const e of entries) if (e.given !== undefined) used.add(e.given);
  const names = entries.map((e) => {
    const n = e.names.filter((s) => s !== '').map(segment);
    return n.length > 0 ? n : ['_'];
  });
  const open = entries.flatMap((e, i) => (e.given === undefined ? [i] : []));
  const level = new Map<number, number>();
  const firsts = new Map<string, number>();
  for (const i of open) firsts.set(names[i][0], (firsts.get(names[i][0]) ?? 0) + 1);
  // A name no other entry has and nothing has taken stays as it is: the others move away from it.
  const plain = new Set(open.filter((i) => firsts.get(names[i][0]) === 1 && !used.has(names[i][0])));
  // Two that share a directory name both get their parent's, as they always have.
  for (const i of open) level.set(i, (firsts.get(names[i][0]) ?? 0) > 1 ? Math.min(1, names[i].length - 1) : 0);
  const label = (i: number) => names[i].slice(0, level.get(i)! + 1).reverse().join('-');
  for (;;) {
    const counts = new Map<string, number>();
    for (const i of open) counts.set(label(i), (counts.get(label(i)) ?? 0) + 1);
    const bump = open.filter(
      (i) => !plain.has(i) && ((counts.get(label(i)) ?? 0) > 1 || used.has(label(i))) && level.get(i)! < names[i].length - 1,
    );
    if (bump.length === 0) break;
    for (const i of bump) level.set(i, level.get(i)! + 1);
  }
  // Out of names: plain names first, then the first of a shared label keeps
  // it, and the rest get a number no other label has.
  const counts = new Map<string, number>();
  for (const i of open) counts.set(label(i), (counts.get(label(i)) ?? 0) + 1);
  const unique = new Set(open.map(label).filter((l) => counts.get(l) === 1 && !used.has(l)));
  const out = entries.map((e) => e.given ?? '');
  for (const i of [...plain, ...open.filter((j) => !plain.has(j))]) {
    const base = label(i);
    let l = base;
    for (let k = 2; used.has(l) || (l !== base && unique.has(l)); k++) l = `${base}-${k}`;
    used.add(l);
    out[i] = l;
  }
  return out;
}

/** A native path's directory names, most specific first. */
function namesOf(p: string): string[] {
  const names: string[] = [];
  for (let dir = path.resolve(p); path.basename(dir) !== ''; dir = path.dirname(dir)) names.push(path.basename(dir));
  return names;
}

/**
 * A short name per worktree path for display paths: its directory name, with
 * its parent's (and further up) added while two would share one or one would
 * match a `taken` name, such as a top-level entry of the workspace folder.
 * Paths in `given` keep the label they have; labels are never shared.
 */
export function worktreeLabels(
  worktrees: Worktree[],
  opts: { given?: ReadonlyMap<string, string>; taken?: Iterable<string> } = {},
): Map<string, string> {
  const labels = uniqueLabels(
    worktrees.map((w) => ({ names: namesOf(w.path), given: opts.given?.get(w.path) })),
    opts.taken,
  );
  return new Map(worktrees.map((w, i) => [w.path, labels[i]]));
}

/**
 * Display-path prefix per workspace folder in a multi-root workspace: its
 * name as one path segment, with its parent directories' names added while two
 * folders would share one. `path` is the folder's URI path. A folder with a
 * `given` prefix keeps it, and no new prefix is one of `taken`.
 */
export function folderLabels(folders: Array<{ name: string; path: string; given?: string }>, taken: Iterable<string> = []): string[] {
  return uniqueLabels(
    folders.map((f) => {
      const dirs = f.path.replace(/\/+$/, '').split('/').filter(Boolean).reverse();
      return { names: [f.name, ...dirs.slice(1)], given: f.given };
    }),
    taken,
  );
}

/** What the user sees for a checkout: its branch, or its short commit when detached. */
export function checkoutName(wt: Worktree): string {
  return wt.branch ?? (wt.head ? wt.head.slice(0, 7) : path.basename(wt.path));
}

/** Status name of a folder recording itself while it has no checkout of its own (a bare repository's worktrees). */
export const NO_CHECKOUT = '(none chosen)';

/**
 * How a folder in git appears in the checkout chooser and status bar.
 * `choices` counts what the chooser offers: the folder's own checkout, or the
 * folder itself when it has none, plus every other worktree. It can be chosen
 * from when there are two or more.
 */
export function folderCheckoutChoice(
  folderName: string,
  own: Worktree | undefined,
  worktrees: Worktree[],
): { choices: number; label: string; description: string; name: string } {
  const others = worktrees.filter((w) => w !== own).length;
  if (own) return { choices: others + 1, label: checkoutName(own), description: "this folder's checkout", name: checkoutName(own) };
  return { choices: others > 0 ? others + 1 : 0, label: folderName, description: 'no checkout of its own, records none', name: NO_CHECKOUT };
}

/** Display path of a file in a chosen worktree: folder prefix (multi-root only), worktree label, then the root-relative path. */
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
  /** Per folder key, the display label given to each chosen worktree, by its `pathKey`; the recorder keeps folder prefixes here too. */
  private readonly labels = new Map<string, Map<string, string>>();

  constructor(readonly file: string) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string') this.choices.set(k, v);
          // Folder keys are URIs, so this key is never one; older files have no labels.
          else if (k === 'labels' && v && typeof v === 'object') {
            for (const [folderKey, given] of Object.entries(v as Record<string, unknown>)) {
              if (!given || typeof given !== 'object') continue;
              const map = new Map(Object.entries(given).filter((e): e is [string, string] => typeof e[1] === 'string'));
              if (map.size > 0) this.labels.set(folderKey, map);
            }
          }
        }
      }
    } catch {
      // Missing or unreadable: nothing chosen yet.
    }
  }

  get(folderKey: string): string | undefined {
    return this.choices.get(folderKey);
  }

  /**
   * Remembers the choice for the rest of the session, and on disk when it can.
   * Returns the error when saving it failed, instead of throwing.
   */
  set(folderKey: string, worktreePath: string | undefined): Error | undefined {
    if (worktreePath === undefined) this.choices.delete(folderKey);
    else this.choices.set(folderKey, worktreePath);
    return this.save();
  }

  /** Labels given so far to the folder's chosen worktrees, by the worktree's `pathKey`. */
  labelsOf(folderKey: string): ReadonlyMap<string, string> {
    return this.labels.get(folderKey) ?? new Map();
  }

  /** Remembers a worktree's label for good, like `set`: kept for the session even when saving fails. */
  setLabel(folderKey: string, worktreeKey: string, label: string): Error | undefined {
    let map = this.labels.get(folderKey);
    if (!map) this.labels.set(folderKey, (map = new Map()));
    map.set(worktreeKey, label);
    return this.save();
  }

  private save(): Error | undefined {
    const data: Record<string, unknown> = Object.fromEntries(this.choices);
    if (this.labels.size > 0) data.labels = Object.fromEntries([...this.labels].map(([k, m]) => [k, Object.fromEntries(m)]));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }
}
