// Recorder scope (at-kbn.5): worktrees matching autoIgnoreWorktrees get no
// lane from auto-record, and a lane auto-record added stops once it matches.
// Setup is in recorderScopeFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { Recorder } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { listWorktrees, pathKey } from '../src/worktrees';
import { mock } from './vscode-mock';
import { git, noGit, tempDir } from './gitFixture';
import { sleep, settings, recorderOn, until, committedRepo, repoWithWorktrees, addWorktree, track } from './recorderScopeFixture';

/** `git worktree add --detach`, as review tools make them, reported as the common-dir watcher would. */
function addDetached(t: ReturnType<typeof recorderOn>, repo: string, name: string): string {
  const dir = `${repo}-${name}`;
  git(repo, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
  t.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir)));
  return dir;
}

test('auto-record skips a new worktree that matches a pattern, and the next one still gets a lane', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill', autoIgnoreWorktrees: ['*-review-*'] }), {}, repo);
  await t.recorder.start();
  const review = addDetached(t, repo, 'review-1');
  await until('skip logged', () => t.logs.some((l) => l.includes('matches autoIgnoreWorktrees pattern *-review-*')));
  assert.equal(t.checkout()?.lanes, 1);
  assert.ok(!t.logs.some((l) => l.startsWith('Recording the new worktree')), t.logs.join('\n'));
  // A review tool writing its diff into the worktree records nothing.
  t.change(path.join(review, 'src', 'a.ts'), 'from the diff\n');
  t.change(path.join(review, 'src', 'new.ts'), 'export const n = 1;\n', 'create');
  await t.settle();
  assert.deepEqual(t.events(), []);
  // Logged once: later listings know it.
  addWorktree(t, repo, 'fix');
  await until('fix recorded', () => t.checkout()?.lanes === 2);
  assert.equal(t.logs.filter((l) => l.includes('-review-1') && l.includes('is not recorded')).length, 1);
});

test('auto-record rotate: an ignored worktree never stops an idle lane', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'rotate', autoIgnoreWorktrees: ['*-review-*'] }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  await t.settle();
  for (const l of t.timeline.laneList()) t.timeline.defineLane({ ...l, since: Date.now() - 30 * 60_000 });
  addDetached(t, repo, 'review-2');
  await until('skip logged', () => t.logs.some((l) => l.includes('matches autoIgnoreWorktrees pattern')));
  assert.ok(!t.logs.some((l) => l.startsWith('Stopped recording')), t.logs.join('\n'));
  assert.equal(t.checkout()?.lanes, 5);
});

test('a lane auto-record added stops, keeping its changes, once its worktree switches to an ignored branch', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill', autoIgnoreWorktrees: ['branch:review/*'] }), {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fixhud');
  await until('lane added', () => t.logs.some((l) => l.startsWith('Worktrees changed')) && t.checkout()?.lanes === 2);
  t.change(path.join(dir, 'src', 'a.ts'), 'fix\n');
  await t.settle();
  const lane = t.timeline.all()[0].lane!;
  git(dir, 'checkout', '-q', '-b', 'review/42');
  t.fire('change', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir), 'HEAD'));
  await until('stopped', () => t.logs.some((l) => l.startsWith('Stopped recording review/42') && l.includes('branch:review/*')));
  await until('lanes refreshed', () => t.checkout()?.lanes === 1);
  assert.equal(t.timeline.laneInfo(lane)?.recording, false);
  assert.equal(t.timeline.laneEvents(lane).length, 1, 'its change is kept');
  assert.equal(t.recorder.autoIgnored({ id: lane }), true, 'auto-follow sees the branch that stopped it');
});

test('the common-dir watcher sees HEAD, which a branch switch rewrites, only while a branch pattern needs it', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const s = settings({ autoRecordWorktrees: 'fill', autoIgnoreWorktrees: ['review-*'] });
  const t = recorderOn(s, {}, repo);
  await t.recorder.start();
  const common = pathKey(path.join(repo, '.git'));
  const watcher = () => mock.watchers.find((x) => !x.disposed && pathKey(x.base.fsPath) === common);
  assert.ok(watcher(), 'a watcher on the common git directory');
  for (const rel of ['worktrees/fix', 'worktrees/fix/locked']) assert.ok(minimatch(rel, watcher()!.pattern), `${watcher()!.pattern} sees ${rel}`);
  assert.ok(!minimatch('worktrees/fix/HEAD', watcher()!.pattern), 'no branch pattern: commits in a detached worktree refresh nothing');
  s.autoIgnoreWorktrees = ['branch:review/*'];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.ok(minimatch('worktrees/fix/HEAD', watcher()!.pattern), watcher()!.pattern);
  // A branch pattern also keeps hand-recorded lanes' branches current for auto-follow with auto-record off.
  s.autoRecordWorktrees = 'off';
  await t.recorder.refreshFilter('autoRecordWorktrees changed');
  assert.ok(watcher() && minimatch('worktrees/fix/HEAD', watcher()!.pattern));
  s.autoIgnoreWorktrees = [];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.equal(watcher(), undefined);
});

test('adding a pattern mid-run stops a lane auto-record added; a lane picked by hand keeps recording', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const s = settings({ autoRecordWorktrees: 'fill' });
  const t = recorderOn(s, {}, repo);
  await t.recorder.start();
  await t.recorder.addCheckout(t.folder, side);
  const extra = addWorktree(t, repo, 'extra');
  const ticked = addWorktree(t, repo, 'ticked');
  await until('both auto-recorded', () => t.checkout()?.lanes === 4);
  // Choose Checkout with every recorded checkout left ticked, plus none: the auto-added ones stay auto-record's.
  await t.recorder.setCheckouts(t.folder, t.recorder.recordedLanes().map((l) => l.checkout));
  // Clearing and ticking an auto-added checkout by hand makes it the user's.
  await t.recorder.removeCheckout(t.folder, ticked);
  await t.recorder.addCheckout(t.folder, ticked);
  s.autoIgnoreWorktrees = [`${path.basename(repo)}-*`];
  await t.recorder.refreshFilter('autoIgnoreWorktrees changed');
  await until('extra stopped', () => t.logs.some((l) => l.startsWith('Stopped recording extra')));
  await until('lanes refreshed', () => t.checkout()?.lanes === 3);
  const recorded = t.recorder.recordedLanes().map((l) => pathKey(l.checkout));
  assert.ok(recorded.includes(pathKey(side)), 'picked by hand before');
  assert.ok(recorded.includes(pathKey(ticked)), 'ticked by hand after auto-record added it');
  assert.ok(!recorded.includes(pathKey(extra)));
});

test('a worktree ticked by hand while auto-record lists worktrees is the user\'s, so a pattern never stops it', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const other = tempDir('at-ig-other-');
  let slow = false;
  // The second folder lists slowly, so the tick lands while the auto-record pass waits on git.
  const lister = async (folder: string) => {
    if (slow && pathKey(folder) === pathKey(other)) await sleep(500);
    return listWorktrees(folder);
  };
  mock.open(repo, other);
  const s = settings({ autoRecordWorktrees: 'fill' });
  const logs: string[] = [];
  const recorder = new Recorder(new Timeline(1000), () => s, { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel, undefined, lister);
  track(recorder);
  const folder = mock.folders[0] as unknown as vscode.WorkspaceFolder;
  await recorder.start();
  slow = true;
  const fresh = `${repo}-fresh`;
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh);
  mock.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', 'fresh'));
  await sleep(500);
  await recorder.addCheckout(folder, fresh);
  await until('fresh recorded', () => recorder.recordedLanes().some((l) => l.name === 'fresh'), 10000);
  slow = false;
  s.autoIgnoreWorktrees = ['*-fresh'];
  await recorder.refreshFilter('autoIgnoreWorktrees changed');
  assert.ok(recorder.recordedLanes().some((l) => l.name === 'fresh'), logs.join('\n'));
  assert.ok(!logs.some((l) => l.startsWith('Stopped recording')), logs.join('\n'));
});

test('autoIgnored: matches other worktrees by path or last branch, never a folder\'s own checkout', { skip: noGit }, async () => {
  const { repo, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  const s = settings({ autoIgnoreWorktrees: ['branch:side'] });
  const t = recorderOn(s, {}, repo);
  await t.recorder.start();
  await t.recorder.addCheckout(t.folder, side);
  const sideLane = t.timeline.laneList().find((l) => pathKey(l.root) === pathKey(side))!;
  const own = t.timeline.laneInfo(t.folder.uri.toString())!;
  assert.equal(t.recorder.autoIgnored(sideLane), true, 'by branch');
  s.autoIgnoreWorktrees = ['**'];
  assert.equal(t.recorder.autoIgnored(own), false, 'the own checkout never matches');
  s.autoIgnoreWorktrees = [path.basename(side)];
  assert.equal(t.recorder.autoIgnored(sideLane), true, 'by directory name');
  // A lane from a loaded session: only its path is known, from its id. In a nested
  // workspace folder its root sits below the checkout, so the root would not do.
  const old = { id: `${t.folder.uri.toString()}\0/elsewhere/old-review`, root: '/elsewhere/old-review/packages/app' };
  assert.equal(t.recorder.autoIgnored(old), false);
  s.autoIgnoreWorktrees = ['old-*', 'branch:*'];
  assert.equal(t.recorder.autoIgnored(old), true);
});
