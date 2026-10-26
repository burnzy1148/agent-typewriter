// Recorder scope (at-kbn.6): a worktree auto-record picks up is watched but
// gets no lane until it records its first change, which is when the cap and
// rotation decide. Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckoutChoiceFile, listWorktrees, pathKey } from '../src/worktrees';
import { git, noGit, tempDir, write } from './gitFixture';
import { sleep, settings, recorderOn, until, untilWatched, committedRepo, addWorktree } from './recorderScopeFixture';

/** Reports a worktree added or removed the way git's common directory watcher would. */
function fireCommon(t: ReturnType<typeof recorderOn>, repo: string, kind: 'create' | 'delete', dir: string): void {
  t.fire(kind, path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir)));
}

test('a review worktree made and removed three times without a write gets no lane, and the output names it once each time', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const own = t.folder.uri.toString();
  // Inside the folder, as review tools make them.
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  const file = path.join(review, 'src', 'a.ts');
  for (let i = 1; i <= 3; i++) {
    git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
    fireCommon(t, repo, 'create', review);
    await untilWatched(t, file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\n');
    assert.equal(t.checkout()?.lanes, 1, 'no lane in the status count');
    assert.deepEqual(t.recorder.recordedLanes().map((l) => l.lane), [own], 'not ticked in the Checkouts view');
    const refreshes = t.logs.filter((l) => l.startsWith('Worktrees changed')).length;
    git(repo, 'worktree', 'remove', '--force', review);
    fireCommon(t, repo, 'delete', review);
    t.fire('delete', file);
    // Listed again without it: made again before that, it would be the same waiting worktree.
    await until('listed without it', () => t.logs.filter((l) => l.startsWith('Worktrees changed')).length > refreshes);
    assert.equal(t.recorder.hasBaseline(t.uri(file)), false);
    assert.equal(t.logs.filter((l) => l.includes(review)).length, i, t.logs.join('\n'));
  }
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.deepEqual(t.timeline.laneList().map((l) => l.id), [own]);
  assert.equal(t.timeline.followed, own);
  assert.ok(!t.logs.some((l) => l.startsWith('Skipping') && l.includes('review-1')), t.logs.join('\n'));
});

test('a review worktree made again at the same path from another commit starts from that commit\'s text', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  git(repo, 'checkout', '-q', '-b', 'pr');
  write(repo, 'src/a.ts', 'pr\n');
  git(repo, 'commit', '-q', '-am', 'pr');
  git(repo, 'checkout', '-q', 'main');
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  const file = path.join(review, 'src', 'a.ts');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, file);
  // Removed with only its directory reported, as watchers often do for a tree deleted at once.
  const refreshes = t.logs.filter((l) => l.startsWith('Worktrees changed')).length;
  git(repo, 'worktree', 'remove', '--force', review);
  fireCommon(t, repo, 'delete', review);
  t.fire('delete', review);
  await until('listed without it', () => t.logs.filter((l) => l.startsWith('Worktrees changed')).length > refreshes);
  assert.equal(t.recorder.hasBaseline(t.uri(file)), false, 'its baselines went with it');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'pr');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, file);
  t.change(file, 'reviewed\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
  assert.equal(t.timeline.all()[0].before, 'pr\n');
});

/** A repository whose `pr` branch has other text in each of `files`: `pr` for `a` and for `main`. */
function repoWithPr(files: Record<string, string>): string {
  const repo = committedRepo(files);
  git(repo, 'checkout', '-q', '-b', 'pr');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text === 'a\n' ? 'pr\n' : text.replaceAll('main', 'pr'));
  git(repo, 'commit', '-q', '-am', 'pr');
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

// Removed and added again faster than the 300 ms wait before worktrees are listed again: one listing sees
// it still there. Watchers may report the tree as just its directory, or each file.
for (const c of [
  { from: 'pr', deletes: 'dir', gap: 0 },
  { from: 'pr', deletes: 'dir', gap: 120 },
  { from: 'main', deletes: 'file', gap: 120 },
] as const) {
  test(`a waiting worktree removed and made again from ${c.from} within one listing (${c.deletes} events, ${c.gap} ms) waits afresh`, { skip: noGit }, async () => {
    const repo = repoWithPr({ 'src/a.ts': 'a\n' });
    const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
    await t.recorder.start();
    const review = path.join(repo, '.claude', 'worktrees', 'review-1');
    const file = path.join(review, 'src', 'a.ts');
    git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
    fireCommon(t, repo, 'create', review);
    await untilWatched(t, file);
    await sleep(400);
    git(repo, 'worktree', 'remove', '--force', review);
    fireCommon(t, repo, 'delete', review);
    t.fire('delete', c.deletes === 'file' ? file : review);
    if (c.gap) await sleep(c.gap);
    git(repo, 'worktree', 'add', '-q', '--detach', review, c.from);
    fireCommon(t, repo, 'create', review);
    t.fire('create', c.deletes === 'file' ? file : review);
    await untilWatched(t, file);
    await t.settle(1000);
    assert.deepEqual(t.events(), [], "git's checkout of it is no first change");
    assert.equal(t.checkout()?.lanes, 1);
    t.change(file, 'reviewed\n');
    await t.settle();
    assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
    assert.equal(t.timeline.all()[0].before, c.from === 'pr' ? 'pr\n' : 'a\n', 'its first change starts from the new checkout');
  });
}

test('a worktree refused at the cap while its baselines are still read keeps none of them', { skip: noGit }, async () => {
  const files: Record<string, string> = { 'src/a.ts': 'a\n' };
  for (let i = 0; i < 400; i++) files[`gen/f${i}.ts`] = `export const v${i} = 'main';\n`;
  const repo = repoWithPr(files);
  const others = ['w1', 'w2', 'w3', 'w4'].map((n) => `${repo}-${n}`);
  for (const [i, dir] of others.entries()) git(repo, 'worktree', 'add', '-q', '-b', `w${i + 1}`, dir);
  // Slow reads of the new worktree's files keep its baseline capture going while its first change is decided.
  const workspaceFs = (vscode.workspace as unknown as { fs: { readFile(u: vscode.Uri): Promise<Uint8Array> } }).fs;
  const readFile = workspaceFs.readFile;
  workspaceFs.readFile = async (u) => {
    if (u.fsPath.includes('review-1') && u.fsPath.includes('gen')) await sleep(150);
    return readFile.call(workspaceFs, u);
  };
  try {
    const t = recorderOn(settings({ autoRecordWorktrees: 'fill', gitBaselines: false }), {}, repo);
    await t.recorder.start();
    await t.recorder.setCheckouts(t.folder, [repo, ...others]);
    const review = path.join(repo, '.claude', 'worktrees', 'review-1');
    const refreshes = () => t.logs.filter((l) => l.startsWith('Worktrees changed')).length;
    const before = refreshes();
    // Subscribed first: the scope change that applies the waiting worktree can come right after the line naming it.
    let applied = false;
    t.recorder.onDidChangeScope(() => (applied ||= t.logs.some((l) => l.startsWith('Watching the new worktree'))));
    git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
    fireCommon(t, repo, 'create', review);
    // Written as soon as it is watched, while its baselines are still being read.
    await until('watched', () => applied);
    t.change(path.join(review, 'src', 'new.ts'), 'export const n = 1;\n', 'create');
    await until('refused', () => t.logs.some((l) => l.includes('is not recorded: at most 5')));
    assert.equal(refreshes(), before, 'refused before the capture finished');
    await until('capture done', () => refreshes() > before, 30_000);
    await t.settle();
    const kept = Object.keys(files).filter((f) => t.recorder.hasBaseline(t.uri(path.join(review, f))));
    assert.deepEqual(kept, [], 'no baseline of the refused worktree is kept');
  } finally {
    workspaceFs.readFile = readFile;
  }
});

test('a waiting worktree saves no display label unless it gets a lane', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const file = path.join(tempDir('at-wl-'), 'checkouts.json');
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { choices: new CheckoutChoiceFile(file) }, repo);
  await t.recorder.start();
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, path.join(review, 'src', 'a.ts'));
  const fix = addWorktree(t, repo, 'fix');
  await untilWatched(t, path.join(fix, 'src', 'a.ts'));
  t.change(path.join(fix, 'src', 'a.ts'), 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(fix)}/src/a.ts`]);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(saved.includes(path.basename(fix)), `the lane's label is saved: ${saved}`);
  assert.ok(!saved.includes('review-1'), `no trace of the waiting worktree: ${saved}`);
});

test('a git checkout in a waiting worktree is no first change; a write after it is, from the checked-out text', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  git(repo, 'checkout', '-q', '-b', 'pr');
  write(repo, 'src/a.ts', 'pr\n');
  write(repo, 'src/new.ts', 'export const n = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pr');
  git(repo, 'checkout', '-q', 'main');
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const dir = `${repo}-review`;
  git(repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
  fireCommon(t, repo, 'create', dir);
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  git(dir, 'checkout', '-q', 'pr');
  t.fire('change', file);
  t.fire('create', path.join(dir, 'src', 'new.ts'));
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
  t.change(file, 'edited\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
  assert.equal(t.timeline.all()[0].before, 'pr\n');
  assert.equal(t.checkout()?.lanes, 2);
});

test('a first change keeps its place in write order while auto-record decides, and changes meanwhile wait with it', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  let slow = false;
  // Listing slowly keeps the decision open long enough to look at.
  const lister = async (folder: string) => {
    if (slow) await sleep(600);
    return listWorktrees(folder);
  };
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { lister }, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  await untilWatched(t, path.join(dir, 'src', 'a.ts'));
  slow = true;
  t.change(path.join(dir, 'src', 'a.ts'), 'fix a\n');
  await until('first change waits', () => t.recorder.describeActivity().includes('waiting for a lane: 1;'));
  t.change(path.join(dir, 'src', 'b.ts'), 'fix b\n');
  await sleep(30);
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  await until('second change waits', () => t.recorder.describeActivity().includes('waiting for a lane: 2;'));
  await sleep(150);
  assert.deepEqual(t.events(), [], 'the main change written later waits behind them');
  await t.settle();
  slow = false;
  const fix = path.basename(dir);
  assert.deepEqual(t.events(), [`modify ${fix}/src/a.ts`, `modify ${fix}/src/b.ts`, 'modify src/a.ts']);
  assert.equal(t.timeline.all()[0].lane, t.timeline.all()[1].lane);
  assert.equal(t.logs.filter((l) => l.startsWith('Recording the new worktree fix')).length, 1, 'decided once');
});

test('a waiting worktree ticked by hand records as the user\'s: a pattern added later leaves it recording', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const s = settings({ autoRecordWorktrees: 'fill' });
  const t = recorderOn(s, {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  await untilWatched(t, path.join(dir, 'src', 'a.ts'));
  await t.recorder.addCheckout(t.folder, dir);
  assert.equal(t.checkout()?.lanes, 2);
  t.change(path.join(dir, 'src', 'a.ts'), 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
  assert.ok(!t.logs.some((l) => l.startsWith('Recording the new worktree fix')), 'not auto-record\'s');
  s.autoIgnoreWorktrees = ['*-fix'];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.ok(t.recorder.recordedLanes().some((l) => l.name === 'fix'), t.logs.join('\n'));
});

test('a waiting worktree stops waiting once it matches a pattern, or auto-record is turned off', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const s = settings({ autoRecordWorktrees: 'rotate' });
  const t = recorderOn(s, {}, repo);
  await t.recorder.start();
  const matched = addWorktree(t, repo, 'tmp1');
  const plain = addWorktree(t, repo, 'plain');
  for (const dir of [matched, plain]) await untilWatched(t, path.join(dir, 'src', 'a.ts'));
  s.autoIgnoreWorktrees = ['*-tmp*'];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(matched, 'src', 'a.ts'))), false);
  assert.ok(t.logs.some((l) => l.startsWith('Stopped watching the new worktree tmp1') && l.includes('*-tmp*')), t.logs.join('\n'));
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(plain, 'src', 'a.ts'))), 'the other one still waits');
  s.autoRecordWorktrees = 'off';
  await t.recorder.refreshFilter('autoRecordWorktrees changed');
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(plain, 'src', 'a.ts'))), false);
  for (const dir of [matched, plain]) t.change(path.join(dir, 'src', 'a.ts'), 'late\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
  // Turned on again, neither is new any more.
  s.autoRecordWorktrees = 'fill';
  await t.recorder.refreshFilter('autoRecordWorktrees changed');
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(plain, 'src', 'a.ts'))), false);
});

test('a waiting worktree is not new after recording stops and starts again, and can still be ticked', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  t.recorder.stop();
  await t.recorder.start();
  await t.recorder.refreshFilter('Worktrees changed');
  assert.equal(t.recorder.hasBaseline(t.uri(file)), false);
  t.change(file, 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
  await t.recorder.addCheckout(t.folder, dir);
  t.change(file, 'fix again\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
});

test('at most five new worktrees wait at once; one that records makes room for the next', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const dirs: string[] = [];
  for (const name of ['w1', 'w2', 'w3', 'w4', 'w5']) {
    dirs.push(addWorktree(t, repo, name));
    await untilWatched(t, path.join(dirs.at(-1)!, 'src', 'a.ts'));
  }
  assert.equal(t.checkout()?.lanes, 1);
  const sixth = addWorktree(t, repo, 'w6');
  await until('sixth refused', () => t.logs.some((l) => l.startsWith('The new worktree w6') && l.includes('5 new worktrees already wait')));
  t.change(path.join(sixth, 'src', 'a.ts'), 'six\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  t.change(path.join(dirs[2], 'src', 'a.ts'), 'three\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dirs[2])}/src/a.ts`]);
  const seventh = addWorktree(t, repo, 'w7');
  await untilWatched(t, path.join(seventh, 'src', 'a.ts'));
  assert.ok(t.logs.some((l) => l.startsWith('Watching the new worktree w7')), t.logs.join('\n'));
  assert.deepEqual(
    t.recorder
      .recordedLanes()
      .map((l) => pathKey(l.checkout))
      .sort(),
    [pathKey(repo), pathKey(dirs[2])].sort(),
  );
});
