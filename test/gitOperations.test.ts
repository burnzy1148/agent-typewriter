import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildOperation,
  changedPaths,
  changeSpan,
  DEFAULT_TIMING,
  digestIndex,
  findGitWrite,
  GitOperationWatch,
  groupEntries,
  reflogLabel,
  stashChange,
  type GitOperation,
  type MarkerLook,
} from '../src/gitOperations';
import { execGit, parseLsFiles, type GitRunner } from '../src/gitBaseline';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const index = (lines: string) => groupEntries(parseLsFiles(lines.trim().split('\n').join('\0')));

test('changedPaths: added, removed, blob, mode and stage changes; unchanged left out', () => {
  const before = digestIndex(index(`100644 ${SHA_A} 0\tsame.ts\n100644 ${SHA_A} 0\tblob.ts\n100644 ${SHA_A} 0\tmode.ts\n100644 ${SHA_A} 0\tgone.ts\n100644 ${SHA_A} 0\tconflict.ts`));
  const after = digestIndex(
    index(
      `100644 ${SHA_A} 0\tsame.ts\n100644 ${SHA_B} 0\tblob.ts\n100755 ${SHA_A} 0\tmode.ts\n100644 ${SHA_A} 0\tnew.ts\n` +
        `100644 ${SHA_A} 1\tconflict.ts\n100644 ${SHA_B} 2\tconflict.ts\n100644 ${SHA_C} 3\tconflict.ts`,
    ),
  );
  assert.deepEqual([...changedPaths(before, after)].sort(), ['blob.ts', 'conflict.ts', 'gone.ts', 'mode.ts', 'new.ts']);
});

test('changedPaths: identical indexes change nothing', () => {
  const d = digestIndex(index(`100644 ${SHA_A} 0\ta.ts`));
  assert.equal(changedPaths(d, new Map(d)).size, 0);
});

test('buildOperation: clean, dirty, unmerged, removed and popped paths', () => {
  const after = index(`100644 ${SHA_A} 0\tclean.ts\n100644 ${SHA_B} 0\tdirty.ts\n100644 ${SHA_A} 2\tconflict.ts\n100644 ${SHA_B} 3\tconflict.ts`);
  const op = buildOperation({
    label: 'merge f',
    from: 0,
    to: 10,
    candidates: ['clean.ts', 'dirty.ts', 'conflict.ts', 'removed.ts'],
    after,
    dirty: new Set(['dirty.ts']),
    popped: ['popped.ts'],
  });
  assert.deepEqual([...op.present].sort(), ['clean.ts', 'conflict.ts', 'popped.ts']);
  assert.deepEqual([...op.absent].sort(), ['popped.ts', 'removed.ts']);
  assert.deepEqual([...op.blobs], [['clean.ts', SHA_A]]);
});

test('findGitWrite: span edges and whether the file exists', () => {
  const op: GitOperation = { label: 'checkout', from: 100, to: 200, present: new Set(['a.ts']), absent: new Set(['b.ts']), blobs: new Map(), skipped: 0 };
  assert.equal(findGitWrite([op], 'a.ts', 100, true), op);
  assert.equal(findGitWrite([op], 'a.ts', 200, true), op);
  assert.equal(findGitWrite([op], 'a.ts', 99, true), undefined);
  assert.equal(findGitWrite([op], 'a.ts', 201, true), undefined);
  assert.equal(findGitWrite([op], 'a.ts', 150, false), undefined);
  assert.equal(findGitWrite([op], 'b.ts', 150, false), op);
  assert.equal(findGitWrite([op], 'c.ts', 150, true), undefined);
});

test('stashChange: push, pop, and anything else', () => {
  assert.deepEqual(stashChange(['x'], ['n', 'x']), { pushed: 'n' });
  assert.deepEqual(stashChange([], ['n']), { pushed: 'n' });
  assert.deepEqual(stashChange(['x', 'y'], ['y']), { popped: 'x' });
  assert.deepEqual(stashChange(['x'], []), { popped: 'x' });
  assert.deepEqual(stashChange(['x', 'y'], ['x']), {});
  assert.deepEqual(stashChange([], []), {});
});

test('reflogLabel: the message up to its colon', () => {
  const line = (msg: string) => `${SHA_A} ${SHA_B} T <t@e> 1700000000 +0000\t${msg}\n`;
  assert.equal(reflogLabel(line('commit: one') + line('merge feature: Fast-forward')), 'merge feature');
  assert.equal(reflogLabel(line('checkout: moving from main to f')), 'checkout');
  assert.equal(reflogLabel(line('rebase (finish): returning to refs/heads/f')), 'rebase (finish)');
  assert.equal(reflogLabel(''), undefined);
});

test('changeSpan: earliest and latest changed marker, ignoring unchanged and removed ones', () => {
  const look = (m: Record<string, number>): MarkerLook => ({ at: 0, markers: '', stash: '', index: '', indexMtime: 0, lock: false, mtimes: new Map(Object.entries(m)) });
  assert.deepEqual(changeSpan(look({ HEAD: 5, ORIG_HEAD: 1 }), look({ HEAD: 9, ORIG_HEAD: 1, MERGE_HEAD: 7 })), { earliest: 7, latest: 9 });
  assert.deepEqual(changeSpan(look({ MERGE_HEAD: 3 }), look({})), { earliest: undefined, latest: undefined });
});

// Real repositories from here on.

const FAST = { ...DEFAULT_TIMING, graceMs: 50, lookCacheMs: 0, lockMaxMs: 300 };

/** A repository with `a.ts` and `b.ts` on main and a `feature` branch that changes `a.ts`, adds `c.ts` and removes `b.ts`. */
function featureRepo(): string {
  const repo = tempRepo();
  write(repo, 'a.ts', 'a1\n');
  write(repo, 'b.ts', 'b1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'feature');
  write(repo, 'a.ts', 'a2\n');
  write(repo, 'c.ts', 'c\n');
  git(repo, 'rm', '-q', 'b.ts');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'feature');
  git(repo, 'switch', '-q', 'main');
  return repo;
}

async function watchOf(root: string, run: GitRunner = execGit): Promise<GitOperationWatch> {
  const w = new GitOperationWatch(root, run, undefined, FAST);
  assert.equal(await w.status(), 'ok');
  return w;
}

/** How late a delete's watcher event may come after git's last marker, as the recorder allows with a 250 ms reorder window. */
const DELETE_LATE_MS = 1250;

/** Classifies the file's current state the way the recorder would: its mtime, or now and some lateness for a delete. */
async function gits(w: GitOperationWatch, rel: string): Promise<string | undefined> {
  const st = fs.statSync(path.join(w.root, rel), { throwIfNoEntry: false });
  return (await w.classify(rel, st?.mtimeMs ?? Date.now(), st !== undefined, st ? 0 : DELETE_LATE_MS))?.label;
}

test('watch: a fast-forward merge is git; an edit of an untouched file during it is not', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'z.ts', 'z\n');
  git(repo, 'add', 'z.ts');
  git(repo, 'commit', '-qm', 'z');
  const w = await watchOf(repo);
  write(repo, 'z.ts', 'agent\n');
  git(repo, 'merge', '-q', '--no-edit', 'feature');
  assert.match((await gits(w, 'a.ts')) ?? '', /^merge feature/);
  assert.ok(await gits(w, 'c.ts'));
  assert.ok(await gits(w, 'b.ts'), 'removed file');
  assert.equal(await gits(w, 'z.ts'), undefined);
});

test('watch: a merged file the agent then rewrites is not git', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'merge', '-q', 'feature');
  await new Promise((r) => setTimeout(r, 120));
  write(repo, 'a.ts', 'agent\n');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a branch switch adds, changes and removes files', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'switch', '-q', 'feature');
  assert.equal(await gits(w, 'a.ts'), 'checkout');
  assert.equal(await gits(w, 'c.ts'), 'checkout');
  assert.equal(await gits(w, 'b.ts'), 'checkout');
});

/** featureRepo plus a commit on main that conflicts with feature's change to `a.ts`. */
function conflictRepo(): string {
  const repo = featureRepo();
  write(repo, 'a.ts', 'main\n');
  git(repo, 'commit', '-qam', 'main side');
  return repo;
}

test('watch: conflict markers are git; the resolution written after is not', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  assert.match(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8'), /<<<<<<</);
  assert.ok(await gits(w, 'a.ts'));
  await new Promise((r) => setTimeout(r, 120));
  write(repo, 'a.ts', 'resolved\n');
  assert.equal(await gits(w, 'a.ts'), undefined);
  // Choosing a side is resolving too: only the index changes.
  git(repo, 'checkout', '--theirs', 'a.ts');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: merge --abort restores files as git', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  await gits(w, 'a.ts');
  git(repo, 'merge', '--abort');
  assert.equal(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8'), 'main\n');
  assert.ok(await gits(w, 'a.ts'));
});

test('watch: rebase and cherry-pick are git', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'm.ts', 'm\n');
  git(repo, 'add', 'm.ts');
  git(repo, 'commit', '-qm', 'main m');
  git(repo, 'switch', '-q', 'feature');
  const w = await watchOf(repo);
  git(repo, 'rebase', '-q', 'main');
  assert.ok(await gits(w, 'm.ts'));
  git(repo, 'switch', '-qc', 'pick', 'main');
  await gits(w, 'a.ts');
  git(repo, 'cherry-pick', 'feature');
  assert.ok(await gits(w, 'c.ts'));
});

test('watch: stash push and pop with untracked files are git', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'wip\n');
  write(repo, 'u.ts', 'untracked\n');
  git(repo, 'stash', 'push', '-u', '-q');
  assert.equal(await gits(w, 'a.ts'), 'stash push');
  assert.equal(await gits(w, 'u.ts'), 'stash push');
  git(repo, 'stash', 'pop', '-q');
  assert.equal(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8'), 'wip\n');
  assert.equal(await gits(w, 'a.ts'), 'stash pop');
  assert.equal(await gits(w, 'u.ts'), 'stash pop');
});

test('watch: restore, stash apply and git add are not operations', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'agent\n');
  git(repo, 'restore', 'a.ts');
  assert.equal(await gits(w, 'a.ts'), undefined);
  write(repo, 'a.ts', 'wip\n');
  git(repo, 'stash', 'push', '-q');
  await gits(w, 'a.ts');
  await new Promise((r) => setTimeout(r, 120));
  git(repo, 'stash', 'apply', '-q');
  assert.equal(await gits(w, 'a.ts'), undefined);
  write(repo, 'b.ts', 'staged\n');
  git(repo, 'add', 'b.ts');
  assert.equal(await gits(w, 'b.ts'), undefined);
});

test('watch: a folder below the repository top uses paths relative to it', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, 'sub/a.ts', '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  git(repo, 'switch', '-qc', 'two');
  write(repo, 'sub/a.ts', '2\n');
  git(repo, 'commit', '-qam', 'two');
  git(repo, 'switch', '-q', 'main');
  const w = await watchOf(path.join(repo, 'sub'));
  git(repo, 'merge', '-q', 'two');
  assert.ok(await gits(w, 'a.ts'));
});

test('watch: a linked worktree follows its own git directory; a stash in another is not its own', { skip: noGit }, async () => {
  const repo = featureRepo();
  const wt = path.join(tempDir('at-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'main');
  const own = await watchOf(repo);
  const linked = await watchOf(wt);
  git(wt, 'merge', '-q', 'feature');
  assert.ok(await gits(linked, 'a.ts'));
  assert.equal(await gits(own, 'a.ts'), undefined);
  await new Promise((r) => setTimeout(r, 120));
  // Rewritten with its committed text just before a stash in the other checkout: a stash push there would vouch for it.
  write(wt, 'a.ts', 'a2\n');
  write(repo, 'a.ts', 'wip\n');
  git(repo, 'stash', 'push', '-q');
  assert.equal(await gits(own, 'a.ts'), 'stash push');
  assert.equal(await gits(linked, 'a.ts'), undefined);
});

test('watch: only reads; status and the index are unchanged', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'a.ts', 'dirty\n');
  const w = await watchOf(repo);
  git(repo, 'switch', '-q', '-m', 'feature');
  const status = git(repo, '--no-optional-locks', 'status', '--porcelain');
  const indexMtime = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
  await gits(w, 'a.ts');
  await gits(w, 'c.ts');
  assert.equal(git(repo, '--no-optional-locks', 'status', '--porcelain'), status);
  assert.equal(fs.statSync(path.join(repo, '.git', 'index')).mtimeMs, indexMtime);
});

test('watch: a stale index.lock delays a write by the cap, not forever', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  write(repo, 'a.ts', 'agent\n');
  const started = Date.now();
  assert.equal(await gits(w, 'a.ts'), undefined);
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `took ${took} ms`);
});

test('watch: a folder outside git is not a repository', { skip: noGit }, async () => {
  const w = new GitOperationWatch(tempDir('at-nogit-'), execGit, undefined, FAST);
  assert.equal(await w.status(), 'not-repo');
  assert.equal(await w.classify('a.ts', Date.now(), true), undefined);
});

test('watch: git missing turns it off with the reason', async () => {
  const missing: GitRunner = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
  const w = new GitOperationWatch(tempDir('at-nogit-'), missing, undefined, FAST);
  assert.equal(await w.status(), 'unavailable');
  assert.match(w.failure ?? '', /ENOENT/);
});
