// Recorder scope (REC3): a worktree whose .git is gone, and deletes held in a
// chosen worktree while it may be going. Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { git, noGit } from './gitFixture';
import { sleep, HOLD_MS, settings, recorderOn, until, committedRepo, repoWithChosenSibling, rm } from './recorderScopeFixture';

// --- at-l3q.10.3: a worktree whose .git is gone is still another checkout until its files are.

test('a nested worktree whose .git file is deleted stays skipped: no baselines, no deletes', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const feature = path.join(repo, '.claude', 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await rm(path.join(feature, '.git'));
  t.fire('delete', path.join(feature, '.git'));
  await until('worktrees re-read', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  assert.match(t.recorder.describeFilter(), /other worktrees skipped/);
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(feature, 'src', 'a.ts'))), false);
  await rm(path.join(feature, 'src', 'a.ts'));
  t.fire('delete', path.join(feature, 'src', 'a.ts'));
  await t.settle();
  assert.deepEqual(t.events(), []);
});

test('a chosen worktree whose .git is deleted stays chosen until its root is gone', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  assert.equal(t.checkout()?.own, false);
  await rm(path.join(side, '.git'));
  t.fire('delete', path.join(side, '.git'));
  await until('worktrees re-read', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  assert.equal(t.checkout()?.own, false, 'fell back while the worktree still has files');
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await t.settle();
  assert.deepEqual(t.events(), []);
  // The rest goes, with no event for the root itself.
  // Windows refuses while a git process the recorder started still runs in it.
  await rm(side);
  await until('fallback', () => t.checkout()?.own === true);
  assert.ok(t.logs.some((l) => l.includes('is no longer a worktree')));
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);
});

// --- at-l3q.10.2: deletes in a chosen worktree wait to see whether the worktree is going.

test('removing the chosen worktree records nothing, even for files deleted well before its .git', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'LICENSE.ts': 'mit\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'LICENSE.ts'));
  t.fire('delete', path.join(side, 'LICENSE.ts'));
  await sleep(800);
  git(repo, 'worktree', 'remove', '--force', side);
  for (const rel of ['src/a.ts', 'src/b.ts', '.git']) t.fire('delete', path.join(side, rel));
  await until('fallback', () => t.checkout()?.own === true);
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);
  assert.ok(!t.logs.some((l) => l.startsWith('Could not read the git baseline')), t.logs.join('\n'));
});

test('a repeated delete event for a held file keeps it held: removing the worktree then records nothing', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await t.settle();
  // A late duplicate of the same delete, as a lagging watcher sends.
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await t.settle();
  git(repo, 'worktree', 'remove', '--force', side);
  t.fire('delete', path.join(side, 'src', 'b.ts'));
  await until('fallback', () => t.checkout()?.own === true);
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);
});

test('a delete in a chosen worktree that stays is recorded from its baseline after the wait', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await t.settle();
  assert.deepEqual(t.events(), [], 'recorded before the wait');
  await t.settle(HOLD_MS);
  assert.deepEqual(
    t.timeline.all().map((e) => [e.kind, e.relPath, e.before]),
    [['delete', `${path.basename(side)}/src/a.ts`, 'a\n']],
  );
});

test('a file deleted and rewritten during the wait is recorded as delete, then create', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  const file = path.join(side, 'src', 'a.ts');
  await rm(file);
  t.fire('delete', file);
  await t.settle();
  t.change(file, 'a again\n', 'create');
  await t.settle();
  assert.deepEqual(
    t.timeline.all().map((e) => [e.kind, e.before, e.after]),
    [
      ['delete', 'a\n', ''],
      ['create', '', 'a again\n'],
    ],
  );
});

test('stopping or switching checkouts while a delete is held records nothing', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await t.settle();
  await t.recorder.setCheckout(t.folder, undefined);
  assert.equal(t.checkout()?.own, true);
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);

  await t.recorder.setCheckout(t.folder, side);
  await rm(path.join(side, 'src', 'b.ts'));
  t.fire('delete', path.join(side, 'src', 'b.ts'));
  await t.settle();
  t.recorder.stop();
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), []);
});
