// at-net.15: on Linux, VS Code's watcher reports a folder tree made several
// levels deep at once as its top folder alone, and never reports anything
// below it. The recorder watches the folders it missed itself; here a fake
// WatchDir stands in for those watches, driven by hand like the watcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GAP_WATCH_LIMIT, nodeWatchDir, shareOfSystemWatches, type WatchDir } from '../src/watchGaps';
import { committedRepo, laneOf, recorderOn, rm, settings, until } from './recorderScopeFixture';
import { git, noGit, tempDir, write } from './gitFixture';
import { mock, Uri, workspace } from './vscode-mock';

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

test('a new worktree in a folder made while recording waits with folder watches: its first write, seen only by one, gives it a lane, and one that stops waiting lets go of them', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const s = settings({ autoRecordWorktrees: 'fill' });
  const t = recorderOn(s, { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const common = path.join(fs.realpathSync.native(repo), '.git', 'worktrees');
  // A review tool's worktree with no .claude yet: the watcher reports .claude alone.
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  const fix = path.join(repo, '.claude', 'worktrees', 'fix');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', fix);
  t.fire('create', path.join(repo, '.claude'));
  t.fire('create', path.join(common, 'review-1'));
  t.fire('create', path.join(common, 'fix'));
  await until('both wait with their folders watched', () => ['review-1/src', 'fix/src'].every((d) => w.watched(repo).includes(`.claude/worktrees/${d}`)));
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1, 'no lane while they wait');
  write(fix, 'src/a.ts', 'fixed\n');
  w.entry(path.join(fix, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify fix/src/a.ts']);
  assert.equal(t.checkout()?.lanes, 2);
  // Still there, it stops waiting once it matches a pattern.
  s.autoIgnoreWorktrees = ['review-*'];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.deepEqual(
    w.watched(repo).filter((d) => d.includes('review-1')),
    [],
    'it lets go of its watches',
  );
  assert.ok(w.watched(repo).includes('.claude/worktrees/fix/src'), 'the lane keeps its own');
  assert.equal(t.checkout()?.lanes, 2);
});

test('a waiting worktree in a folder made while recording, removed and made again within one listing, is watched again even when no folder event tells', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  git(repo, 'checkout', '-q', '-b', 'pr');
  write(repo, 'src/a.ts', 'pr\n');
  git(repo, 'commit', '-q', '-am', 'pr');
  git(repo, 'checkout', '-q', 'main');
  const w = fakeWatches();
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const common = path.join(fs.realpathSync.native(repo), '.git', 'worktrees');
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
  t.fire('create', path.join(repo, '.claude'));
  t.fire('create', path.join(common, 'review-1'));
  await until('it waits with its folders watched', () => w.watched(repo).includes('.claude/worktrees/review-1/src'));
  await t.settle();
  const opens = w.opens.get(path.join(review, 'src'))!;
  // Removed and made again from pr: the kernel drops the old watches, and what the folder watch above saw is lost.
  git(repo, 'worktree', 'remove', '--force', review);
  w.kill(path.join(review, 'src'));
  w.kill(review);
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'pr');
  t.fire('delete', path.join(common, 'review-1'));
  t.fire('create', path.join(common, 'review-1'));
  await until('its folders are watched again', () => (w.opens.get(path.join(review, 'src')) ?? 0) > opens && w.watched(repo).includes('.claude/worktrees/review-1/src'));
  await t.settle();
  assert.deepEqual(t.events(), []);
  write(review, 'src/a.ts', 'reviewed\n');
  w.entry(path.join(review, 'src/a.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
  assert.equal(t.timeline.all()[0].before, 'pr\n');
});

const fewWatches = shareOfSystemWatches() < GAP_WATCH_LIMIT + 100 ? 'the system allows too few inotify watches' : undefined;

test('a lane is not held back by another lane that reached its limit of watches', { skip: noGit ?? fewWatches }, async () => {
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

test('a change the watcher reports for a folder nothing is known of is left alone, made again or not', async () => {
  const dir = tempDir('at-gap-');
  write(dir, 'src/gen/one.ts', 'one\n');
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, dir);
  await t.recorder.start();
  // Its attributes changed, as far likelier for a folder that was there before recording.
  t.fire('change', path.join(dir, 'src'));
  // Or made again in one quick step, which cannot be told apart from that.
  await rm(path.join(dir, 'src/gen'));
  write(dir, 'src/gen/v1/two.ts', 'two\n');
  t.fire('change', path.join(dir, 'src/gen'));
  await t.settle();
  assert.doesNotMatch(t.recorder.describeActivity(), /made again/);
  assert.deepEqual(w.watched(dir), []);
  assert.deepEqual(t.events(), []);
});

test('a change the watcher reports for a watched folder whose attributes changed records nothing and leaves it watched (chmod)', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'scripts/bin/run.ts', 'run\n');
  t.fire('create', at('scripts'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['scripts/bin']);
  fs.chmodSync(at('scripts/bin'), 0o700);
  t.fire('change', at('scripts/bin'));
  await t.settle();
  assert.match(t.recorder.describeActivity(), /checking again scripts\/bin/);
  assert.deepEqual(w.watched(dir), ['scripts/bin']);
  write(dir, 'scripts/bin/new.ts', 'new\n');
  w.entry(at('scripts/bin/new.ts'), 'rename');
  await t.settle();
  assert.deepEqual(t.events(), ['create scripts/bin/run.ts', 'create scripts/bin/new.ts']);
});

test('a folder whose attributes change under a folder watch records nothing and is watched again, even just after baselines are taken', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // Baselines taken again just now, of a file written a while ago: a create read within moments of one is taken for a new file.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(at('a/b/c/one.ts'), old, old);
  await t.recorder.refreshBaselines();
  const before = t.recorder.describeActivity().split('\n').length;
  // chmod a/b/c: fs.watch on a/b says 'rename c', as for c deleted or made.
  fs.chmodSync(at('a/b/c'), 0o700);
  w.entry(at('a/b/c'), 'rename');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c'], 'watched again');
  assert.doesNotMatch(t.recorder.describeActivity().split('\n').slice(before - 1).join('\n'), /in directory create/, 'its file is no new one');
  write(dir, 'a/b/c/one.ts', 'one 2\n');
  w.entry(at('a/b/c/one.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'modify a/b/c/one.ts']);
});

test('with real folder watches, a chmod of a watched folder records nothing and writes in it are still recorded', { skip: process.platform !== 'linux' && 'fs.watch reports folders this way on Linux' }, async () => {
  const dir = tempDir('at-gap-');
  write(dir, 'src/a.ts', 'a\n');
  const t = recorderOn(settings(), { watchDir: nodeWatchDir }, dir);
  await t.recorder.start();
  const at = (rel: string) => path.join(dir, rel);
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await until('one.ts created', () => t.events().includes('create a/b/c/one.ts'));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(at('a/b/c/one.ts'), old, old);
  await t.settle(300);
  await t.recorder.refreshBaselines();
  fs.chmodSync(at('a/b/c'), 0o700);
  fs.chmodSync(at('a/b'), 0o700);
  t.fire('change', at('a/b'));
  await t.settle(300);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
  fs.writeFileSync(at('a/b/c/one.ts'), 'one 2\n');
  fs.writeFileSync(at('a/b/two.ts'), 'two\n');
  await until('both written', () => t.events().length === 3);
  await t.settle();
  assert.deepEqual(t.events().slice(1).sort(), ['create a/b/two.ts', 'modify a/b/c/one.ts']);
});

test('deletes reported by folder watches a tick apart share one pass over the baselines', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // Real stats take a tick or more, so the events of folder watches are handled a tick apart.
  const stat = workspace.fs.stat;
  workspace.fs.stat = async (uri) => {
    await new Promise((r) => setImmediate(r));
    return stat(uri);
  };
  // keysUnder is the pass over every baseline; count how often it runs.
  const recorder = t.recorder as unknown as { keysUnder(dirs: Set<string>): string[] };
  const keysUnder = recorder.keysUnder.bind(recorder);
  let passes = 0;
  recorder.keysUnder = (dirs) => {
    passes++;
    return keysUnder(dirs);
  };
  try {
    fs.rmSync(at('a/b/one.ts'));
    // Temp files of atomic writes, gone by the time they are read.
    for (let i = 0; i < 50; i++) w.entry(at(`a/b/tmp${i}.ts`), 'rename');
    w.entry(at('a/b/one.ts'), 'rename');
    await t.settle(300);
  } finally {
    workspace.fs.stat = stat;
  }
  assert.ok(passes <= 2, `${passes} passes`);
  assert.deepEqual(t.events(), ['create a/b/one.ts', 'delete a/b/one.ts']);
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
  // The watch of .claude/worktrees reports x late, after the lane walked it: checked again, and still watched.
  w.entry(x, 'rename');
  await t.settle();
  assert.ok(w.watched(repo).includes('.claude/worktrees/x/src'));
  assert.deepEqual(t.events(), []);
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

test('a watched folder made again is watched again when the watcher reports it changed before its old watches say it went', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'gen/api/v1/one.ts', 'one\n');
  t.fire('create', at('gen'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['gen/api', 'gen/api/v1']);
  // rm -rf gen/api && mkdir -p gen/api/v1: the kernel drops the old watches. On ext4 the new folders mostly get
  // the old inode numbers, and before Linux 6.13 the same birth times, so nothing about them looks new.
  await rm(at('gen/api'));
  write(dir, 'gen/api/v1/two.ts', 'two\n');
  w.kill(at('gen/api'));
  w.kill(at('gen/api/v1'));
  t.fire('change', at('gen/api'));
  await until('gen/api/v1 watched again', () => w.watched(dir).includes('gen/api/v1'));
  await t.settle();
  assert.deepEqual(t.events().slice(1).sort(), ['create gen/api/v1/two.ts', 'delete gen/api/v1/one.ts']);
  write(dir, 'gen/api/v1/two.ts', 'two 2\n');
  w.entry(at('gen/api/v1/two.ts'), 'change');
  await t.settle();
  assert.equal(t.events()[3], 'modify gen/api/v1/two.ts');
});

test('a watched folder made again is still watched when the watcher reports the old one deleted after it was watched again', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'gen/api/v1/one.ts', 'one\n');
  t.fire('create', at('gen'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['gen/api', 'gen/api/v1']);
  // rm -rf gen/api && mkdir -p gen/api/v1 and a write. The old watches hear one.ts, v1 and themselves go,
  // read once the folders are back, and the kernel drops them; v1 there again is checked and watched again.
  await rm(at('gen/api'));
  write(dir, 'gen/api/v1/two.ts', 'two\n');
  w.entry(at('gen/api/v1/one.ts'), 'rename');
  w.entry(at('gen/api/v1/v1'), 'rename');
  w.entry(at('gen/api/v1'), 'rename');
  w.entry(at('gen/api/api'), 'rename');
  w.kill(at('gen/api/v1'));
  w.kill(at('gen/api'));
  await until('the new gen/api/v1 watched', () => w.watched(dir).includes('gen/api/v1'));
  await t.settle();
  assert.deepEqual(t.events().slice(1).sort(), ['create gen/api/v1/two.ts', 'delete gen/api/v1/one.ts']);
  // Only now does VS Code's watcher report the old gen/api deleted: what was known of it goes, and the new one is watched.
  t.fire('delete', at('gen/api'));
  await t.settle();
  assert.match(t.recorder.describeActivity(), /checking again gen\/api\n/);
  assert.deepEqual(w.watched(dir), ['gen/api', 'gen/api/v1']);
  write(dir, 'gen/api/v1/two.ts', 'two 2\n');
  w.entry(at('gen/api/v1/two.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events().slice(3), ['modify gen/api/v1/two.ts']);
});

test('a watched folder moved away and back at once is watched again', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c']);
  // mv a/b a/b.tmp: the watch of a/b names itself while b is away, and the watches in it stop.
  fs.renameSync(at('a/b'), at('a/b.tmp'));
  w.entry(at('a/b/b'), 'rename');
  await until('the watches stopped', () => w.watched(dir).length === 0);
  // mv a/b.tmp a/b in the same batch: VS Code's watcher reports a/b changed.
  fs.renameSync(at('a/b.tmp'), at('a/b'));
  t.fire('change', at('a/b'));
  await until('a/b/c watched again', () => w.watched(dir).includes('a/b/c'));
  write(dir, 'a/b/c/one.ts', 'one 2\n');
  w.entry(at('a/b/c/one.ts'), 'change');
  await t.settle();
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'modify a/b/c/one.ts']);
});

test('deletes are swept without waiting for folder watch events that came after them', async () => {
  const { w, t, at } = await started();
  fs.mkdirSync(at('a/b'), { recursive: true });
  t.fire('create', at('a'));
  await t.settle();
  // The stats of two temp files wait until let go, and the events behind them wait too.
  const stat = workspace.fs.stat;
  const release = new Map<string, () => void>();
  const gates = new Map(['tmp1', 'tmp2'].map((name) => [name, new Promise<void>((r) => release.set(name, r))]));
  workspace.fs.stat = async (uri) => {
    await gates.get(path.basename(uri.fsPath));
    return stat(uri);
  };
  try {
    w.entry(at('a/b/tmp1'), 'rename');
    // src is deleted elsewhere while that event waits, and another event comes after.
    await rm(at('src'));
    t.fire('delete', at('src'));
    w.entry(at('a/b/tmp2'), 'rename');
    release.get('tmp1')!();
    await until('src/a.ts deleted', () => t.events().includes('delete src/a.ts'));
  } finally {
    release.get('tmp2')!();
    workspace.fs.stat = stat;
  }
  await t.settle();
});

test('a watched folder replaced by a file is forgotten and what was recorded in it is deleted', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  write(dir, 'gen/api/v1/two.ts', 'two\n');
  t.fire('create', at('a'));
  t.fire('create', at('gen'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c', 'gen/api', 'gen/api/v1']);
  // Seen by the watch of a/b, with the events of c's own watch lost.
  await rm(at('a/b/c'));
  fs.writeFileSync(at('a/b/c'), 'a file\n');
  w.entry(at('a/b/c'), 'rename');
  // Seen by VS Code's watcher, which merges the delete and create into a change.
  await rm(at('gen/api'));
  fs.writeFileSync(at('gen/api'), 'a file\n');
  t.fire('change', at('gen/api'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b']);
  assert.deepEqual(t.events().slice(2).sort(), ['delete a/b/c/one.ts', 'delete gen/api/v1/two.ts']);
});

test('a new folder whose event waits while a walk of the baselines watches it first still has its files recorded as created', async () => {
  const { dir, w, t, at } = await started();
  fs.mkdirSync(at('a/b'), { recursive: true });
  t.fire('create', at('a'));
  await t.settle();
  const stat = workspace.fs.stat;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  workspace.fs.stat = async (uri) => {
    if (path.basename(uri.fsPath) === 'slow') await gate;
    return stat(uri);
  };
  try {
    // An event waiting on a slow stat holds the ones behind it.
    w.entry(at('a/b/slow'), 'rename');
    write(dir, 'a/b/d/f.ts', 'f\n');
    w.entry(at('a/b/d'), 'rename');
    // Baselines taken meanwhile: the walk watches d and reads f.ts as a file that was there.
    await t.recorder.refreshBaselines();
    assert.ok(w.watched(dir).includes('a/b/d'));
    release();
    await t.settle();
  } finally {
    workspace.fs.stat = stat;
  }
  assert.deepEqual(t.events(), ['create a/b/d/f.ts']);
});

test('a new folder a folder watch reports takes no pass over the baselines', async () => {
  const { dir, w, t, at } = await started();
  fs.mkdirSync(at('a/b'), { recursive: true });
  t.fire('create', at('a'));
  await t.settle();
  const recorder = t.recorder as unknown as { keysUnder(dirs: Set<string>): string[] };
  const keysUnder = recorder.keysUnder.bind(recorder);
  let passes = 0;
  recorder.keysUnder = (dirs) => {
    passes++;
    return keysUnder(dirs);
  };
  write(dir, 'a/b/n/x.ts', 'x\n');
  w.entry(at('a/b/n'), 'rename');
  await t.settle();
  assert.equal(passes, 0);
  assert.deepEqual(t.events(), ['create a/b/n/x.ts']);
});

test('a file only a folder watch saw replaced by a folder leaves that folder watched', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/x.ts', 'x\n');
  t.fire('create', at('a'));
  await t.settle();
  // A write is reported, and by the time it is read x.ts is a folder; the renames of it went unseen.
  fs.rmSync(at('a/b/x.ts'));
  write(dir, 'a/b/x.ts/y.ts', 'y\n');
  w.entry(at('a/b/x.ts'), 'change');
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/x.ts']);
  assert.deepEqual(t.events(), ['create a/b/x.ts', 'delete a/b/x.ts', 'create a/b/x.ts/y.ts']);
});

test('folders reported changed together are checked once, from the outermost', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // tar sets the times of the folders it made once their files are in: VS Code's watcher reports a and a/b, the watch of a/b reports c.
  for (const d of ['a/b/c', 'a/b', 'a']) fs.utimesSync(at(d), new Date(), new Date());
  w.entry(at('a/b/c'), 'rename');
  t.fire('change', at('a/b'));
  t.fire('change', at('a'));
  await t.settle();
  const checked = [...t.recorder.describeActivity().matchAll(/checking again (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(checked, ['a']);
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c']);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
});

test('a chmod of a watched folder records nothing for a file in it left without a baseline', async () => {
  const dir = tempDir('at-gap-');
  write(dir, 'src/a.ts', 'a\n');
  const w = fakeWatches();
  const t = recorderOn(settings({ baselineBudgetMB: 0 }), { watchDir: w.watchDir }, dir);
  await t.recorder.start();
  const at = (rel: string) => path.join(dir, rel);
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // Started again with no room for baselines: one.ts has none, and its folders are still known.
  t.recorder.stop();
  await t.recorder.start();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c']);
  // chmod a/b/c under the watch of a/b, and touch a, which VS Code's watcher reports.
  fs.chmodSync(at('a/b/c'), 0o700);
  w.entry(at('a/b/c'), 'rename');
  t.fire('change', at('a'));
  await t.settle(200);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
  // A file made since is new.
  write(dir, 'a/b/c/two.ts', 'two\n');
  w.kill(at('a/b/c'));
  t.fire('change', at('a'));
  await t.settle(200);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'create a/b/c/two.ts']);
});

test('a chmod of a watched folder while baselines are still being taken records nothing', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  t.recorder.stop();
  // The next start takes its baselines slowly, as in a large repository.
  let release!: () => void;
  mock.readFileGate = new Promise<void>((r) => (release = r));
  const starting = t.recorder.start();
  try {
    await until('a/b/c watched again', () => w.watched(dir).includes('a/b/c'));
    fs.chmodSync(at('a/b/c'), 0o700);
    w.entry(at('a/b/c'), 'rename');
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    release();
    mock.readFileGate = undefined;
  }
  await starting;
  await t.settle(200);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
});

test('a watched folder that cannot be read when checked again is not taken for empty', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // chmod 000 a/b/c: reading it, or stating what is in it, is denied.
  const locked = at('a/b/c');
  const { stat, readDirectory } = workspace.fs;
  const denied = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  workspace.fs.stat = async (uri) => {
    if (uri.fsPath.startsWith(locked + path.sep)) throw denied();
    return stat(uri);
  };
  workspace.fs.readDirectory = async (uri) => {
    if (uri.fsPath === locked) throw denied();
    return readDirectory(uri);
  };
  try {
    w.entry(locked, 'rename');
    await t.settle(200);
  } finally {
    Object.assign(workspace.fs, { stat, readDirectory });
  }
  // chmod 755 a/b/c again.
  w.entry(locked, 'rename');
  await t.settle(200);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
});

test('a write in a lane while a folder above its checkout is checked again is recorded', { skip: noGit }, async () => {
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
  // touch .claude/worktrees, which VS Code's watcher reports; its check waits on a slow read.
  let release!: () => void;
  mock.readDirectoryGate = new Promise<void>((r) => (release = r));
  try {
    t.fire('change', path.join(repo, '.claude', 'worktrees'));
    await until('the watches in it stopped for the check', () => !w.watched(repo).includes('.claude/worktrees/x/src'));
    // The lane's agent writes while nothing watches x/src.
    write(x, 'src/a.ts', 'a 2\n');
  } finally {
    release();
    mock.readDirectoryGate = undefined;
  }
  await until('x/src watched again', () => w.watched(repo).includes('.claude/worktrees/x/src'));
  await t.settle(200);
  assert.deepEqual(t.events(), ['modify x/src/a.ts']);
});

test('a folder checked again reads no file that is as it was, and keeps git baselines out of memory', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  const at = (rel: string) => path.join(repo, rel);
  for (let i = 0; i < 20; i++) write(repo, `a/b/c/f${i}.ts`, `f${i}\n`);
  t.fire('create', at('a'));
  await t.settle();
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'generated');
  // Started again: the generated files are clean, so their baselines are git's.
  t.recorder.stop();
  await t.recorder.start();
  const r = t.recorder as unknown as { gitBaselines: Map<string, unknown>; snapshots: Map<string, unknown> };
  const gitBaselines = r.gitBaselines.size;
  const reads: string[] = [];
  mock.onReadFile = (p) => reads.push(p);
  fs.writeFileSync(at('a/b/c/f0.ts'), 'f0 changed\n');
  fs.chmodSync(at('a/b/c'), 0o700);
  w.entry(at('a/b/c'), 'rename');
  await t.settle(200);
  mock.onReadFile = undefined;
  assert.deepEqual(reads.map((p) => path.basename(p)), ['f0.ts'], 'only the file that changed is read');
  assert.equal(r.gitBaselines.size, gitBaselines - 1);
  assert.deepEqual(t.events().slice(20), ['modify a/b/c/f0.ts']);
});

test('a folder VS Code\'s watcher reports something in is left to it, with what is known in it', async () => {
  const { dir, w, t, at } = await started();
  for (const d of ['a', 'a/b', 'a/b/c']) {
    fs.mkdirSync(at(d));
    t.fire('create', at(d));
    await t.settle();
  }
  assert.deepEqual(w.watched(dir), []);
  // touch a: the folders in it may be new ones VS Code's watcher does not see into, so they are watched.
  t.fire('change', at('a'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b', 'a/b/c']);
  // A write it reports in a/b shows it watches a/b after all.
  write(dir, 'a/b/x.ts', 'x\n');
  t.fire('create', at('a/b/x.ts'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['a/b/c']);
  assert.deepEqual(t.events(), ['create a/b/x.ts']);
});

test('a watched folder\'s own events and temp files gone from it take no pass over the baselines', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  const recorder = t.recorder as unknown as { keysUnder(dirs: Set<string>): string[] };
  const keysUnder = recorder.keysUnder.bind(recorder);
  let passes = 0;
  recorder.keysUnder = (dirs) => {
    passes++;
    return keysUnder(dirs);
  };
  const before = t.recorder.describeActivity().split('\n').length;
  // chmod a/b/c: its own watch names it, as fs.watch does.
  fs.chmodSync(at('a/b/c'), 0o700);
  w.entry(at('a/b/c/c'), 'rename');
  // An atomic write's temp file, gone by the time it is read.
  w.entry(at('a/b/c/.one.ts.tmp'), 'rename');
  await t.settle();
  assert.equal(passes, 0);
  assert.doesNotMatch(t.recorder.describeActivity().split('\n').slice(before - 1).join('\n'), /delete a\/b\/c\/c/);
  assert.deepEqual(t.events(), ['create a/b/c/one.ts']);
});

test('a folder made again from an older copy moved in has the files it brings recorded as created', async () => {
  const { dir, t, at } = await started();
  // An older copy of lib, holding a file lib lacks.
  write(dir, 'old/lib/x.ts', 'x old\n');
  write(dir, 'old/lib/y.ts', 'y\n');
  await new Promise((r) => setTimeout(r, 100));
  write(dir, 'lib/x.ts', 'x\n');
  t.fire('create', at('lib'));
  await t.settle();
  // rm -rf lib && mv old/lib lib: VS Code's watcher merges the delete and create of lib into a change.
  fs.rmSync(at('lib'), { recursive: true });
  fs.renameSync(at('old/lib'), at('lib'));
  t.fire('change', at('lib'));
  await t.settle(200);
  assert.deepEqual(t.events(), ['create lib/x.ts', 'modify lib/x.ts', 'create lib/y.ts']);
});

test('a folder made again with a file of the same size and mtime has its change recorded', async () => {
  const { dir, t, at } = await started();
  // An archive unpacked again: a fixed mtime, the same size, a new text.
  const fixed = new Date('1985-10-26T08:15:00Z');
  write(dir, 'vendor/pkg/version.ts', 'export const v = "1.2.3";\n');
  fs.utimesSync(at('vendor/pkg/version.ts'), fixed, fixed);
  t.fire('create', at('vendor'));
  await t.settle();
  fs.rmSync(at('vendor/pkg'), { recursive: true });
  write(dir, 'vendor/pkg/version.ts', 'export const v = "1.2.4";\n');
  fs.utimesSync(at('vendor/pkg/version.ts'), fixed, fixed);
  t.fire('change', at('vendor/pkg'));
  await t.settle(200);
  assert.deepEqual(t.events(), ['create vendor/pkg/version.ts', 'modify vendor/pkg/version.ts']);
});

test('a new file whose birth time reads a little before its folder was last read is still created', async () => {
  const { dir, w, t, at } = await started();
  write(dir, 'a/b/c/one.ts', 'one\n');
  t.fire('create', at('a'));
  await t.settle();
  // Made just after that read, its event lost; a coarse clock stamps its birth up to a tick early.
  const gaps = (t.recorder as unknown as { gaps: { lastScan(dir: string): { at: number } | undefined } }).gaps;
  const readAt = gaps.lastScan(Uri.file(at('a/b/c')).path)!.at;
  write(dir, 'a/b/c/two.ts', 'two\n');
  const stat = workspace.fs.stat;
  workspace.fs.stat = async (uri) => {
    const st = await stat(uri);
    return path.basename(uri.fsPath) === 'two.ts' ? { ...st, ctime: readAt - 4 } : st;
  };
  try {
    fs.chmodSync(at('a/b/c'), 0o700);
    w.entry(at('a/b/c'), 'rename');
    await t.settle(200);
  } finally {
    workspace.fs.stat = stat;
  }
  assert.deepEqual(t.events(), ['create a/b/c/one.ts', 'create a/b/c/two.ts']);
});

test('events another extension\'s watcher reports in a folder we watch outside the workspace leave our watches be', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const wt = `${repo}-wt`;
  git(repo, 'worktree', 'add', '-q', '-b', 'wt', wt);
  const w = fakeWatches();
  const t = recorderOn(settings(), { watchDir: w.watchDir }, repo);
  await t.recorder.start();
  await t.recorder.addCheckout(t.folder, wt);
  // mkdir -p in the lane, outside the workspace: VS Code's watcher of the lane reports src/new alone.
  fs.mkdirSync(path.join(wt, 'src', 'new', 'sub'), { recursive: true });
  t.fire('create', path.join(wt, 'src', 'new'));
  await until('src/new/sub watched', () => w.watched(wt).includes('src/new/sub'));
  // The TypeScript server watches src/new/sub without recursion, and its events reach us too.
  write(wt, 'src/new/sub/f.ts', 'f\n');
  t.fire('create', path.join(wt, 'src', 'new', 'sub', 'f.ts'));
  fs.mkdirSync(path.join(wt, 'src', 'new', 'sub', 'deeper'));
  t.fire('create', path.join(wt, 'src', 'new', 'sub', 'deeper'));
  await t.settle();
  assert.deepEqual(w.watched(wt).filter((d) => d.startsWith('src/new')), ['src/new/sub', 'src/new/sub/deeper']);
  write(wt, 'src/new/sub/deeper/g.ts', 'g\n');
  w.entry(path.join(wt, 'src', 'new', 'sub', 'deeper', 'g.ts'), 'rename');
  await t.settle();
  const name = path.basename(wt);
  assert.deepEqual(t.events().sort(), [`create ${name}/src/new/sub/deeper/g.ts`, `create ${name}/src/new/sub/f.ts`]);
});

test('a folder named like the one it is in, deleted while its watch was refused, has its files recorded as deleted', async () => {
  const dir = tempDir('at-gap-');
  write(dir, 'src/a.ts', 'a\n');
  const w = fakeWatches();
  const refused = (fsPath: string) => path.basename(fsPath) === 'mysite' && path.basename(path.dirname(fsPath)) === 'mysite';
  const watchDir: WatchDir = (fsPath, onEntry, onError) => {
    if (refused(fsPath)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return w.watchDir(fsPath, onEntry, onError);
  };
  const t = recorderOn(settings(), { watchDir }, dir);
  await t.recorder.start();
  const at = (rel: string) => path.join(dir, rel);
  write(dir, 'p/mysite/mysite/settings.ts', 's\n');
  t.fire('create', at('p'));
  await t.settle();
  assert.deepEqual(w.watched(dir), ['p/mysite']);
  // rm -rf p/mysite/mysite: the watch of p/mysite names mysite, as it would name itself.
  await rm(at('p/mysite/mysite'));
  w.entry(at('p/mysite/mysite'), 'rename');
  await t.settle();
  assert.deepEqual(t.events(), ['create p/mysite/mysite/settings.ts', 'delete p/mysite/mysite/settings.ts']);
});
