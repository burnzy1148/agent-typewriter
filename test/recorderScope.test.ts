// Recorder scope refresh and worktree lifecycle (review group REC3): stopping
// during start, checkouts that can't be saved, failed worktree listings, and
// worktrees moved in or belonging to another repository. Runs the real Recorder
// on real files and git repositories, with 'vscode' replaced by
// test/vscode-mock.ts. Watcher events are fired by hand, in the order git
// writes the files. The setup shared with the other recorderScope*.test.ts
// files is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CheckoutChoices } from '../src/recorder';
import { listWorktrees } from '../src/worktrees';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, write } from './gitFixture';
import { sleep, settings, recorderOn, until, committedRepo, repoWithChosenSibling, UnsavableChoices, doc, live, flakyLister } from './recorderScopeFixture';

// --- at-l3q.10.1: stopping during start.

test('stop right after start: no save listeners or watchers are left, and a restart records from the disk text', async () => {
  const dir = tempDir('at-rs-');
  const file = path.join(dir, 'a.ts');
  write(dir, 'a.ts', 'S\n');
  const t = recorderOn(settings(), {}, dir);
  const started = t.recorder.start();
  t.recorder.stop();
  await started;
  assert.equal(t.recorder.isRunning, false);
  assert.equal(mock.willSave.listenerCount, 0, 'will-save listener left behind');
  assert.equal(mock.didSave.listenerCount, 0, 'did-save listener left behind');
  assert.equal(live(), 0);
  assert.deepEqual(t.logs.filter((l) => l.startsWith('Watching')), [], 'an overtaken start logged');

  // While stopped, the user saves U and the agent then writes A.
  fs.writeFileSync(file, 'U\n');
  mock.willSave.fire({ document: doc(file, 'U\n') });
  mock.didSave.fire(doc(file, 'U\n'));
  fs.writeFileSync(file, 'A\n');
  await t.recorder.start();
  assert.equal(mock.willSave.listenerCount, 1);
  assert.equal(mock.didSave.listenerCount, 1);
  t.change(file, 'A2\n');
  await t.settle();
  assert.deepEqual(
    t.timeline.all().map((e) => [e.kind, e.before, e.after]),
    [['modify', 'A\n', 'A2\n']],
  );
});

test('stop while start takes its baselines, then start twice over: one listener pair, one log line', async () => {
  const dir = tempDir('at-rs-');
  write(dir, 'a.ts', 'S\n');
  const t = recorderOn(settings(), {}, dir);
  let open!: () => void;
  mock.readDirectoryGate = new Promise<void>((r) => (open = r));
  const first = t.recorder.start();
  await sleep(100);
  t.recorder.stop();
  const second = t.recorder.start();
  mock.readDirectoryGate = undefined;
  open();
  await Promise.all([first, second]);
  assert.equal(t.recorder.isRunning, true);
  assert.equal(mock.willSave.listenerCount, 1);
  assert.equal(mock.didSave.listenerCount, 1);
  assert.equal(live(), 1);
  assert.deepEqual(t.logs.filter((l) => l.startsWith('Watching')), ['Watching 1 files (.ts).']);
});

// --- at-l3q.10.5: a choice that can't be saved, and a start that fails.

test('a stale choice that cannot be cleared on disk: start records the folder itself and logs both', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const choices = new UnsavableChoices();
  choices.map.set(vscode.Uri.file(repo).toString(), `${repo}-removed`);
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  assert.equal(t.recorder.isRunning, true);
  assert.equal(t.checkout()?.own, true);
  assert.equal(live(), 1);
  assert.ok(t.logs.some((l) => l.includes('is no longer a worktree')));
  assert.ok(t.logs.some((l) => l.startsWith('Could not save that') && l.includes('EACCES')));
  assert.equal(choices.get(vscode.Uri.file(repo).toString()), undefined, 'cleared for the session');
});

test('a start that fails leaves nothing running, and the next start runs in full', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  let fail = true;
  const choices: CheckoutChoices = {
    get: () => {
      if (fail) throw new Error('storage unreadable');
      return undefined;
    },
    set: () => undefined,
  };
  const t = recorderOn(settings(), { choices }, repo);
  await assert.rejects(t.recorder.start(), /storage unreadable/);
  assert.equal(t.recorder.isRunning, false);
  assert.equal(mock.willSave.listenerCount, 0);
  assert.equal(live(), 0);
  fail = false;
  await t.recorder.start();
  assert.equal(t.recorder.isRunning, true);
  assert.equal(t.recorder.watchedCount, 1);
});

test('choosing a checkout that cannot be saved still applies it, and says so', { skip: noGit }, async () => {
  const { repo, side } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const choices = new UnsavableChoices();
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  assert.equal(t.checkout()?.own, true);
  await assert.rejects(t.recorder.setCheckout(t.folder, side), /could not be saved: EACCES/);
  assert.equal(t.checkout()?.own, false);
  assert.equal(t.checkout()?.name, 'side');
});

// --- at-l3q.10.8: one failed worktree listing keeps the scope.


test('a failed worktree listing keeps the chosen worktree, then git answering re-reads it', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/b.ts': 'b\n' });
  const feature = path.join(repo, '.claude', 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  const choices = new Map([[vscode.Uri.file(repo).toString(), feature]]);
  const { state, lister } = flakyLister();
  const t = recorderOn(settings(), { choices, lister }, repo);
  await t.recorder.start();
  const before = t.checkout();
  assert.equal(before?.own, false);

  state.fail = true;
  await t.recorder.refreshFilter('Filter changed');
  assert.deepEqual(t.checkout(), before, 'the scope changed on a failed listing');
  assert.equal(t.logs.filter((l) => l.startsWith('Could not re-read the worktrees')).length, 1);
  await t.recorder.refreshFilter('Filter changed');
  assert.equal(t.logs.filter((l) => l.startsWith('Could not re-read the worktrees')).length, 1, 'logged once per failure');

  t.change(path.join(repo, 'src', 'b.ts'), 'b main\n');
  t.change(path.join(feature, 'src', 'b.ts'), 'b feature\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify feature/src/b.ts']);

  state.fail = false;
  await until('worktrees re-read', () => t.logs.some((l) => l.startsWith('Worktrees re-read')), 5000);
  assert.deepEqual(t.checkout(), before);
});

test('a checkout chosen while git cannot list worktrees applies once it can', { skip: noGit }, async () => {
  const { repo, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const { state, lister } = flakyLister();
  const t = recorderOn(settings(), { choices, lister }, repo);
  await t.recorder.start();
  assert.equal(t.checkout()?.own, false);
  state.fail = true;
  await t.recorder.setCheckout(t.folder, undefined);
  assert.equal(t.checkout()?.own, false, 'kept while git cannot answer');
  assert.ok(t.logs.some((l) => l.includes('applies once git can list its worktrees')), t.logs.join('\n'));
  state.fail = false;
  await until('own checkout once git answers', () => t.checkout()?.own === true, 5000);
});

test('a failed worktree listing keeps nested worktrees skipped; retries stop with the recorder', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/b.ts': 'b\n' });
  const feature = path.join(repo, '.claude', 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  const { state, lister } = flakyLister();
  const t = recorderOn(settings(), { lister }, repo);
  await t.recorder.start();
  state.fail = true;
  await t.recorder.refreshFilter();
  assert.match(t.recorder.describeFilter(), /other worktrees skipped/);
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(feature, 'src', 'b.ts'))), false);
  assert.equal(t.checkout()?.worktrees, 2);
  t.change(path.join(feature, 'src', 'b.ts'), 'b feature\n');
  await t.settle();
  assert.deepEqual(t.events(), []);

  // Retries back off while git keeps failing, and end with the recorder.
  const calls = state.calls;
  await sleep(1300);
  assert.equal(state.calls, calls + 1, 'one retry after a second');
  t.recorder.stop();
  const stopped = state.calls;
  await sleep(2500);
  assert.equal(state.calls, stopped, 'retried after stop');
});

// --- at-l3q.10.4: a worktree noticed while a refresh lists worktrees stays hidden.

test('a new worktree noticed during an in-flight scope refresh stays hidden after it', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/f.ts': 'f\n' });
  git(repo, 'worktree', 'add', '-q', '-b', 'a', path.join('.worktrees', 'a'));
  let gate: Promise<void> | undefined;
  let listed = false;
  const lister = async (folder: string) => {
    const r = await listWorktrees(folder);
    listed = true;
    await gate;
    return r;
  };
  const t = recorderOn(settings(), { lister }, repo);
  await t.recorder.start();
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  listed = false;
  const refreshing = t.recorder.refreshFilter();
  await until('listing taken', () => listed);
  // b is added after the listing; its .git event is handled before the listing is used.
  const b = path.join(repo, '.worktrees', 'b');
  git(repo, 'worktree', 'add', '-q', '-b', 'b', path.join('.worktrees', 'b'));
  t.fire('create', path.join(b, '.git'));
  assert.equal(t.recorder.matches(t.uri(path.join(b, 'src', 'f.ts'))), false, 'not hidden at once');
  gate = undefined;
  open();
  await refreshing;
  assert.equal(t.recorder.matches(t.uri(path.join(b, 'src', 'f.ts'))), false, 'the refresh dropped the provisional prefix');
  t.fire('create', path.join(b, 'src', 'f.ts'));
  t.change(path.join(b, 'src', 'g.ts'), 'g\n', 'create');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(b, 'src', 'f.ts'))), false);
  await until('git confirms b', () => t.logs.some((l) => l.startsWith('Skipping 2 other worktree(s)')));
  assert.equal(t.recorder.matches(t.uri(path.join(b, 'src', 'f.ts'))), false);
});

// --- at-l3q.10.6: worktrees moved into or within the folder.

test('git worktree move into the folder and within it: the moved worktree is not recorded', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  git(repo, 'worktree', 'add', '-q', '-b', 'a', path.join('.worktrees', 'a'));
  const outside = path.join(tempDir('at-rs-out-'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt', outside);
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();

  // Into the folder: a directory create is all the watcher may report.
  const wt = path.join(repo, '.worktrees', 'wt');
  git(repo, 'worktree', 'move', outside, wt);
  t.fire('create', wt);
  assert.equal(t.recorder.matches(t.uri(path.join(wt, 'src', 'x.ts'))), false, 'moved-in worktree not hidden at once');
  t.change(path.join(wt, 'src', 'new.ts'), 'new\n', 'create');
  t.change(path.join(wt, 'src', 'a.ts'), 'a changed\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  await until('git lists wt', () => t.logs.some((l) => l.startsWith('Skipping') && l.includes('.worktrees/wt/')));
  t.change(path.join(wt, 'src', 'a.ts'), 'a changed again\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.ok(!t.logs.some((l) => l.includes('Baseline captured for .worktrees/wt')), t.logs.join('\n'));

  // Within the folder: create of the new directory, delete of the old.
  const a = path.join(repo, '.worktrees', 'a');
  const b = path.join(repo, '.worktrees', 'b');
  git(repo, 'worktree', 'move', a, b);
  t.fire('create', b);
  t.fire('delete', a);
  t.change(path.join(b, 'src', 'a.ts'), 'b\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  await until('git lists b', () => {
    const last = t.logs.filter((l) => l.startsWith('Skipping')).at(-1) ?? '';
    return last.includes('.worktrees/b/') && !last.includes('.worktrees/a/');
  });
});

test('a .git change inside a known nested worktree causes no refresh', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const a = path.join(repo, '.worktrees', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'a', a);
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  const lines = t.logs.length;
  t.fire('change', path.join(a, '.git'));
  t.fire('create', a);
  await sleep(600);
  assert.equal(t.logs.length, lines, t.logs.slice(lines).join('\n'));
});

// --- at-l3q.10.7: other repositories' worktrees and submodules under worktrees/ are recorded.

test("another repository's worktree, and a submodule at worktrees/foo, record their checkout as creates", { skip: noGit }, async () => {
  const ws = committedRepo({ 'src/a.ts': 'a\n' });
  const other = committedRepo({ 'f.ts': 'export const f = 1;\n' }, 'at-rs-b-');
  const t = recorderOn(settings(), {}, ws);
  await t.recorder.start();

  const bwt = path.join(ws, 'tmp', 'bwt');
  git(other, 'worktree', 'add', '-q', '-b', 'bwt', bwt);
  t.fire('create', path.join(bwt, '.git'));
  t.fire('create', path.join(bwt, 'f.ts'));
  await t.settle();
  assert.deepEqual(t.events(), ['create tmp/bwt/f.ts']);

  git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other, 'worktrees/foo');
  t.fire('create', path.join(ws, 'worktrees', 'foo', '.git'));
  t.fire('create', path.join(ws, 'worktrees', 'foo', 'f.ts'));
  await t.settle();
  assert.deepEqual(t.events(), ['create tmp/bwt/f.ts', 'create worktrees/foo/f.ts']);

  // The folder's own repository's new worktree is still hidden at once.
  git(ws, 'worktree', 'add', '-q', '-b', 'late', path.join('.worktrees', 'late'));
  t.fire('create', path.join(ws, '.worktrees', 'late', '.git'));
  t.fire('create', path.join(ws, '.worktrees', 'late', 'src', 'a.ts'));
  await t.settle();
  assert.equal(t.events().length, 2);
});
