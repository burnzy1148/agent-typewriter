// Recorder scope (at-2i9.4, at-yd9): several checkouts recording at once in
// lanes, auto-record for new worktrees, and git operations in a recorded
// worktree. Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Recorder, type CheckoutChoices } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { laneKey, listWorktrees, pathKey, type WorktreeListResult } from '../src/worktrees';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, write } from './gitFixture';
import { sleep, HOLD_MS, settings, recorderOn, until, untilWatched, committedRepo, repoWithWorktrees, laneOf, addWorktree, track } from './recorderScopeFixture';

// --- at-2i9.4: several checkouts record at once, each in its own lane.


test('the main checkout and a nested worktree record at once, each change once, in its own lane', { skip: noGit }, async () => {
  const { repo, nested } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested]);
  t.change(path.join(nested, 'src', 'a.ts'), 'feat\n');
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  await t.settle();
  assert.deepEqual(t.events().sort(), ['modify feat/src/a.ts', 'modify src/a.ts']);
  const lanes = new Set(t.timeline.all().map((e) => e.lane));
  assert.equal(lanes.size, 2);
  assert.ok(lanes.has(t.folder.uri.toString()), 'the main checkout is the folder lane');
  assert.deepEqual(
    t.timeline.laneList().map((l) => [l.label, l.recording]),
    [
      ['main', true],
      ['feat', true],
    ].map(([label, rec]) => [label === 'main' ? t.recorder.checkoutOf(t.folder)!.name : label, rec]),
  );
  assert.notEqual(t.timeline.laneList()[0].color, t.timeline.laneList()[1].color);
  assert.equal(t.checkout()?.lanes, 2);
});

test('the main checkout and a sibling worktree record at once', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, side]);
  t.change(path.join(side, 'src', 'a.ts'), 'side\n');
  await t.settle();
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(side)}/src/a.ts`, 'modify src/a.ts']);
  assert.notEqual(laneOf(t, 0), laneOf(t, 1));
  assert.equal(t.timeline.all()[0].before, 'a\n', 'the added checkout got baselines');
});

test('clearing the main checkout stops recording it while a worktree keeps recording', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.addCheckout(t.folder, side);
  await t.recorder.removeCheckout(t.folder, repo);
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  t.change(path.join(side, 'src', 'a.ts'), 'side\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(side)}/src/a.ts`]);
  assert.equal(t.checkout()?.own, false);
});

test('no checkout, or more than five, is refused and nothing changes', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4', 'w5', 'w6']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await assert.rejects(t.recorder.setCheckouts(t.folder, []), /At least one checkout/);
  await assert.rejects(
    t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`, `${repo}-w5`]),
    /At most 5 checkouts/,
  );
  await assert.rejects(t.recorder.removeCheckout(t.folder, repo), /At least one checkout/);
  assert.equal(t.checkout()?.lanes, 1);
  assert.equal(t.checkout()?.own, true);
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  assert.equal(t.checkout()?.lanes, 5);
});

test('removing a checkout keeps its queued changes in its stopped lane', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.addCheckout(t.folder, side);
  t.change(path.join(side, 'src', 'a.ts'), 'side\n');
  await t.settle();
  const lane = laneOf(t, 0)!;
  await t.recorder.removeCheckout(t.folder, side);
  assert.deepEqual(t.events(), [`modify ${path.basename(side)}/src/a.ts`]);
  assert.equal(t.timeline.laneInfo(lane)?.recording, false);
  assert.equal(t.timeline.pendingCount(lane), 1);
  t.change(path.join(side, 'src', 'a.ts'), 'side again\n');
  await t.settle();
  assert.equal(t.events().length, 1, 'the removed checkout no longer records');
});

test('a removed worktree stops only its lane; the main checkout keeps recording', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, side]);
  t.change(path.join(side, 'src', 'a.ts'), 'side\n');
  await t.settle();
  const lane = laneOf(t, 0)!;
  git(repo, 'worktree', 'remove', '--force', side);
  for (const rel of ['src/a.ts', '.git']) t.fire('delete', path.join(side, rel));
  await until('lane stopped', () => t.logs.some((l) => l.includes('its lane stopped')));
  assert.equal(t.timeline.laneInfo(lane)?.recording, false);
  assert.equal(t.checkout()?.own, true);
  assert.equal(t.checkout()?.lanes, 1);
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  await t.settle(HOLD_MS);
  assert.deepEqual(t.events(), [`modify ${path.basename(side)}/src/a.ts`, 'modify src/a.ts']);
});

test('the first lane recorded is followed, and a remembered followed lane wins', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const sideLane = laneKey(vscode.Uri.file(repo).toString(), false, side);
  const choices: CheckoutChoices = {
    get: () => undefined,
    set: () => undefined,
    getSet: () => [repo, side],
    setSet: () => undefined,
    followed: sideLane,
  };
  const t = recorderOn(settings(), { choices }, repo);
  await t.recorder.start();
  assert.equal(t.timeline.laneList().length, 2);
  assert.equal(t.timeline.followed, t.timeline.laneList()[1].id);
});

// --- at-2i9.4: auto-record gives new worktrees their own lane.


test('auto-record off: a new worktree is not recorded', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  await sleep(600);
  t.change(path.join(dir, 'src', 'a.ts'), 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 1);
});

test('auto-record fill: a new worktree waits without a lane, and its first write gives it one', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  assert.ok(t.logs.some((l) => l.startsWith('Watching the new worktree fix')), t.logs.join('\n'));
  assert.equal(t.checkout()?.lanes, 1, 'no lane while it waits');
  assert.equal(t.recorder.recordedLanes().length, 1);
  assert.equal(t.timeline.laneList().length, 1);
  t.change(file, 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
  assert.equal(t.timeline.all()[0].before, 'a\n', 'its baseline was taken while it waited');
  assert.equal(t.checkout()?.lanes, 2);
  assert.equal(t.timeline.laneInfo(laneOf(t, 0)!)?.label, 'fix');
  assert.ok(t.logs.some((l) => l.startsWith('Recording the new worktree fix')), t.logs.join('\n'));
  t.change(file, 'fix again\n');
  await t.settle();
  assert.equal(t.timeline.laneEvents(laneOf(t, 0)!).length, 2, 'later writes record in its lane');
});

test('auto-record fill at the cap: a new worktree waits, and its first change is not recorded and ends the wait', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  const dir = addWorktree(t, repo, 'extra');
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  assert.ok(t.logs.some((l) => l.startsWith('Watching the new worktree extra')), 'a sixth checkout waits: waiting ones do not count');
  t.change(file, 'extra\n');
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.ok(t.logs.some((l) => l.startsWith('The new worktree extra') && l.includes('is not recorded: at most 5')), t.logs.join('\n'));
  await until('no longer watched', () => !t.recorder.hasBaseline(t.uri(file)));
  t.change(file, 'extra again\n');
  await t.settle();
  assert.deepEqual(t.events(), [], 'decided once');
  assert.equal(t.checkout()?.lanes, 5);
});

test('auto-record fill: a lane cleared while a new worktree waits leaves room for its first change', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  const dir = addWorktree(t, repo, 'extra');
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  await t.recorder.removeCheckout(t.folder, side);
  t.change(file, 'extra\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
  const names = t.recorder.recordedLanes().map((l) => l.name);
  assert.ok(names.includes('extra') && !names.includes('side'), names.join(', '));
  assert.equal(t.checkout()?.lanes, 5);
});

test('auto-record rotate: a new worktree\'s first change stops the idlest lane, unless every lane is busy', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'rotate' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  // Every lane started recording just now: none has been idle for long.
  const busy = addWorktree(t, repo, 'busy');
  await untilWatched(t, path.join(busy, 'src', 'a.ts'));
  t.change(path.join(busy, 'src', 'a.ts'), 'busy\n');
  await t.settle();
  assert.ok(t.logs.some((l) => l.includes('every lane but the followed one changed')), t.logs.join('\n'));
  assert.deepEqual(t.events(), []);
  assert.equal(t.checkout()?.lanes, 5);
  // Make the side lane look idle for long.
  const sideLane = t.timeline.laneList().find((l) => pathKey(l.root) === pathKey(side))!;
  t.timeline.defineLane({ ...sideLane, since: Date.now() - 10 * 60_000 });
  for (const l of t.timeline.laneList()) if (l.id !== sideLane.id) t.timeline.defineLane({ ...l, since: Date.now() });
  const next = addWorktree(t, repo, 'next');
  await untilWatched(t, path.join(next, 'src', 'a.ts'));
  assert.ok(!t.logs.some((l) => l.includes('idle longest')), 'waiting, it stops nothing');
  assert.equal(t.timeline.laneInfo(sideLane.id)?.recording, true);
  t.change(path.join(next, 'src', 'a.ts'), 'next\n');
  await t.settle();
  assert.ok(t.logs.some((l) => l.includes('idle longest, to record the new worktree next')), t.logs.join('\n'));
  // A stopped lane with no changes is forgotten.
  assert.notEqual(t.timeline.laneInfo(sideLane.id)?.recording, true);
  assert.ok(t.recorder.recordedLanes().some((l) => l.name === 'next'));
  assert.equal(t.checkout()?.lanes, 5);
  assert.deepEqual(t.events(), [`modify ${path.basename(next)}/src/a.ts`]);
});

test('auto-record rotate: a new worktree removed before anything is written there stops no lane', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'rotate' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  await t.settle();
  for (const l of t.timeline.laneList()) t.timeline.defineLane({ ...l, since: Date.now() - 30 * 60_000 });
  const dir = addWorktree(t, repo, 'peek');
  const file = path.join(dir, 'src', 'a.ts');
  await untilWatched(t, file);
  git(repo, 'worktree', 'remove', '--force', dir);
  t.fire('delete', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir)));
  await until('no longer watched', () => !t.recorder.hasBaseline(t.uri(file)));
  assert.ok(!t.logs.some((l) => l.startsWith('Stopped recording')), t.logs.join('\n'));
  assert.equal(t.checkout()?.lanes, 5);
  assert.equal(t.logs.filter((l) => l.includes(dir)).length, 1, 'named once, when it started waiting');
});

test('auto-record rotate: two worktrees whose first changes come at once each take an idle lane, never each other\'s', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'rotate' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  await t.settle();
  // Every lane but the followed one has been idle for long.
  for (const l of t.timeline.laneList()) t.timeline.defineLane({ ...l, since: Date.now() - 10 * 60_000 });
  const one = `${repo}-one`;
  const two = `${repo}-two`;
  git(repo, 'worktree', 'add', '-q', '-b', 'one', one);
  git(repo, 'worktree', 'add', '-q', '-b', 'two', two);
  t.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(two)));
  await untilWatched(t, path.join(one, 'src', 'a.ts'));
  await untilWatched(t, path.join(two, 'src', 'a.ts'));
  t.change(path.join(one, 'src', 'a.ts'), 'one\n');
  t.change(path.join(two, 'src', 'a.ts'), 'two\n');
  await t.settle();
  assert.equal(t.logs.filter((l) => l.includes('idle longest, to record the new worktree')).length, 2, t.logs.join('\n'));
  const names = t.recorder.recordedLanes().map((l) => l.name);
  assert.ok(names.includes('one') && names.includes('two'), names.join(', '));
  assert.ok(!t.logs.some((l) => /Stopped recording (one|two),/.test(l)), t.logs.join('\n'));
  assert.equal(names.length, 5);
  assert.equal(t.events().length, 2);
});

test('changes still held when recording stops keep their lane\'s label and color', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ reorderWindowMs: 5000 }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, side]);
  t.change(path.join(side, 'src', 'a.ts'), 'side\n');
  await until('read and held', () => t.recorder.describeActivity().includes('held for reordering: 1'));
  t.recorder.stop();
  assert.deepEqual(t.events(), [`modify ${path.basename(side)}/src/a.ts`]);
  const lane = t.timeline.laneInfo(t.timeline.all()[0].lane!);
  assert.equal(lane?.label, 'side');
  assert.ok((lane?.color ?? 0) > 0);
  assert.equal(lane?.recording, false);
});

test('with six folders and recording off, a folder can still choose its checkouts', async () => {
  const dirs = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => tempDir(`at-six-${n}-`));
  mock.open(...dirs);
  const recorder = new Recorder(new Timeline(100), () => settings(), { appendLine: () => {} } as unknown as vscode.OutputChannel);
  track(recorder);
  const folders = mock.folders as unknown as vscode.WorkspaceFolder[];
  // The sixth folder records nothing by default, so it does not count against the first one's choice.
  await recorder.setCheckouts(folders[0], [dirs[0]]);
  // Adding a second checkout to the first would make six, and so would giving the sixth folder one.
  await assert.rejects(recorder.setCheckouts(folders[0], [dirs[0], `${dirs[0]}-x`]), /At most 5 checkouts/);
  await assert.rejects(recorder.setCheckouts(folders[5], [dirs[5]]), /At most 5 checkouts/);
});

test('auto-record waits until git worktree add has checked the worktree out', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  let initializingNow = '';
  // Reports the new worktree as git does while it is still checking files out.
  const lister = async (folder: string): Promise<WorktreeListResult> => {
    const r = await listWorktrees(folder);
    if (r.kind !== 'ok' || !initializingNow) return r;
    // In German, say: the reason git writes is translated.
    return { kind: 'ok', worktrees: r.worktrees.map((w) => (pathKey(w.path) === pathKey(initializingNow) ? { ...w, locked: 'initialisiere' } : w)) };
  };
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { lister }, repo);
  await t.recorder.start();
  const dir = `${repo}-slow`;
  initializingNow = dir;
  addWorktree(t, repo, 'slow');
  await until('listed while initializing', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  assert.ok(!t.logs.some((l) => l.startsWith('Watching the new worktree slow')), 'watched before git finished');
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(dir, 'src', 'a.ts'))), false);
  initializingNow = '';
  await until('waits once done', () => t.logs.some((l) => l.startsWith('Watching the new worktree slow')), 5000);
  await untilWatched(t, path.join(dir, 'src', 'a.ts'));
  assert.equal(t.checkout()?.lanes, 1);
});

test('a scope refresh overtaken by a stop and start does not use up the start\'s choice of lane to follow', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const sideLane = laneKey(vscode.Uri.file(repo).toString(), false, side);
  const choices: CheckoutChoices = { get: () => undefined, set: () => undefined, getSet: () => [repo, side], setSet: () => undefined, followed: sideLane };
  let slow = 0;
  const lister = async (folder: string) => {
    if (slow > 0) await sleep(slow);
    return listWorktrees(folder);
  };
  const t = recorderOn(settings(), { choices, lister }, repo);
  await t.recorder.start();
  t.timeline.follow(vscode.Uri.file(repo).toString());
  slow = 400;
  const overtaken = t.recorder.refreshFilter('Filter changed').catch(() => {});
  await sleep(100);
  t.recorder.stop();
  const restarted = t.recorder.start();
  await Promise.all([overtaken, restarted]);
  assert.equal(t.timeline.followed, sideLane, 'the remembered lane is followed after the restart');
  assert.equal(t.checkout()?.lanes, 2);
});

test('ticking a sixth folder\'s checkout while recording is refused with the cap message', async () => {
  const dirs = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((n) => tempDir(`at-cap-${n}-`));
  mock.open(...dirs);
  const logs: string[] = [];
  const recorder = new Recorder(new Timeline(100), () => settings(), { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel);
  track(recorder);
  const folders = mock.folders as unknown as vscode.WorkspaceFolder[];
  await recorder.start();
  assert.equal(recorder.recordedLanes().length, 5);
  assert.ok(logs.some((l) => l.includes('not recording g6') || l.includes(`not recording ${folders[5].name}`)), logs.join('\n'));
  await assert.rejects(recorder.addCheckout(folders[5], dirs[5]), /At most 5 checkouts/);
  recorder.stop();
  assert.deepEqual(recorder.defaultRecorded(folders[5]), [], 'the sixth folder shows as not recorded');
  assert.deepEqual(recorder.defaultRecorded(folders[0]), [dirs[0]]);
});

test('a checkout cleared while auto-record decides a new worktree\'s first change stays cleared', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const other = tempDir('at-rs-other-');
  let slow = false;
  // The second folder lists slowly, so the first folder's choice is read well before auto-record saves.
  const lister = async (folder: string) => {
    if (slow && pathKey(folder) === pathKey(other)) await sleep(500);
    return listWorktrees(folder);
  };
  mock.open(repo, other);
  const timeline = new Timeline(1000);
  const logs: string[] = [];
  const recorder = new Recorder(timeline, () => settings({ autoRecordWorktrees: 'fill' }), { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel, undefined, lister);
  track(recorder);
  const folder = mock.folders[0] as unknown as vscode.WorkspaceFolder;
  await recorder.start();
  await recorder.setCheckouts(folder, [repo, side]);
  const fresh = `${repo}-fresh`;
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh);
  mock.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', 'fresh'));
  const file = path.join(fresh, 'src', 'a.ts');
  await until('fresh watched', () => recorder.hasBaseline(vscode.Uri.file(file)));
  slow = true;
  write(fresh, 'src/a.ts', 'fresh\n');
  mock.fire('change', file);
  // Past the debounce, the refresh deciding its first change has read the first folder and waits on the second; clear side meanwhile.
  await sleep(300);
  const cleared = recorder.setCheckouts(folder, [repo]);
  await until('fresh recorded', () => recorder.recordedLanes().some((l) => l.name === 'fresh'), 10000);
  await cleared;
  slow = false;
  await recorder.refreshFilter('Settled');
  const names = recorder.recordedLanes().map((l) => l.name);
  assert.ok(!names.includes('side'), `side came back: ${names.join(', ')}`);
  assert.ok(names.includes('fresh'));
  await until('fresh change recorded', () => timeline.all().length === 1);
});

test('the remembered lane is followed at start even when a restored lane has changes queued, but never mid-change', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const sideLane = laneKey(vscode.Uri.file(repo).toString(), false, side);
  const choices: CheckoutChoices = { get: () => undefined, set: () => undefined, getSet: () => [repo, side], setSet: () => undefined, followed: sideLane };
  const restored = { uri: 'file:///w/old.ts', relPath: 'old.ts', time: 1, kind: 'modify' as const, before: 'a', after: 'b', eol: '\n' as const, linesAdded: 1, linesRemoved: 1 };
  const t = recorderOn(settings(), { choices }, repo);
  t.timeline.push(restored);
  t.timeline.push(restored);
  await t.recorder.start();
  assert.equal(t.timeline.followed, sideLane);
  assert.equal(t.timeline.pendingCount(''), 2, 'the restored changes stay queued in their lane');
  t.recorder.stop();
  // A change being typed when recording starts keeps its lane followed.
  t.timeline.follow('');
  const typing = t.timeline.peek()!;
  t.timeline.begin(typing.seq);
  await t.recorder.start();
  assert.equal(t.timeline.followed, '');
  assert.equal(t.timeline.playing, typing.seq);
});

test('rotate in a workspace where every folder has one lane says no lane can make room', { skip: noGit }, async () => {
  const repos = [1, 2, 3, 4, 5].map(() => committedRepo({ 'src/a.ts': 'a\n' }));
  mock.open(...repos);
  const logs: string[] = [];
  const recorder = new Recorder(new Timeline(100), () => settings({ autoRecordWorktrees: 'rotate' }), { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel);
  track(recorder);
  await recorder.start();
  assert.equal(recorder.recordedLanes().length, 5);
  const extra = `${repos[1]}-extra`;
  git(repos[1], 'worktree', 'add', '-q', '-b', 'extra', extra);
  mock.fire('create', path.join(fs.realpathSync.native(repos[1]), '.git', 'worktrees', path.basename(extra)));
  const file = path.join(extra, 'src', 'a.ts');
  await until('extra watched', () => recorder.hasBaseline(vscode.Uri.file(file)));
  write(extra, 'src/a.ts', 'extra\n');
  mock.fire('change', file);
  await until('skip logged', () => logs.some((l) => l.includes('is not recorded')));
  assert.ok(logs.some((l) => l.includes("every lane is its folder's only one")), logs.join('\n'));
});

test('a worktree locked on purpose before start is never auto-recorded as new', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const kept = `${repo}-kept`;
  git(repo, 'worktree', 'add', '-q', '-b', 'kept', kept);
  git(repo, 'worktree', 'lock', '--reason', 'on usb', kept);
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  await t.recorder.refreshFilter('Filter changed');
  await sleep(2500);
  assert.equal(t.checkout()?.lanes, 1);
  assert.ok(!t.logs.some((l) => l.includes('Recording the new worktree kept')), t.logs.join('\n'));
  assert.ok(t.logs.filter((l) => l.startsWith('Worktrees changed')).length === 0, 'kept re-listing while it waited on a lock');
});

// --- at-yd9: git operations in a recorded worktree.

test('a merge in a recorded sibling worktree records nothing in its lane; an edit in the main checkout still records', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  git(side, 'switch', '-qc', 'feature');
  write(side, 'src/a.ts', 'feature\n');
  write(side, 'src/new.ts', 'new\n');
  git(side, 'add', '.');
  git(side, 'commit', '-qm', 'feature');
  git(side, 'switch', '-q', 'side');
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, side]);
  git(side, 'merge', '-q', 'feature');
  t.fire('change', path.join(side, 'src', 'a.ts'));
  t.fire('create', path.join(side, 'src', 'new.ts'));
  t.change(path.join(repo, 'src', 'a.ts'), 'main\n');
  await t.settle();
  assert.deepEqual(t.events(), ['modify src/a.ts']);
  assert.equal(laneOf(t, 0), t.folder.uri.toString());
});

test('a stash in the main checkout is not taken for a git write in a sibling worktree', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, side]);
  t.change(path.join(side, 'src', 'a.ts'), 'edit\n');
  write(repo, 'src/a.ts', 'wip\n');
  await t.settle();
  await sleep(120);
  // Back to its committed text just before the stash: a stash push in this worktree would vouch for that.
  t.change(path.join(side, 'src', 'a.ts'), 'a\n');
  git(repo, 'stash', 'push', '-q');
  t.fire('change', path.join(repo, 'src', 'a.ts'));
  await t.settle();
  const sideFile = `${path.basename(side)}/src/a.ts`;
  assert.deepEqual(t.events(), [`modify ${sideFile}`, `modify ${sideFile}`]);
  assert.equal(t.timeline.all()[1].after, 'a\n');
});
