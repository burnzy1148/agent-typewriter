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
  discardsConflicts,
  firstReflogCommit,
  messageLabel,
  reflogShowEntries,
  resolutionsOf,
  GitOperationWatch,
  groupEntries,
  operationLabel,
  reflogLabel,
  reflogLabels,
  writesNoFiles,
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
  const op: GitOperation = { label: 'checkout', from: 100, to: 200, touched: new Set(['a.ts', 'b.ts']), present: new Set(['a.ts']), absent: new Set(['b.ts']), blobs: new Map(), blobAt: new Map(), resolved: new Set(), skipped: 0 };
  assert.equal(findGitWrite([op], 'a.ts', 100, true), op);
  assert.equal(findGitWrite([op], 'a.ts', 200, true), op);
  assert.equal(findGitWrite([op], 'a.ts', 99, true), undefined);
  assert.equal(findGitWrite([op], 'a.ts', 201, true), undefined);
  assert.equal(findGitWrite([op], 'a.ts', 150, false), undefined);
  assert.equal(findGitWrite([op], 'b.ts', 150, false), op);
  assert.equal(findGitWrite([op], 'c.ts', 150, true), undefined);
});

test('findGitWrite: a blob made after the write was taken in by git, not written by it', () => {
  const op: GitOperation = { label: 'commit', from: 100, to: 200, touched: new Set(['a.ts', 'b.ts']), present: new Set(['a.ts', 'b.ts']), absent: new Set(), blobs: new Map(), blobAt: new Map([['a.ts', 160], ['b.ts', 120]]), resolved: new Set(), skipped: 0 };
  assert.equal(findGitWrite([op], 'a.ts', 150, true), undefined);
  assert.equal(findGitWrite([op], 'a.ts', 160, true), op);
  assert.equal(findGitWrite([op], 'b.ts', 150, true), op);
});

test('operationLabel: a state file that appeared, else the reflog only when it moved', () => {
  const look = (m: Record<string, number>, gone: Record<string, number> = {}): MarkerLook => ({
    at: 0,
    markers: '',
    stash: '',
    index: '',
    indexMtime: 0,
    lock: false,
    mtimes: new Map(Object.entries(m)),
    goneAt: new Map(Object.entries(gone)),
    reflogSize: undefined,
  });
  assert.equal(operationLabel(look({ 'logs/HEAD': 1 }), look({ 'logs/HEAD': 1, MERGE_HEAD: 2 }), []), 'merge');
  assert.equal(operationLabel(look({}), look({ 'rebase-merge': 2, 'logs/HEAD': 3 }), ['rebase (start)']), 'rebase');
  assert.equal(operationLabel(look({ 'logs/HEAD': 1 }), look({ 'logs/HEAD': 2 }), ['checkout', 'commit']), 'commit');
  assert.equal(operationLabel(look({ 'logs/HEAD': 1 }), look({ 'logs/HEAD': 1, ORIG_HEAD: 2 }), []), 'git operation');
});

test('reflogLabels: every line, oldest first; partial and empty lines skipped', () => {
  const line = (msg: string) => `${SHA_A} ${SHA_B} T <t@e> 1700000000 +0000\t${msg}\n`;
  assert.deepEqual(reflogLabels(line('checkout: moving from a to b') + line('commit: x') + 'trunc'), ['checkout', 'commit']);
  assert.deepEqual(reflogLabels(''), []);
});

test('messageLabel: up to the colon, without the options pull logs', () => {
  assert.equal(messageLabel('pull -q --no-rebase: Fast-forward'), 'pull');
  assert.equal(messageLabel('pull --rebase (finish): returning to refs/heads/main'), 'pull');
  assert.equal(messageLabel('merge feature: Fast-forward'), 'merge feature');
  assert.equal(messageLabel('rebase (finish): returning to refs/heads/f'), 'rebase (finish)');
});

test('discardsConflicts: aborts and resets, not continues', () => {
  for (const l of ['reset', 'checkout', 'rebase (abort)']) assert.ok(discardsConflicts(l), l);
  for (const l of ['rebase (continue)', 'rebase (finish)', 'cherry-pick', 'commit (merge)', 'merge feature']) assert.ok(!discardsConflicts(l), l);
});

test('resolutionsOf: a conflict settled since the last look is a resolution, unless git threw it away', () => {
  const before = digestIndex(index(`100644 ${SHA_A} 1\tr.ts\n100644 ${SHA_B} 2\tr.ts\n100644 ${SHA_A} 0\to.ts\n100644 ${SHA_A} 1\tstill.ts\n100644 ${SHA_B} 3\tstill.ts`));
  const after = digestIndex(index(`100644 ${SHA_B} 0\tr.ts\n100644 ${SHA_C} 0\to.ts\n100644 ${SHA_A} 1\tstill.ts\n100644 ${SHA_C} 3\tstill.ts`));
  assert.deepEqual([...resolutionsOf(new Set(['r.ts', 'o.ts', 'still.ts']), before, after, ['cherry-pick'])], ['r.ts']);
  assert.deepEqual([...resolutionsOf(new Set(['r.ts', 'o.ts']), before, after, ['reset'])], []);
});

test('writesNoFiles: commits of every kind, nothing else', () => {
  for (const l of ['commit', 'commit (amend)', 'commit (initial)', 'commit (merge)']) assert.ok(writesNoFiles(l), l);
  for (const l of ['checkout', 'merge feature', 'rebase (continue)', 'cherry-pick', 'reset', 'git operation']) assert.ok(!writesNoFiles(l), l);
});

test('findGitWrite: a resolved path is never git\'s, and an older operation does not claim it', () => {
  const older: GitOperation = { label: 'rebase', from: 0, to: 500, touched: new Set(['r.ts']), present: new Set(['r.ts']), absent: new Set(), blobs: new Map(), blobAt: new Map(), resolved: new Set(), skipped: 0 };
  const newer: GitOperation = { ...older, from: 100, to: 300, resolved: new Set(['r.ts']) };
  assert.equal(findGitWrite([older, newer], 'r.ts', 200, true), undefined);
});

test('reflogShowEntries: entries since a second, oldest first, with the oldest one\'s commit', () => {
  const out = [`${SHA_C}\0HEAD@{1700000010}\0checkout: moving from a to b`, `${SHA_B}\0HEAD@{1700000005}\0reset: moving to HEAD`, `${SHA_A}\0HEAD@{1699999000}\0commit: old`].join('\n');
  assert.deepEqual(reflogShowEntries(out, 1700000005), { labels: ['reset', 'checkout'], firstCommit: SHA_B });
  assert.deepEqual(reflogShowEntries(out, 1700000011), { labels: [], firstCommit: undefined });
});

test('firstReflogCommit: the new commit of the first line', () => {
  const text = `${SHA_A} ${SHA_B} T <t@e> 1700000000 +0000\trebase (continue): x\n${SHA_B} ${SHA_C} T <t@e> 1700000001 +0000\trebase (pick): y\n`;
  assert.equal(firstReflogCommit(text), SHA_B);
  assert.equal(firstReflogCommit(''), undefined);
});

test('stashChange: push, pop, and anything else', () => {
  assert.deepEqual(stashChange(['x'], ['n', 'x']), { pushed: 'n' });
  assert.deepEqual(stashChange([], ['n']), { pushed: 'n' });
  assert.deepEqual(stashChange(['x', 'y'], ['y']), { popped: 'x' });
  assert.deepEqual(stashChange(['x'], []), { popped: 'x' });
  assert.deepEqual(stashChange(['x', 'y'], ['x']), { popped: 'y' });
  assert.deepEqual(stashChange(['x', 'y', 'z'], ['x', 'z']), { popped: 'y' });
  assert.deepEqual(stashChange(['x', 'y'], ['y', 'x']), {});
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
  const look = (m: Record<string, number>, gone: Record<string, number> = {}): MarkerLook => ({
    at: 0,
    markers: '',
    stash: '',
    index: '',
    indexMtime: 0,
    lock: false,
    mtimes: new Map(Object.entries(m)),
    goneAt: new Map(Object.entries(gone)),
    reflogSize: undefined,
  });
  assert.deepEqual(changeSpan(look({ HEAD: 5, ORIG_HEAD: 1 }), look({ HEAD: 9, ORIG_HEAD: 1, MERGE_HEAD: 7 })), { earliest: 7, latest: 9 });
  assert.deepEqual(changeSpan(look({ MERGE_HEAD: 3 }), look({})), { earliest: undefined, latest: undefined });
  // A removal ends the span at its directory's mtime: a pop drops refs/stash after restoring files.
  assert.deepEqual(changeSpan(look({ 'refs/stash': 3, index: 1 }), look({ index: 5 }, { 'refs/stash': 8 })), { earliest: 5, latest: 8 });
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

/** Classifies the file's current state the way the recorder would: its mtime, or for a delete its directory's. */
async function gits(w: GitOperationWatch, rel: string): Promise<string | undefined> {
  const file = path.join(w.root, rel);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return (await w.classify(rel, (st ?? fs.statSync(path.dirname(file))).mtimeMs, st !== undefined))?.label;
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

test('watch: never rewrites the index, even when a file is stat-dirty but unchanged', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'switch', '-qc', 'other');
  // Past the index's own mtime second, so git trusts the entry's stat and would refresh it.
  await new Promise((r) => setTimeout(r, 1100));
  // Same text, new mtime: a refreshing git command would rewrite the index for it.
  write(repo, 'b.ts', 'b1\n');
  const indexMtime = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
  await gits(w, 'b.ts');
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

test('watch: a commit right after an agent edit leaves the edit to the agent', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'agent\n');
  write(repo, 'n.ts', 'new\n');
  fs.rmSync(path.join(repo, 'b.ts'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'agent');
  assert.equal(await gits(w, 'a.ts'), undefined);
  assert.equal(await gits(w, 'n.ts'), undefined);
  assert.equal(await gits(w, 'b.ts'), undefined);
  write(repo, 'a.ts', 'again\n');
  git(repo, 'commit', '-qam', 'again');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a conflict resolved and committed stays the agent\'s; the merge is labelled merge', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  assert.equal(await gits(w, 'a.ts'), 'merge');
  await new Promise((r) => setTimeout(r, 120));
  write(repo, 'a.ts', 'resolved\n');
  git(repo, 'add', 'a.ts');
  git(repo, '-c', 'core.editor=true', 'commit', '-q', '--no-edit');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a later commit of a rebase that rewrites the resolved file is git\'s', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, 'a.ts', 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'feature');
  write(repo, 'a.ts', 'ONE feature\ntwo\nthree\n');
  git(repo, 'commit', '-qam', 'c1');
  write(repo, 'b.ts', 'b\n');
  git(repo, 'add', 'b.ts');
  git(repo, 'commit', '-qm', 'c2');
  write(repo, 'a.ts', 'ONE feature\ntwo\nTHREE\n');
  git(repo, 'commit', '-qam', 'c3');
  git(repo, 'switch', '-q', 'main');
  write(repo, 'a.ts', 'ONE main\ntwo\nthree\n');
  git(repo, 'commit', '-qam', 'main');
  git(repo, 'switch', '-q', 'feature');
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'rebase', '-q', 'main'));
  assert.equal(await gits(w, 'a.ts'), 'rebase');
  await sleep(120);
  write(repo, 'a.ts', 'ONE resolved\ntwo\nthree\n');
  git(repo, 'add', 'a.ts');
  git(repo, '-c', 'core.editor=true', 'rebase', '--continue');
  assert.equal(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8'), 'ONE resolved\ntwo\nTHREE\n');
  assert.match((await gits(w, 'a.ts')) ?? '', /^rebase/);
  assert.match((await gits(w, 'b.ts')) ?? '', /^rebase/);
});

test('watch: a rebase conflict resolved before --continue stays the agent\'s; the next commit\'s files are git\'s', { skip: noGit }, async () => {
  const repo = conflictRepo();
  git(repo, 'switch', '-q', 'feature');
  write(repo, 'd.ts', 'd\n');
  git(repo, 'add', 'd.ts');
  git(repo, 'commit', '-qm', 'feature d');
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'rebase', '-q', 'main'));
  assert.equal(await gits(w, 'a.ts'), 'rebase');
  await new Promise((r) => setTimeout(r, 120));
  write(repo, 'a.ts', 'resolved\n');
  git(repo, 'add', 'a.ts');
  git(repo, '-c', 'core.editor=true', 'rebase', '--continue');
  assert.equal(await gits(w, 'a.ts'), undefined);
  assert.match((await gits(w, 'd.ts')) ?? '', /^rebase/);
});

test('watch: a file written back to its committed text, then a status refresh, is not git', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'edit\n');
  write(repo, 'a.ts', 'a1\n');
  git(repo, 'status', '--porcelain');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: git going missing mid-classify turns it off and leaves the write unclaimed', { skip: noGit }, async () => {
  const repo = featureRepo();
  let missing = false;
  const run: GitRunner = (args, cwd) => (missing ? Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) : execGit(args, cwd));
  const w = await watchOf(repo, run);
  git(repo, 'merge', '-q', 'feature');
  missing = true;
  assert.equal(await gits(w, 'a.ts'), undefined);
  assert.match(w.failure ?? '', /ENOENT/);
});

test('watch: a failing refresh leaves writes unclaimed and does not run git again until a marker changes', { skip: noGit }, async () => {
  const repo = featureRepo();
  let broken = false;
  let calls = 0;
  const run: GitRunner = (args, cwd) => {
    calls++;
    if (broken && args[0] === 'ls-files') return Promise.reject(Object.assign(new Error('index file corrupt'), { code: 128 }));
    return execGit(args, cwd);
  };
  const w = await watchOf(repo, run);
  broken = true;
  git(repo, 'merge', '-q', 'feature');
  assert.equal(await gits(w, 'a.ts'), undefined);
  assert.match(w.problem ?? '', /index file corrupt/);
  const after = calls;
  assert.equal(await gits(w, 'c.ts'), undefined);
  assert.equal(calls, after);
  assert.equal(w.failure, undefined);
});

/** featureRepo with every object packed, as after a clone or gc, and a conflicting change to `a.ts` on main. */
function packedConflictRepo(): string {
  const repo = conflictRepo();
  git(repo, 'gc', '-q');
  return repo;
}

test('watch: with packed objects, a side chosen and continued after a conflict stays the agent\'s', { skip: noGit }, async () => {
  const repo = packedConflictRepo();
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'cherry-pick', 'feature'));
  assert.equal(await gits(w, 'a.ts'), 'cherry-pick');
  await new Promise((r) => setTimeout(r, 120));
  git(repo, 'checkout', '--theirs', 'a.ts');
  git(repo, 'add', 'a.ts');
  git(repo, '-c', 'core.editor=true', 'cherry-pick', '--continue');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: with packed objects, merge --abort still restores files as git', { skip: noGit }, async () => {
  const repo = packedConflictRepo();
  const w = await watchOf(repo);
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  await gits(w, 'a.ts');
  git(repo, 'merge', '--abort');
  assert.ok(await gits(w, 'a.ts'));
});

test('watch: a squash merge is git', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'merge', '-q', '--squash', 'feature');
  assert.equal(await gits(w, 'a.ts'), 'merge --squash');
  assert.equal(await gits(w, 'c.ts'), 'merge --squash');
  assert.equal(await gits(w, 'b.ts'), 'merge --squash');
});

test('watch: a squash merge committed before it is read reads as the commit alone (a documented limit)', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'merge', '-q', '--squash', 'feature');
  git(repo, 'commit', '-qm', 'squash');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: what an agent stages, then a new branch on the same commit, stays the agent\'s', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'z.ts', 'z\n');
  git(repo, 'add', 'z.ts');
  git(repo, 'commit', '-qm', 'z');
  const w = await watchOf(repo);
  git(repo, 'rm', '-q', 'b.ts');
  git(repo, 'switch', '-qc', 'one');
  assert.equal(await gits(w, 'b.ts'), undefined);
  git(repo, 'mv', 'z.ts', 'y.ts');
  git(repo, 'checkout', '-qb', 'two');
  assert.equal(await gits(w, 'z.ts'), undefined);
  assert.equal(await gits(w, 'y.ts'), undefined);
  write(repo, 'a.ts', 'staged\n');
  git(repo, 'add', 'a.ts');
  git(repo, 'restore', '--staged', '--worktree', 'a.ts');
  git(repo, 'switch', '-qc', 'three');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a file taken from another branch and committed stays the agent\'s', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  git(repo, 'checkout', 'feature', '--', 'a.ts');
  git(repo, 'commit', '-qm', 'take');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: reset --hard to the current commit with a staged change is recorded, as the spec says', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'staged\n');
  git(repo, 'add', 'a.ts');
  git(repo, 'reset', '-q', '--hard');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a step git finishes while a refresh reads is read again, so its files are git\'s', { skip: noGit }, async () => {
  const repo = tempRepo();
  write(repo, 'base.ts', 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'feature');
  write(repo, 'x.ts', 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'x');
  write(repo, 'y.ts', 'y\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'y');
  git(repo, 'switch', '-q', 'main');
  let inject: (() => void) | undefined;
  const run: GitRunner = (args, cwd) => {
    if (inject && args[0] === 'ls-files') {
      const step = inject;
      inject = undefined;
      step();
    }
    return execGit(args, cwd);
  };
  const w = await watchOf(repo, run);
  git(repo, 'cherry-pick', 'feature~1');
  inject = () => {
    // Later than the span's end slack after the first step, as a slow step on Windows is.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    git(repo, 'cherry-pick', 'feature');
  };
  assert.ok(await gits(w, 'x.ts'));
  assert.ok(fs.existsSync(path.join(repo, 'y.ts')));
  assert.ok(await gits(w, 'y.ts'));
});

test('watch: deleting a file a stash pop just restored is not git', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'u.ts', 'untracked\n');
  git(repo, 'stash', 'push', '-u', '-q');
  await gits(w, 'u.ts');
  git(repo, 'stash', 'pop', '-q');
  assert.equal(await gits(w, 'u.ts'), 'stash pop');
  fs.rmSync(path.join(repo, 'u.ts'));
  assert.equal(await gits(w, 'u.ts'), undefined);
});

test('watch: a file reset out of the index but left on disk, then deleted, is not git', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'n.ts', 'new\n');
  git(repo, 'add', 'n.ts');
  git(repo, 'commit', '-qm', 'n');
  const w = await watchOf(repo);
  git(repo, 'reset', '-q', 'HEAD~1');
  await new Promise((r) => setTimeout(r, 120));
  fs.rmSync(path.join(repo, 'n.ts'));
  assert.equal(await gits(w, 'n.ts'), undefined);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('watch: a stash drop read late, after an unrelated index write, is no pop', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'wip\n');
  git(repo, 'stash', 'push', '-q');
  await gits(w, 'a.ts');
  await sleep(120);
  git(repo, 'stash', 'apply', '-q');
  assert.equal(await gits(w, 'a.ts'), undefined);
  git(repo, 'stash', 'drop', '-q');
  await sleep(2200);
  write(repo, 'a.ts', 'agent\n');
  write(repo, 'n.ts', 'n\n');
  git(repo, 'add', 'n.ts');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: a delete long after reset HEAD~1, read after an unrelated index write, is not git', { skip: noGit }, async () => {
  const repo = featureRepo();
  write(repo, 'x.ts', 'x\n');
  git(repo, 'add', 'x.ts');
  git(repo, 'commit', '-qm', 'x');
  const w = await watchOf(repo);
  git(repo, 'reset', '-q', 'HEAD~1');
  await sleep(2200);
  fs.rmSync(path.join(repo, 'x.ts'));
  write(repo, 'n.ts', 'n\n');
  git(repo, 'add', 'n.ts');
  assert.equal(await gits(w, 'x.ts'), undefined);
});

test('watch: a stash in another worktree, then a status refresh here, is not this worktree\'s', { skip: noGit }, async () => {
  const repo = featureRepo();
  const wt = path.join(tempDir('at-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'main');
  const linked = await watchOf(wt);
  write(repo, 'a.ts', 'wip\n');
  git(repo, 'stash', 'push', '-q');
  await sleep(2200);
  write(wt, 'a.ts', 'edit\n');
  write(wt, 'a.ts', 'a1\n');
  git(wt, 'status', '--porcelain');
  assert.equal(await gits(linked, 'a.ts'), undefined);
});

test('watch: popping a stash that is not the newest is a pop', { skip: noGit }, async () => {
  const repo = featureRepo();
  const w = await watchOf(repo);
  write(repo, 'a.ts', 'wip a\n');
  git(repo, 'stash', 'push', '-q');
  await gits(w, 'a.ts');
  write(repo, 'b.ts', 'wip b\n');
  git(repo, 'stash', 'push', '-q');
  await gits(w, 'b.ts');
  git(repo, 'stash', 'pop', '-q', 'stash@{1}');
  assert.equal(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8'), 'wip a\n');
  assert.equal(await gits(w, 'a.ts'), 'stash pop');
});

const reftable = (() => {
  if (noGit) return noGit;
  try {
    git(tempDir('at-rt-probe-'), 'init', '-q', '--ref-format=reftable');
    return undefined;
  } catch {
    return 'git has no reftable support';
  }
})();

test('watch: in a reftable repository a removal then a commit is not git', { skip: reftable }, async () => {
  const repo = tempDir('at-rt-');
  git(repo, 'init', '-q', '-b', 'main', '--ref-format=reftable');
  write(repo, 'a.ts', 'a\n');
  write(repo, 'b.ts', 'b\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const w = await watchOf(repo);
  git(repo, 'rm', '-q', 'a.ts');
  git(repo, 'commit', '-qm', 'rm');
  assert.equal(await gits(w, 'a.ts'), undefined);
});

test('watch: in a reftable repository a switch in a linked worktree is git', { skip: reftable }, async () => {
  const repo = tempDir('at-rt-');
  git(repo, 'init', '-q', '-b', 'main', '--ref-format=reftable');
  write(repo, 'a.ts', 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  git(repo, 'branch', 'f2');
  const wt = path.join(tempDir('at-rt-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-q', wt, 'f2');
  git(wt, 'switch', '-qc', 'f3');
  write(wt, 'a.ts', 'a3\n');
  write(wt, 'c.ts', 'c\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'f3');
  git(wt, 'switch', '-q', 'f2');
  const w = await watchOf(wt);
  git(wt, 'switch', '-q', 'f3');
  assert.equal(await gits(w, 'a.ts'), 'checkout');
  assert.equal(await gits(w, 'c.ts'), 'checkout');
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
