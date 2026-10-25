// Recorder scope (REC3): held deletes keep write order and pair with creates,
// and a removed chosen worktree falls back. Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, noGit } from './gitFixture';
import { sleep, HOLD_MS, settings, recorderOn, until, repoWithChosenSibling, rm, flakyLister } from './recorderScopeFixture';

// --- at-net.12: a held delete keeps its place in write order.

test('a delete then an unrelated create in a chosen worktree are recorded in that order', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await until('delete held', () => t.recorder.describeActivity().includes('delete held'));
  t.change(path.join(side, 'src', 'b.ts'), 'b\n', 'create');
  await until('create read', () => t.recorder.describeActivity().includes('recorded create'));
  assert.deepEqual(t.events(), [], 'the create went out ahead of the held delete');
  await until('both recorded', () => t.events().length === 2, HOLD_MS + 2000);
  const label = path.basename(side);
  assert.deepEqual(t.events(), [`delete ${label}/src/a.ts`, `create ${label}/src/b.ts`]);
});

// --- at-kbn.2: a create pairs with a held delete of the same content.

test('a rename in a chosen worktree is one rename, without waiting out the held delete', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await until('delete held', () => t.recorder.describeActivity().includes('delete held'));
  t.change(path.join(side, 'src', 'b.ts'), 'a\n', 'create');
  await until('rename recorded', () => t.events().length === 1, HOLD_MS - 1000);
  const label = path.basename(side);
  assert.deepEqual(t.events(), [`rename ${label}/src/b.ts`]);
  assert.equal(t.timeline.all()[0].fromRelPath, `${label}/src/a.ts`);
  assert.match(t.recorder.describeActivity(), /deletes held: 0/);
  await t.settle(HOLD_MS);
  assert.equal(t.events().length, 1);
});

for (const createFirst of [true, false]) {
  test(`a rename in a chosen worktree reported together is one rename (${createFirst ? 'create' : 'delete'} first)`, { skip: noGit }, async () => {
    const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
    const t = recorderOn(settings({ reorderWindowMs: 250 }), { choices }, repo);
    await t.recorder.start();
    fs.renameSync(path.join(side, 'src', 'a.ts'), path.join(side, 'src', 'b.ts'));
    if (createFirst) t.fire('create', path.join(side, 'src', 'b.ts'));
    t.fire('delete', path.join(side, 'src', 'a.ts'));
    if (!createFirst) t.fire('create', path.join(side, 'src', 'b.ts'));
    await t.settle(HOLD_MS);
    const label = path.basename(side);
    assert.deepEqual(t.events(), [`rename ${label}/src/b.ts`]);
    assert.equal(t.timeline.all()[0].fromRelPath, `${label}/src/a.ts`);
  });
}

test('removing the chosen worktree while a held delete keeps a later change back records the change, and no deletes', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n', 'src/c.ts': 'c\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  await rm(path.join(side, 'src', 'a.ts'));
  t.fire('delete', path.join(side, 'src', 'a.ts'));
  await until('delete held', () => t.recorder.describeActivity().includes('delete held'));
  t.change(path.join(side, 'src', 'b.ts'), 'b\n', 'create');
  await until('create read', () => t.recorder.describeActivity().includes('recorded create'));
  git(repo, 'worktree', 'remove', '--force', side);
  for (const rel of ['src/b.ts', 'src/c.ts', '.git']) t.fire('delete', path.join(side, rel));
  await until('fallback', () => t.checkout()?.own === true);
  await until('create released', () => t.events().length > 0, HOLD_MS + 2000);
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), [`create ${path.basename(side)}/src/b.ts`]);
});

// --- at-net.13: a chosen worktree removed with no watcher event still falls back.

test('removing the chosen worktree falls back even when its watcher reports nothing', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  assert.equal(t.checkout()?.own, false);
  git(repo, 'worktree', 'remove', '--force', side);
  await until('fallback', () => t.checkout()?.own === true, 15_000);
  assert.ok(t.logs.some((l) => l.includes('is no longer a worktree')));
  await t.settle();
  assert.deepEqual(t.events(), []);
});

test('a removed chosen worktree while git cannot run asks for one refresh, not one every check, and falls back once git answers', { skip: noGit }, async () => {
  const { repo, side, choices } = repoWithChosenSibling({ 'src/a.ts': 'a\n' });
  const { state, lister } = flakyLister();
  const t = recorderOn(settings(), { choices, lister }, repo);
  await t.recorder.start();
  state.fail = true;
  await rm(side);
  const refreshes = () => t.logs.filter((l) => l.startsWith('Worktrees changed')).length;
  await until('refresh after the root is gone', () => refreshes() === 1, 15_000);
  // Two more checks' worth: each would ask again without the guard.
  await sleep(11_000);
  assert.equal(refreshes(), 1, t.logs.join('\n'));
  assert.equal(t.checkout()?.own, false, 'fell back while git could not answer');
  state.fail = false;
  await until('fallback once git answers', () => t.checkout()?.own === true, 40_000);
});
