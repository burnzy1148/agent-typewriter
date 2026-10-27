// Recorder scope (at-kbn.6): a worktree auto-record picks up is watched but
// gets no lane until it records its first change, which is when the cap and
// rotation decide. Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitOperationWatch } from '../src/gitOperations';
import { Recorder } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { CheckoutChoiceFile, laneKey, listWorktrees, pathKey } from '../src/worktrees';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, write } from './gitFixture';
import { sleep, HOLD_MS, settings, recorderOn, until, untilWatched, committedRepo, addWorktree, track } from './recorderScopeFixture';

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

test('a nested worktree still being checked out by git worktree add is named once, when it starts waiting', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  let checkingOut = true;
  // Lists the new worktree as git does while it is still checking files out.
  const lister = async (folder: string) => {
    const r = await listWorktrees(folder);
    if (r.kind !== 'ok' || !checkingOut) return r;
    return { kind: 'ok' as const, worktrees: r.worktrees.map((w) => (pathKey(w.path) === pathKey(review) ? { ...w, locked: 'initializing' } : w)) };
  };
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { lister }, repo);
  await t.recorder.start();
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
  fireCommon(t, repo, 'create', review);
  await until('listed while checked out', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  checkingOut = false;
  await untilWatched(t, path.join(review, 'src', 'a.ts'));
  assert.equal(t.logs.filter((l) => l.includes('review-1')).length, 1, t.logs.join('\n'));
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

// Without the git operation watch, only the recorder's own timing tells git's checkout of the new copy from an
// agent's write: a burst that began before the worktree waited again, or a write from before then reported after.
for (const c of [
  { what: 'a create still debouncing at the listing', debounceMs: 600, late: false },
  { what: 'a create reported after the listing', debounceMs: 200, late: true },
] as const) {
  test(`a waiting worktree made again within one listing, without ignoreGitOperations: ${c.what} is no first change`, { skip: noGit }, async () => {
    const repo = repoWithPr({ 'src/a.ts': 'a\n', 'src/b.ts': 'b main\n' });
    const t = recorderOn(settings({ autoRecordWorktrees: 'fill', ignoreGitOperations: false, gitBaselines: false, debounceMs: c.debounceMs }), {}, repo);
    await t.recorder.start();
    const review = path.join(repo, '.claude', 'worktrees', 'review-1');
    const [a, b] = ['a', 'b'].map((n) => path.join(review, 'src', `${n}.ts`));
    git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
    fireCommon(t, repo, 'create', review);
    for (const f of [a, b]) await untilWatched(t, f);
    await sleep(400);
    const watching = () => t.logs.filter((l) => l.startsWith('Watching the new worktree')).length;
    git(repo, 'worktree', 'remove', '--force', review);
    fireCommon(t, repo, 'delete', review);
    t.fire('delete', a);
    t.fire('delete', b);
    git(repo, 'worktree', 'add', '-q', '--detach', review, 'pr');
    fireCommon(t, repo, 'create', review);
    t.fire('create', a);
    if (c.late) {
      await until('waits afresh', () => watching() === 2);
      await sleep(100);
    }
    t.fire('create', b);
    await t.settle(c.debounceMs + 1000);
    assert.equal(watching(), 2, t.logs.join('\n'));
    assert.deepEqual(t.events(), [], "git's checkout of it is no first change");
    assert.equal(t.checkout()?.lanes, 1);
    t.change(b, 'reviewed\n');
    await t.settle();
    assert.deepEqual(t.events(), ['modify review-1/src/b.ts'], 'a write after it waits again still is');
    assert.equal(t.timeline.all()[0].before, 'b pr\n');
  });
}

test('a waiting worktree made again within one listing from a commit without one of its files: the old checkout\'s held delete is no first change', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n', 'src/old.ts': 'old\n' });
  git(repo, 'checkout', '-q', '-b', 'pr');
  git(repo, 'rm', '-q', 'src/old.ts');
  git(repo, 'commit', '-q', '-m', 'pr');
  git(repo, 'checkout', '-q', 'main');
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill', ignoreGitOperations: false }), {}, repo);
  await t.recorder.start();
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  const [a, old] = ['a', 'old'].map((n) => path.join(review, 'src', `${n}.ts`));
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, old);
  await sleep(400);
  git(repo, 'worktree', 'remove', '--force', review);
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'pr');
  fireCommon(t, repo, 'delete', review);
  fireCommon(t, repo, 'create', review);
  // Reported once the new copy is there, so it is held until deletes there stop.
  t.fire('delete', old);
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
  t.change(a, 'reviewed\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
});

test('a waiting worktree listed while git removes it is new when made again at its path', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, path.join(review, 'src', 'a.ts'));
  // Mid-removal: its .git is gone and its admin directory not yet, so git lists it prunable.
  const refreshes = () => t.logs.filter((l) => l.startsWith('Worktrees changed')).length;
  const before = refreshes();
  fs.rmSync(path.join(review, '.git'));
  t.fire('delete', path.join(review, '.git'));
  await until('listed while prunable', () => refreshes() > before);
  // The removal finishes, and the tool adds it again before the next listing.
  fs.rmSync(review, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'HEAD');
  fireCommon(t, repo, 'delete', review);
  fireCommon(t, repo, 'create', review);
  await until('waits again', () => t.logs.filter((l) => l.startsWith('Watching the new worktree')).length === 2);
  await untilWatched(t, path.join(review, 'src', 'a.ts'));
  t.change(path.join(review, 'src', 'a.ts'), 'reviewed\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
});

test('a waiting worktree ticked in another folder of the workspace stops waiting, so clearing it there leaves it unrecorded', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  mock.open(repo, side);
  const logs: string[] = [];
  const timeline = new Timeline(1000);
  const recorder = new Recorder(timeline, () => settings({ autoRecordWorktrees: 'fill' }), { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel);
  track(recorder);
  await recorder.start();
  const [, b] = mock.folders as unknown as vscode.WorkspaceFolder[];
  const fresh = `${repo}-fresh`;
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh);
  mock.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(fresh)));
  const file = path.join(fresh, 'src', 'a.ts');
  await until('waits in the first folder', () => recorder.hasBaseline(vscode.Uri.file(file)));
  await recorder.addCheckout(b, fresh);
  write(fresh, 'src/a.ts', 'one\n');
  mock.fire('change', file);
  await until('recorded in the lane ticked', () => timeline.all().length === 1);
  assert.equal(timeline.all()[0].lane, laneKey(b.uri.toString(), false, fresh));
  await recorder.removeCheckout(b, fresh);
  write(fresh, 'src/a.ts', 'two\n');
  mock.fire('change', file);
  await sleep(800);
  recorder.drainHeld();
  assert.equal(timeline.all().length, 1, 'cleared by the user, it is not recorded');
  assert.deepEqual(
    recorder.recordedLanes().map((l) => l.checkout),
    [repo, side],
  );
  assert.ok(!logs.some((l) => l.startsWith('Recording the new worktree')), logs.join('\n'));
});

test('a write in a waiting worktree whose git check outlasts the listing that finds it made again is no first change', { skip: noGit }, async (tc) => {
  const repo = repoWithPr({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const review = path.join(repo, '.claude', 'worktrees', 'review-1');
  const file = path.join(review, 'src', 'a.ts');
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'main');
  fireCommon(t, repo, 'create', review);
  await untilWatched(t, file);
  await sleep(400);
  // Asking git whether a git operation made the write takes long enough for the next listing to finish meanwhile.
  const classify = GitOperationWatch.prototype.classify;
  let slow = true;
  tc.mock.method(GitOperationWatch.prototype, 'classify', async function (this: GitOperationWatch, ...args: Parameters<typeof classify>) {
    if (slow) await sleep(900);
    return classify.apply(this, args);
  });
  git(repo, 'worktree', 'remove', '--force', review);
  git(repo, 'worktree', 'add', '-q', '--detach', review, 'pr');
  t.change(file, 'agent\n');
  fireCommon(t, repo, 'delete', review);
  fireCommon(t, repo, 'create', review);
  await until('waits afresh', () => t.logs.filter((l) => l.startsWith('Watching the new worktree')).length === 2);
  await sleep(1500);
  slow = false;
  await t.settle(500);
  assert.deepEqual(t.events(), [], 'it may be the old checkout\'s or git\'s');
  assert.equal(t.checkout()?.lanes, 1);
  t.change(file, 'reviewed\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify review-1/src/a.ts']);
  assert.equal(t.timeline.all()[0].before, 'agent\n');
});

test('a new worktree of a repository whose subdirectories are separate folders waits in each folder', { skip: noGit }, async () => {
  const repo = committedRepo({ 'pa/a.ts': 'a\n', 'pb/b.ts': 'b\n' });
  mock.open(path.join(repo, 'pa'), path.join(repo, 'pb'));
  const logs: string[] = [];
  const timeline = new Timeline(1000);
  const recorder = new Recorder(timeline, () => settings({ autoRecordWorktrees: 'fill' }), { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel);
  track(recorder);
  await recorder.start();
  const fresh = `${repo}-fresh`;
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh);
  mock.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(fresh)));
  const b = path.join(fresh, 'pb', 'b.ts');
  await until('watched in both folders', () => ['pa/a.ts', 'pb/b.ts'].every((f) => recorder.hasBaseline(vscode.Uri.file(path.join(fresh, f)))));
  write(fresh, 'pb/b.ts', 'fresh b\n');
  mock.fire('change', b);
  await until('recorded', () => recorder.recordedLanes().length === 3, 5000);
  await sleep(300);
  recorder.drainHeld();
  const pb = mock.folders[1].uri.toString();
  assert.deepEqual(timeline.all().map((e) => [e.kind, e.before, e.after, e.lane]), [['modify', 'b\n', 'fresh b\n', laneKey(pb, false, fresh)]]);
});

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

test('a git checkout in a waiting worktree is no first change and is not logged; a write after it is, from the checked-out text', { skip: noGit }, async () => {
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
  // Past the delay before git's skipped writes are summed up.
  await t.settle(1000);
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
  // Removed now, it would have been named only when it started waiting.
  assert.deepEqual(t.logs.filter((l) => /^(Skipped|Baseline captured)/.test(l)), [], t.logs.join('\n'));
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
