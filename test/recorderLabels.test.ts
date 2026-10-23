// Checkout labels, display paths and the bare-repository container (review
// group REC4). Runs the real Recorder on real files and git repositories, with
// 'vscode' replaced by test/vscode-mock.ts. Watcher events are fired by hand.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Recorder, type CheckoutChoices } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { CheckoutChoiceFile } from '../src/worktrees';
import type { Settings } from '../src/config';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function settings(over: Partial<Settings> = {}): Settings {
  return {
    autoStart: false,
    include: ['**/*'],
    exclude: ['**/.git/**', '**/node_modules/**'],
    extensions: ['ts'],
    respectGitignore: false,
    activeProfile: '',
    profiles: {},
    charsPerMinute: 2100,
    speedFromDeprecatedSetting: false,
    languageSpeeds: {},
    jitter: 0,
    catchUpFactor: 0,
    maxSpeedup: 1,
    maxAnimatedChars: 6000,
    fileSwitchDelayMs: 0,
    smoothScroll: false,
    scrollPauseMs: 0,
    scrollLinesPerSecond: 60,
    debounceMs: 50,
    reorderWindowMs: 0,
    maxFileSizeKB: 512,
    gitBaselines: true,
    baselineBudgetMB: 256,
    historyLimit: 500,
    persistHistory: false,
    ignoreOwnSaves: true,
    viewColumn: 'beside',
    mirrorStatusRow: true,
    ...over,
  };
}

let current: Recorder | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
  mock.reset();
});

/** A recorder on these workspace folders, in this order. */
function recorderOn(s: Settings, dirs: string[], choices?: CheckoutChoices) {
  mock.open(...dirs);
  const timeline = new Timeline(1000);
  const logs: string[] = [];
  const log = { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel;
  const recorder = new Recorder(timeline, () => s, log, choices);
  current = recorder;
  const folders = mock.folders as unknown as vscode.WorkspaceFolder[];
  /** Writes the file and reports it, as an agent's write and the watcher would. */
  const change = (file: string, text: string, kind: 'create' | 'change' = 'change') => {
    write(path.dirname(file), path.basename(file), text);
    mock.fire(kind, file);
  };
  /** Waits for every debounce and read to finish, then hands held changes to the timeline. */
  const settle = async () => {
    await sleep(s.debounceMs + 150);
    for (let i = 0; i < 250 && !recorder.describeActivity().includes('debouncing: none; reading: 0;'); i++) await sleep(20);
    await sleep(50);
    recorder.drainHeld();
  };
  const events = () => timeline.all().map((e) => [e.kind, e.relPath]);
  return { recorder, timeline, logs, folders, change, settle, events };
}

function committedRepo(files: Record<string, string>, prefix = 'at-rl-'): string {
  const repo = tempRepo(prefix);
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

const key = (dir: string) => vscode.Uri.file(dir).toString();
const doc = (file: string, text: string) => ({ uri: vscode.Uri.file(file), getText: () => text });

/** Saves the file from an editor: will-save, the write, did-save, then the watcher event at `watched`. */
function editorSave(file: string, text: string, watched = file): void {
  mock.willSave.fire({ document: doc(file, text) });
  fs.writeFileSync(file, text);
  mock.didSave.fire(doc(file, text));
  mock.fire('change', watched);
}

/** Makes a directory symlink, or returns false where that is not allowed. */
function symlinkDir(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

// --- at-l3q.11.1: overlapping chosen checkouts in a multi-root workspace.

for (const reverse of [false, true]) {
  test(`at-l3q.11.1 overlapping chosen roots: the innermost folder owns the file (${reverse ? 'inner' : 'outer'} folder first)`, { skip: noGit }, async () => {
    const repo = committedRepo({ 'src/y.ts': 'y\n', 'packages/app/src/x.ts': 'x\n' });
    const feature = `${repo}-feature`;
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
    const app = path.join(repo, 'packages', 'app');
    const choices = new Map([
      [key(repo), feature],
      [key(app), feature],
    ]);
    const t = recorderOn(settings({ include: ['src/**'] }), reverse ? [app, repo] : [repo, app], choices);
    await t.recorder.start();
    const label = path.basename(feature);
    const x = path.join(feature, 'packages', 'app', 'src', 'x.ts');
    assert.ok(t.recorder.hasBaseline(vscode.Uri.file(x)), 'src/** within the inner folder did not match');
    t.change(x, 'x2\n');
    await t.settle();
    t.change(path.join(feature, 'src', 'y.ts'), 'y2\n');
    await t.settle();
    assert.deepEqual(t.events(), [
      ['modify', `app/${label}/src/x.ts`],
      ['modify', `${path.basename(repo)}/${label}/src/y.ts`],
    ]);
    assert.ok(!t.logs.some((l) => l.includes('baselineBudgetMB')), `false budget message: ${t.logs.join('\n')}`);
  });
}

// --- at-l3q.11.2: a folder holding a bare repository's worktrees.

/** /proj with /proj/.bare, a .git file naming it, and worktrees at /proj/<name>. */
function bareContainer(names: string[]): string {
  const src = committedRepo({ 'src/a.ts': 'A0\n' });
  const proj = tempDir('at-rl-proj-');
  git(proj, 'clone', '-q', '--bare', src, '.bare');
  fs.writeFileSync(path.join(proj, '.git'), 'gitdir: ./.bare\n');
  names.forEach((name, i) => git(proj, 'worktree', 'add', '-q', ...(i === 0 ? [name, 'main'] : ['-b', name, name])));
  return proj;
}

test('at-l3q.11.2 bare container with one worktree: visible, choosable, and records it once chosen', { skip: noGit }, async () => {
  const proj = bareContainer(['main']);
  const t = recorderOn(settings(), [proj]);
  const folder = t.folders[0];
  const listed = await t.recorder.checkoutsOf(folder);
  assert.equal(listed?.worktrees.length, 1);
  assert.equal(listed?.own, undefined);
  await t.recorder.start();
  const before = t.recorder.checkoutOf(folder);
  assert.equal(before?.own, true);
  assert.equal(before?.container, true);
  assert.ok(before?.name.trim(), 'blank status name');
  assert.match(t.recorder.describeFilter(), /no checkout chosen in /);
  assert.ok(t.logs.some((l) => l.includes('has no checkout of its own')));
  const file = path.join(proj, 'main', 'src', 'a.ts');
  t.change(file, 'A1\n');
  await t.settle();
  assert.deepEqual(t.events(), [], 'worktrees are skipped until one is chosen');

  await t.recorder.setCheckout(folder, path.join(proj, 'main'));
  assert.equal(t.recorder.checkoutOf(folder)?.name, 'main');
  assert.doesNotMatch(t.recorder.describeFilter(), /no checkout chosen/);
  t.change(file, 'A2\n');
  await t.settle();
  assert.deepEqual(
    t.timeline.all().map((e) => [e.kind, e.relPath, e.before]),
    [['modify', 'main/src/a.ts', 'A1\n']],
  );
});

test('at-l3q.11.2 bare container with two worktrees: the status name is never blank', { skip: noGit }, async () => {
  const proj = bareContainer(['main', 'feat']);
  const t = recorderOn(settings(), [proj]);
  await t.recorder.start();
  const info = t.recorder.checkoutOf(t.folders[0]);
  assert.equal(info?.worktrees, 2);
  assert.ok(info?.name.trim());
  await t.recorder.setCheckout(t.folders[0], path.join(proj, 'feat'));
  assert.equal(t.recorder.checkoutOf(t.folders[0])?.name, 'feat');
});

// --- at-l3q.11.3: a worktree label equal to a top-level directory of the folder.

test('at-l3q.11.3 a chosen worktree named like a top-level directory gets another label', { skip: noGit }, async () => {
  const repo = committedRepo({ 'a.ts': 'root\n', 'docs/a.ts': 'docs\n' });
  const wt = path.join(repo, '.worktrees', 'docs');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent', wt);
  const t = recorderOn(settings(), [repo]);
  await t.recorder.start();
  t.change(path.join(repo, 'docs', 'a.ts'), 'docs2\n');
  await t.settle();
  await t.recorder.setCheckout(t.folders[0], wt);
  t.change(path.join(wt, 'a.ts'), 'root2\n');
  await t.settle();
  const [own, chosen] = t.timeline.all().map((e) => e.relPath);
  assert.equal(own, 'docs/a.ts');
  assert.notEqual(chosen, 'docs/a.ts', 'two checkouts share a mirror');
  assert.ok(chosen.endsWith('/a.ts'));
  assert.equal(t.timeline.latestStates().size, 2);
});

// --- at-l3q.11.4: own saves in a chosen nested worktree, workspace opened through a symlink.

test('at-l3q.11.4 symlinked workspace: an own save in a chosen nested worktree records nothing', { skip: noGit }, async (ctx) => {
  const real = committedRepo({ 'src/a.ts': 'A0\n' });
  git(real, 'worktree', 'add', '-q', '-b', 'nested', '.worktrees/nested');
  const link = path.join(tempDir('at-rl-link-'), 'repo');
  if (!symlinkDir(real, link)) return ctx.skip('cannot create a symlink here');
  // Git spells the worktree by its real path.
  const choices = new Map([[key(link), path.join(real, '.worktrees', 'nested')]]);
  const t = recorderOn(settings(), [link], choices);
  await t.recorder.start();
  const viaFolder = path.join(link, '.worktrees', 'nested', 'src', 'a.ts');
  assert.ok(t.recorder.hasBaseline(vscode.Uri.file(viaFolder)), 'nested baselines are not keyed in the folder spelling');
  editorSave(viaFolder, 'U1\n');
  await t.settle();
  assert.deepEqual(t.events(), [], "the user's own save was recorded");
  t.change(viaFolder, 'A2\n');
  await t.settle();
  assert.deepEqual(
    t.timeline.all().map((e) => [e.kind, e.relPath, e.before, e.after]),
    [['modify', 'nested/src/a.ts', 'U1\n', 'A2\n']],
  );
});

test('at-l3q.11.4 a chosen sibling worktree saved through a symlinked path records nothing', { skip: noGit }, async (ctx) => {
  const repo = committedRepo({ 'src/a.ts': 'A0\n' });
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  const link = path.join(tempDir('at-rl-link-'), 'side');
  if (!symlinkDir(side, link)) return ctx.skip('cannot create a symlink here');
  const t = recorderOn(settings(), [repo], new Map([[key(repo), side]]));
  await t.recorder.start();
  // The editor has the file open through the link; the watcher reports the real path.
  editorSave(path.join(link, 'src', 'a.ts'), 'U1\n', path.join(side, 'src', 'a.ts'));
  await t.settle();
  assert.deepEqual(t.events(), []);
});

// --- at-l3q.11.6: same-named folders in a multi-root workspace.

test('at-l3q.11.6 two folders named app get distinct display paths and mirrors', async () => {
  const base = tempDir('at-rl-multi-');
  const client = path.join(base, 'client', 'app');
  const server = path.join(base, 'server', 'app');
  write(client, 'src/index.ts', 'C0\n');
  write(server, 'src/index.ts', 'S0\n');
  const t = recorderOn(settings({ gitBaselines: false }), [client, server]);
  assert.deepEqual(
    t.folders.map((f) => f.name),
    ['app', 'app'],
  );
  await t.recorder.start();
  t.change(path.join(client, 'src', 'index.ts'), 'C1\n');
  await t.settle();
  t.change(path.join(server, 'src', 'index.ts'), 'S1\n');
  await t.settle();
  assert.deepEqual(t.events(), [
    ['modify', 'client-app/src/index.ts'],
    ['modify', 'server-app/src/index.ts'],
  ]);
  assert.deepEqual(
    [...t.timeline.latestStates().values()].map((e) => e.after).sort(),
    ['C1\n', 'S1\n'],
  );
});

test('at-l3q.11.6 a folder named with a slash cannot share a prefix with another folder', async () => {
  const base = tempDir('at-rl-multi-');
  const one = path.join(base, 'one');
  const two = path.join(base, 'app');
  write(one, 'index.ts', 'one\n');
  write(two, 'src/index.ts', 'two\n');
  const t = recorderOn(settings({ gitBaselines: false }), [one, two]);
  (mock.folders[0] as { name: string }).name = 'app/src';
  await t.recorder.start();
  t.change(path.join(one, 'index.ts'), 'one2\n');
  t.change(path.join(two, 'src', 'index.ts'), 'two2\n');
  await t.settle();
  const paths = t.timeline.all().map((e) => e.relPath);
  assert.equal(new Set(paths).size, 2, `paths collide: ${paths.join(', ')}`);
  assert.ok(paths.includes('app/src/index.ts'), 'a uniquely named folder keeps its prefix');
});

test('at-l3q.11.6 unique folder names and a single folder keep their display paths', async () => {
  const base = tempDir('at-rl-multi-');
  const api = path.join(base, 'api');
  const web = path.join(base, 'web');
  write(api, 'a.ts', 'a\n');
  write(web, 'w.ts', 'w\n');
  const multi = recorderOn(settings({ gitBaselines: false }), [api, web]);
  await multi.recorder.start();
  multi.change(path.join(api, 'a.ts'), 'a2\n');
  await multi.settle();
  assert.deepEqual(multi.events(), [['modify', 'api/a.ts']]);
  multi.recorder.dispose();
  mock.reset();
  const single = recorderOn(settings({ gitBaselines: false }), [web]);
  await single.recorder.start();
  single.change(path.join(web, 'w.ts'), 'w2\n');
  await single.settle();
  assert.deepEqual(single.events(), [['modify', 'w.ts']]);
});

// --- at-l3q.11.7: a chosen worktree's label stays while the worktree list changes.

test('at-l3q.11.7 a chosen worktree keeps its label when a same-named worktree is added, and across a reload', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'A0\n' });
  const fix = path.join(repo, '.claude', 'worktrees', 'fix');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', fix);
  const file = path.join(tempDir('at-rl-choices-'), 'checkouts.json');
  const choices = new CheckoutChoiceFile(file);
  choices.set(key(repo), fix);
  const t = recorderOn(settings(), [repo], choices);
  await t.recorder.start();
  const a = path.join(fix, 'src', 'a.ts');
  t.change(a, 'A1\n');
  await t.settle();
  const other = path.join(tempDir('at-rl-tmp-'), 'worktrees', 'fix');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix2', other);
  await t.recorder.refreshFilter('Worktrees changed');
  t.change(a, 'A2\n');
  await t.settle();
  t.recorder.stop();
  await t.recorder.start();
  t.change(a, 'A3\n');
  await t.settle();
  assert.deepEqual(t.events(), [
    ['modify', 'fix/src/a.ts'],
    ['modify', 'fix/src/a.ts'],
    ['modify', 'fix/src/a.ts'],
  ]);
  t.recorder.dispose();

  // A new window: the label comes from checkouts.json.
  mock.reset();
  const again = recorderOn(settings(), [repo], new CheckoutChoiceFile(file));
  await again.recorder.start();
  again.change(a, 'A4\n');
  await again.settle();
  await again.recorder.setCheckout(again.folders[0], other);
  again.change(path.join(other, 'src', 'a.ts'), 'B1\n');
  await again.settle();
  const [first, second] = again.timeline.all().map((e) => e.relPath);
  assert.equal(first, 'fix/src/a.ts');
  assert.notEqual(second, 'fix/src/a.ts', 'two checkouts share a mirror');
});

test('at-l3q.11.7 without a choices file, labels last for the session', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'A0\n' });
  const fix = path.join(repo, '.claude', 'worktrees', 'fix');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', fix);
  const t = recorderOn(settings(), [repo], new Map([[key(repo), fix]]));
  await t.recorder.start();
  git(repo, 'worktree', 'add', '-q', '-b', 'fix2', path.join(tempDir('at-rl-tmp-'), 'worktrees', 'fix'));
  await t.recorder.refreshFilter('Worktrees changed');
  t.change(path.join(fix, 'src', 'a.ts'), 'A1\n');
  await t.settle();
  assert.deepEqual(t.events(), [['modify', 'fix/src/a.ts']]);
});

test('at-l3q.11.6 a folder keeps its prefix when a same-named folder is added, and across a reload', async () => {
  const base = tempDir('at-rl-multi-');
  const client = path.join(base, 'client', 'app');
  const api = path.join(base, 'api');
  const server = path.join(base, 'server', 'app');
  write(client, 'src/index.ts', 'C0\n');
  write(api, 'a.ts', 'a\n');
  write(server, 'src/index.ts', 'S0\n');
  const file = path.join(tempDir('at-rl-choices-'), 'checkouts.json');
  const t = recorderOn(settings({ gitBaselines: false }), [client, api], new CheckoutChoiceFile(file));
  await t.recorder.start();
  t.change(path.join(client, 'src', 'index.ts'), 'C1\n');
  await t.settle();
  // The user adds server/app, also named app.
  mock.folders.push({ uri: vscode.Uri.file(server) as never, name: 'app', index: 2 });
  await t.recorder.refreshFilter('Workspace folders changed');
  t.change(path.join(client, 'src', 'index.ts'), 'C2\n');
  await t.settle();
  t.change(path.join(server, 'src', 'index.ts'), 'S1\n');
  await t.settle();
  assert.deepEqual(t.events(), [
    ['modify', 'app/src/index.ts'],
    ['modify', 'app/src/index.ts'],
    ['modify', 'server-app/src/index.ts'],
  ]);
  t.recorder.dispose();

  // A new window on all three: each keeps the prefix it was given.
  mock.reset();
  const again = recorderOn(settings({ gitBaselines: false }), [client, api, server], new CheckoutChoiceFile(file));
  await again.recorder.start();
  again.change(path.join(client, 'src', 'index.ts'), 'C3\n');
  await again.settle();
  again.change(path.join(server, 'src', 'index.ts'), 'S2\n');
  await again.settle();
  assert.deepEqual(again.events(), [
    ['modify', 'app/src/index.ts'],
    ['modify', 'server-app/src/index.ts'],
  ]);
});

test('at-l3q.11.3 a remembered label the folder now has a directory for is replaced in the next session only', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'A0\n' });
  const fix = path.join(repo, '.worktrees', 'fix');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', fix);
  const file = path.join(tempDir('at-rl-choices-'), 'checkouts.json');
  const choices = new CheckoutChoiceFile(file);
  choices.set(key(repo), fix);
  const t = recorderOn(settings(), [repo], choices);
  await t.recorder.start();
  const a = path.join(fix, 'src', 'a.ts');
  t.change(a, 'A1\n');
  await t.settle();
  // The main checkout gains a top-level fix/ directory while recording: the label holds for the session.
  write(repo, 'fix/a.ts', 'mine\n');
  await t.recorder.refreshFilter('Worktrees changed');
  t.change(a, 'A2\n');
  await t.settle();
  assert.deepEqual(t.events(), [
    ['modify', 'fix/src/a.ts'],
    ['modify', 'fix/src/a.ts'],
  ]);
  t.recorder.dispose();

  mock.reset();
  const again = recorderOn(settings(), [repo], new CheckoutChoiceFile(file));
  await again.recorder.start();
  again.change(a, 'A3\n');
  await again.settle();
  const [relPath] = again.timeline.all().map((e) => e.relPath);
  assert.ok(relPath.endsWith('/src/a.ts') && !relPath.startsWith('fix/'), `still shares the folder's fix/: ${relPath}`);
  assert.ok(again.logs.some((l) => l.includes('gets a new display name')));
});
