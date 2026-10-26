// at-net.15: on Linux, VS Code's watcher reports a folder tree made several
// levels deep at once as its top folder alone, and never reports anything
// below it. The recorder watches the folders it missed itself; here a fake
// WatchDir stands in for those watches, driven by hand like the watcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GAP_WATCH_LIMIT, type WatchDir } from '../src/watchGaps';
import { committedRepo, laneOf, recorderOn, rm, settings, until } from './recorderScopeFixture';
import { git, noGit, tempDir, write } from './gitFixture';
import { mock, workspace } from './vscode-mock';

/**
 * Directory watches the test drives: `watched` lists them under a root, `entry`
 * reports a path as fs.watch would from its directory, `kill` drops a watch the
 * way the kernel does when its directory goes, and `opens` counts watches started.
 */
function fakeWatches() {
  const open = new Map<string, (name: string, kind: 'rename' | 'change') => void>();
  const opens = new Map<string, number>();
  const watchDir: WatchDir = (fsPath, onEntry) => {
    open.set(fsPath, onEntry);
    opens.set(fsPath, (opens.get(fsPath) ?? 0) + 1);
    return { close: () => open.get(fsPath) === onEntry && open.delete(fsPath) };
  };
  const kill = (dir: string) => open.delete(dir);
  const watched = (root: string) => [...open.keys()].map((d) => path.relative(root, d).split(path.sep).join('/')).sort();
  const entry = (file: string, kind: 'rename' | 'change') => {
    const onEntry = open.get(path.dirname(file));
    assert.ok(onEntry, `${path.dirname(file)} is not watched`);
    onEntry(path.basename(file), kind);
  };
  return { watchDir, watched, entry, kill, opens };
}

/** A recorder on a folder holding src/a.ts, with the fake watches. */
async function started() {
  const dir = tempDir('at-gap-');
  write(dir, 'src/a.ts', 'a\n');
  const w = fakeWatches();
  const s = settings();
  const t = recorderOn(s, { watchDir: w.watchDir }, dir);
  await t.recorder.start();
  const at = (rel: string) => path.join(dir, rel);
  return { dir, w, t, at, s };
}

test('writes in a folder tree made several levels deep at once are recorded through watches of the folders the watcher missed', async () => {
  const { dir, w, t, at } = await started();
  // mkdir -p and a write at once: the watcher reports only the top folder.
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c'], 'the folder the watcher reported is left to it');
  // Later, a write and a new file that only those watches see.
  write(dir, 'a/b/c/one.ts', 'one 2\n');
  w.entry(at('a/b/c/one.ts'), 'change');
  write(dir, 'a/b/c/two.ts', 'two\n');
  w.entry(at('a/b/c/two.ts'), 'rename');
  w.entry(at('a/b/c/two.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'modify a/b/c/one.ts', 'create a/b/c/two.ts']);
  assert.match(t.recorder.describeActivity(), /folder watch change a\/b\/c\/one\.ts/);
  // A rename is told apart from a delete by a stat; the write after it waits for that.
  assert.match(t.recorder.describeActivity(), /folder watch create a\/b\/c\/two\.ts\n[\s\S]*folder watch change a\/b\/c\/two\.ts/);
  // A tree made in a watched folder is blind too, all the way down.
  write(dir, 'a/b/c/d/e/z.ts', 'z\n');
  w.entry(at('a/b/c/d'), 'rename');
  await t.settle();
  assert.deepEqual(t.events().slice(3), ['create a/b/c/d/e/z.ts']);
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e']);
});

test('a folder the watcher reports itself, even late, is left to the watcher', async () => {
  const { dir, w, t, at } = await started();
  fs.mkdirSync(at('a'));
  t.fire('create', at('a'));
  fs.mkdirSync(at('a/b'));
  t.fire('create', at('a/b'));
  await t.settle();
  assert.deepEqual(w.watched(dir), [], 'the watcher saw both');
  // Its report of p/q comes after the walk of p found it: that watch stops, p/q/r's stays.
  fs.mkdirSync(at('p/q/r'), { recursive: true });
  t.fire('create', at('p'));
  await until('p/q and p/q/r watched', () => w.watched(dir).length === 2);
  t.fire('create', at('p/q'));
  await until('p/q left to the watcher', () => w.watched(dir).length === 1);
  await t.settle();
  assert.deepEqual(w.watched(dir), ['p/q/r']);
});

test('excluded folders in a tree made at once are not watched', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/node_modules/p/index.ts', 'p\n');
  write(dir, 'a/b/x.ts', 'x\n');
  t.fire('create', at('a'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b']);
  assert.deepEqual(t.events(), ['create a/b/x.ts']);
});

test('deleting a watched folder records its files deleted and stops the watches in it', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/d/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c', 'a/b/c/d']);
  // rm -rf a/b/c: the watch of a/b/c/d hears its file go after the folder is gone,
  // then names itself (as libuv does when the watched folder goes), and a/b's watch hears c go.
  await rm(at('a/b/c'));
  w.entry(at('a/b/c/d/one.ts'), 'rename');
  w.entry(at('a/b/c/d/d'), 'rename');
  w.entry(at('a/b/c'), 'rename');
  await until('watches in a/b/c stopped', () => w.watched(dir).length === 1);
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b']);
  assert.deepEqual(t.events(), ['create a/b/c/d/one.ts', 'delete a/b/c/d/one.ts']);
});

test('stopping closes every folder watch, and starting again watches the same folders', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  t.recorder.stop();
  assert.deepEqual(w.watched(dir), []);
  await t.recorder.start();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c'], 'the watcher is still blind there');
  write(dir, 'a/b/c/one.ts', 'one 2\n');
  w.entry(at('a/b/c/one.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'modify a/b/c/one.ts']);
});

test('a lane on a worktree added in a folder made while recording sees writes in it (at-net.15)', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  // git worktree add with no .claude yet: the watcher reports .claude alone.
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  t.fire('create', path.join(repo, '.claude'));
  await until('.claude/worktrees watched', () => w.watched(repo).includes('.claude/worktrees'));
  await t.settle();
  assert.deepEqual(t.events(), [], 'the worktree is not the folder checkout');
  assert.deepEqual(w.watched(repo), ['.claude/worktrees'], 'the folder checkout leaves the worktree to its own lane');
  await t.recorder.addCheckout(t.folder, x);
  assert.deepEqual(w.watched(repo), ['.claude/worktrees', '.claude/worktrees/x', '.claude/worktrees/x/src']);
  write(x, 'src/a.ts', 'a 2\n');
  w.entry(path.join(x, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
  assert.notEqual(laneOf(t, 0), t.folder.uri.toString(), 'recorded in the worktree lane');
});

test('a watched folder deleted and made again is watched again', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/gen/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/gen']);
  // rm -rf a/b/gen && mkdir a/b/gen, as a code generator does. The old watch hears one.ts and then
  // itself go, and the kernel drops it; a/b's two events are read once gen is back, so both look like creates.
  await rm(at('a/b/gen'));
  fs.mkdirSync(at('a/b/gen'));
  w.entry(at('a/b/gen/one.ts'), 'rename');
  w.entry(at('a/b/gen/gen'), 'rename');
  w.kill(at('a/b/gen'));
  w.entry(at('a/b/gen'), 'rename');
  w.entry(at('a/b/gen'), 'rename');
  await until('gen watched again', () => w.watched(dir).includes('a/b/gen'));
  await t.settle();
  assert.ok(w.opens.get(at('a/b/gen'))! >= 2);
  write(dir, 'a/b/gen/one.ts', 'one 2\n');
  w.entry(at('a/b/gen/one.ts'), 'rename');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/gen/one.ts', 'delete a/b/gen/one.ts', 'create a/b/gen/one.ts']);
});

test('a folder excluded later is no longer watched', async () => {
  const { dir, w, t, at, s } = await started();
  fs.mkdirSync(at('gen/a/b'), { recursive: true });
  fs.mkdirSync(at('keep/c'), { recursive: true });
  t.fire('create', at('gen'));
  t.fire('create', at('keep'));
  await until('both trees watched', () => w.watched(dir).length === 3);
  s.exclude = [...s.exclude, 'gen/**'];
  await t.recorder.refreshFilter();
  assert.deepEqual(w.watched(dir), ['keep/c']);
});

test('a lane on a worktree in a new folder watches it even when added before that folder is reported', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  // Added at once, from code: the watcher's report of .claude has not been read yet.
  await t.recorder.addCheckout(t.folder, x);
  assert.deepEqual(w.watched(repo), [], 'nothing is known to be blind yet');
  t.fire('create', path.join(repo, '.claude'));
  await until('the lane watches its checkout', () => w.watched(repo).includes('.claude/worktrees/x/src'));
  write(x, 'src/a.ts', 'a 2\n');
  w.entry(path.join(x, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
  // Removing the lane lets go of its watches; the folder checkout keeps its own.
  await t.recorder.removeCheckout(t.folder, x);
  assert.deepEqual(w.watched(repo), ['.claude/worktrees']);
});

test('a lane is not held back by another lane that reached its limit of watches', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  // Over the limit of new folders in the folder checkout, made at once.
  for (let i = 0; i <= GAP_WATCH_LIMIT; i++) fs.mkdirSync(path.join(repo, 'big', 'many', `d${i}`), { recursive: true });
  t.fire('create', path.join(repo, 'big'));
  await until('the folder checkout at its limit', () => w.watched(repo).length === GAP_WATCH_LIMIT);
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  t.fire('create', path.join(repo, '.claude'));
  await t.settle();
  await t.recorder.addCheckout(t.folder, x);
  assert.ok(w.watched(repo).includes('.claude/worktrees/x/src'), 'the lane watches its checkout');
  write(x, 'src/a.ts', 'a 2\n');
  w.entry(path.join(x, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
  const limits = t.logs.filter((l) => l.includes(`over ${GAP_WATCH_LIMIT} new folders`));
  assert.equal(limits.length, 1, limits.join('\n'));
  assert.ok(limits[0].startsWith(`${t.timeline.laneInfo(t.folder.uri.toString())!.label}: `), 'named by the lane that reached it');
});

test('a folder deleted and made again in one batch, which the watcher reports as changed, is checked and walked again', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'gen/api/v1/one.ts', 'one\n');
  t.fire('create', at('gen'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['gen/api', 'gen/api/v1']);
  // rm -rf gen/api: its watches hear it go, before mkdir runs, and forget it.
  await rm(at('gen/api'));
  w.entry(at('gen/api/v1/one.ts'), 'rename');
  w.entry(at('gen/api/v1/v1'), 'rename');
  w.entry(at('gen/api/v1'), 'rename');
  w.entry(at('gen/api/api'), 'rename');
  await until('the old watches gone', () => w.watched(dir).length === 0);
  // mkdir -p gen/api/v1 and a write: VS Code's watcher merges the delete and create of gen/api into a change.
  write(dir, 'gen/api/v1/two.ts', 'two\n');
  t.fire('change', at('gen/api'));
  await until('gen/api/v1 watched again', () => w.watched(dir).includes('gen/api/v1'));
  await t.settle();
  assert.deepEqual(t.events().slice(1).sort(), ['create gen/api/v1/two.ts', 'delete gen/api/v1/one.ts']);
  write(dir, 'gen/api/v1/two.ts', 'two 2\n');
  w.entry(at('gen/api/v1/two.ts'), 'change');
  await t.settle();
  assert.equal(t.events()[3], 'modify gen/api/v1/two.ts');
});

test('a folder that was there before recording, deleted and made again in one batch, is checked and walked again', async () => {
  const dir = tempDir('at-gap-');
  write(dir, 'src/gen/one.ts', 'one\n');
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, dir);
  await t.recorder.start();
  await rm(path.join(dir, 'src/gen'));
  write(dir, 'src/gen/v1/two.ts', 'two\n');
  t.fire('change', path.join(dir, 'src/gen'));
  await until('src/gen/v1 watched', () => w.watched(dir).includes('src/gen/v1'));
  await t.settle();
  assert.deepEqual(t.events().sort(), ['create src/gen/v1/two.ts', 'delete src/gen/one.ts']);
});

test('a change the watcher reports for a folder made long ago, with nothing of it known, is left alone', async () => {
  const { t, at } = await started();
  const stat = workspace.fs.stat;
  workspace.fs.stat = async (uri) => ({ ...(await stat(uri)), ctime: 0 });
  try {
    t.fire('change', at('src'));
    await t.settle();
  } finally {
    workspace.fs.stat = stat;
  }
  assert.doesNotMatch(t.recorder.describeActivity(), /made again/);
  assert.deepEqual(t.events(), []);
});

test('a lane stopped while one of its walks waits takes no watches from that walk', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  t.fire('create', path.join(repo, '.claude'));
  await until('.claude/worktrees watched', () => w.watched(repo).includes('.claude/worktrees'));
  await t.settle();
  await t.recorder.addCheckout(t.folder, x);
  // A deep tree made in the lane, whose walk waits on a slow directory read.
  fs.mkdirSync(path.join(x, 'src', 'n', 'a', 'b'), { recursive: true });
  let open!: () => void;
  mock.readDirectoryGate = new Promise<void>((r) => (open = r));
  w.entry(path.join(x, 'src', 'n'), 'rename');
  await until('the walk started', () => w.watched(repo).includes('.claude/worktrees/x/src/n'));
  const removing = t.recorder.removeCheckout(t.folder, x);
  await until('the lane stopped', () => t.recorder.recordedLanes().length === 1);
  open();
  mock.readDirectoryGate = undefined;
  await removing;
  await t.settle();
  assert.deepEqual(w.watched(repo), ['.claude/worktrees']);
});

test('a lane keeps watching its checkout when its root is reported made after the lane started', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  // Added at once, from code; the watcher reports x after.
  await t.recorder.addCheckout(t.folder, x);
  assert.deepEqual(w.watched(repo), []);
  t.fire('create', x);
  await until('the lane watches x/src', () => w.watched(repo).includes('.claude/worktrees/x/src'));
  write(x, 'src/a.ts', 'a 2\n');
  w.entry(path.join(x, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
});

test('a lane keeps watching its checkout when a folder watch reports its root made after the lane started', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const x = path.join(repo, '.claude', 'worktrees', 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'x', x);
  t.fire('create', path.join(repo, '.claude'));
  await until('.claude/worktrees watched', () => w.watched(repo).includes('.claude/worktrees'));
  await t.settle();
  await t.recorder.addCheckout(t.folder, x);
  // The watch of .claude/worktrees reports x late, after the lane walked it.
  w.entry(x, 'rename');
  await until('x/src watched again', () => w.opens.get(path.join(x, 'src')) === 2);
  await t.settle();
  write(x, 'src/a.ts', 'a 2\n');
  w.entry(path.join(x, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
});

test('a file written in many chunks in a watched folder is passed on once per short while', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  for (let i = 0; i < 100; i++) {
    fs.appendFileSync(at('a/b/one.ts'), `${i}\n`);
    w.entry(at('a/b/one.ts'), 'change');
  }
  await t.settle();
  const passed = t.recorder.describeActivity().split('\n').filter((l) => l.includes('folder watch change a/b/one.ts'));
  assert.equal(passed.length, 1);
  assert.deepEqual(t.events(), ['create a/b/one.ts', 'modify a/b/one.ts']);
});
