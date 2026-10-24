// Recorder scope refresh and worktree lifecycle (review group REC3). Runs the
// real Recorder on real files and git repositories, with 'vscode' replaced by
// test/vscode-mock.ts. Watcher events are fired by hand, in the order git
// writes the files.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Recorder, type CheckoutChoices } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { laneKey, listWorktrees, pathKey, type WorktreeListResult } from '../src/worktrees';
import type { Settings } from '../src/config';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longer than the recorder's quiet period for deletes in a chosen worktree. */
const HOLD_MS = 3600;

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
    arrowNavigation: false,
    arrowKeysPerSecond: 15,
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
    highlightAdditions: true,
    markDeletions: true,
    autoRecordWorktrees: 'off',
    autoFollow: false,
    ...over,
  };
}

let current: Recorder | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
  mock.reset();
});

interface Options {
  choices?: CheckoutChoices;
  lister?: (folder: string) => Promise<WorktreeListResult>;
}

function recorderOn(s: Settings, opts: Options, dir: string) {
  mock.open(dir);
  const timeline = new Timeline(1000);
  const logs: string[] = [];
  const log = { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel;
  const recorder = new Recorder(timeline, () => s, log, opts.choices, opts.lister);
  current = recorder;
  const folder = mock.folders[0] as unknown as vscode.WorkspaceFolder;
  const uri = (file: string) => vscode.Uri.file(file);
  const fire = (kind: 'create' | 'change' | 'delete', file: string) => mock.fire(kind, file);
  /** Writes the file and reports it, as an agent's write and the watcher would. */
  const change = (file: string, text: string, kind: 'create' | 'change' = 'change') => {
    write(path.dirname(file), path.basename(file), text);
    fire(kind, file);
  };
  /** Waits for every debounce and read to finish, then hands held changes to the timeline. */
  const settle = async (extra = 0) => {
    await sleep(s.debounceMs + 150 + extra);
    for (let i = 0; i < 250 && !recorder.describeActivity().includes('debouncing: none; reading: 0;'); i++) await sleep(20);
    await sleep(50);
    recorder.drainHeld();
  };
  const events = () => timeline.all().map((e) => `${e.kind} ${e.relPath}`);
  const checkout = () => recorder.checkoutOf(folder);
  return { recorder, timeline, logs, folder, uri, fire, change, settle, events, checkout };
}

async function until(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function committedRepo(files: Record<string, string>, prefix = 'at-rs-'): string {
  const repo = tempRepo(prefix);
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/** A repository with a sibling worktree `side` outside it, chosen for the folder. */
function repoWithChosenSibling(files: Record<string, string>) {
  const repo = committedRepo(files);
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  const choices = new Map<string, string>([[vscode.Uri.file(repo).toString(), side]]);
  return { repo, side, choices };
}

/** Choices that keep each value in memory but fail to save it, as a read-only checkouts.json does. */
class UnsavableChoices implements CheckoutChoices {
  readonly map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: string | undefined): Error {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return new Error('EACCES: permission denied');
  }
}

/** Deletes a path, retrying for a while when Windows reports it busy or locked. */
async function rm(p: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt >= 100) throw err;
      await sleep(100);
    }
  }
}

const doc = (file: string, text: string) => ({ uri: vscode.Uri.file(file), getText: () => text });
const live = () => mock.watchers.filter((w) => !w.disposed).length;

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

function flakyLister() {
  const state = { fail: false, calls: 0 };
  const lister = async (folder: string): Promise<WorktreeListResult> => {
    state.calls++;
    return state.fail ? { kind: 'unavailable', reason: 'spawn git EAGAIN' } : listWorktrees(folder);
  };
  return { state, lister };
}

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

// --- at-2i9.4: several checkouts record at once, each in its own lane.

/** A repository with a nested worktree `feat` and a sibling worktree `side`. */
function repoWithWorktrees(files: Record<string, string>) {
  const repo = committedRepo(files);
  const nested = path.join(repo, '.worktrees', 'feat');
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', nested);
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  return { repo, nested, side };
}

const laneOf = (t: ReturnType<typeof recorderOn>, i: number) => t.timeline.all()[i]?.lane;

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

/** Adds a sibling worktree and reports it the way git's common directory watcher would. */
function addWorktree(t: ReturnType<typeof recorderOn>, repo: string, name: string): string {
  const dir = `${repo}-${name}`;
  git(repo, 'worktree', 'add', '-q', '-b', name, dir);
  t.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir)));
  return dir;
}

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

test('auto-record fill: a new worktree gets its own lane and its writes are recorded', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  const dir = addWorktree(t, repo, 'fix');
  await until('lane added', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  assert.equal(t.checkout()?.lanes, 2);
  assert.ok(t.logs.some((l) => l.startsWith('Recording the new worktree fix')), t.logs.join('\n'));
  t.change(path.join(dir, 'src', 'a.ts'), 'fix\n');
  await t.settle();
  assert.deepEqual(t.events(), [`modify ${path.basename(dir)}/src/a.ts`]);
  assert.equal(t.timeline.all()[0].before, 'a\n');
});

test('auto-record fill at the cap logs and skips the new worktree', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  addWorktree(t, repo, 'extra');
  await until('skip logged', () => t.logs.some((l) => l.includes('is not recorded: at most 5')));
  assert.equal(t.checkout()?.lanes, 5);
});

test('auto-record rotate: the idlest lane stops for a new worktree, unless every lane is busy', { skip: noGit }, async () => {
  const { repo, nested, side } = repoWithWorktrees({ 'src/a.ts': 'a\n' });
  for (const name of ['w3', 'w4']) git(repo, 'worktree', 'add', '-q', '-b', name, `${repo}-${name}`);
  const t = recorderOn(settings({ autoRecordWorktrees: 'rotate' }), {}, repo);
  await t.recorder.start();
  await t.recorder.setCheckouts(t.folder, [repo, nested, side, `${repo}-w3`, `${repo}-w4`]);
  // Every lane started recording just now: none has been idle for long.
  addWorktree(t, repo, 'busy');
  await until('skip logged', () => t.logs.some((l) => l.includes('every lane but the followed one changed')));
  assert.equal(t.checkout()?.lanes, 5);
  // Make the side lane look idle for long.
  const sideLane = t.timeline.laneList().find((l) => pathKey(l.root) === pathKey(side))!;
  t.timeline.defineLane({ ...sideLane, since: Date.now() - 10 * 60_000 });
  for (const l of t.timeline.laneList()) if (l.id !== sideLane.id) t.timeline.defineLane({ ...l, since: Date.now() });
  addWorktree(t, repo, 'next');
  await until('rotated', () => t.logs.some((l) => l.includes('idle longest, to record the new worktree next')));
  // A stopped lane with no changes is forgotten.
  await until('lanes refreshed', () => t.timeline.laneInfo(sideLane.id)?.recording !== true);
  assert.ok(t.recorder.recordedLanes().some((l) => l.name === 'next'));
  assert.equal(t.checkout()?.lanes, 5);
});

test('auto-record rotate: two worktrees added at once each take an idle lane, never each other\'s', { skip: noGit }, async () => {
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
  await until('both rotated in', () => t.logs.filter((l) => l.includes('idle longest, to record the new worktree')).length === 2);
  await until('lanes refreshed', () => t.recorder.recordedLanes().some((l) => l.name === 'two'));
  const names = t.recorder.recordedLanes().map((l) => l.name);
  assert.ok(names.includes('one') && names.includes('two'), names.join(', '));
  assert.ok(!t.logs.some((l) => /Stopped recording (one|two),/.test(l)), t.logs.join('\n'));
  assert.equal(names.length, 5);
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
  current = recorder;
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
    return { kind: 'ok', worktrees: r.worktrees.map((w) => (pathKey(w.path) === pathKey(initializingNow) ? { ...w, locked: 'initializing' } : w)) };
  };
  const t = recorderOn(settings({ autoRecordWorktrees: 'fill' }), { lister }, repo);
  await t.recorder.start();
  const dir = `${repo}-slow`;
  initializingNow = dir;
  addWorktree(t, repo, 'slow');
  await until('listed while initializing', () => t.logs.some((l) => l.startsWith('Worktrees changed')));
  assert.equal(t.checkout()?.lanes, 1, 'recorded before git finished');
  initializingNow = '';
  await until('recorded once done', () => t.checkout()?.lanes === 2, 5000);
  assert.ok(t.logs.some((l) => l.startsWith('Recording the new worktree slow')));
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
  current = recorder;
  const folders = mock.folders as unknown as vscode.WorkspaceFolder[];
  await recorder.start();
  assert.equal(recorder.recordedLanes().length, 5);
  assert.ok(logs.some((l) => l.includes('not recording g6') || l.includes(`not recording ${folders[5].name}`)), logs.join('\n'));
  await assert.rejects(recorder.addCheckout(folders[5], dirs[5]), /At most 5 checkouts/);
  recorder.stop();
  assert.deepEqual(recorder.defaultRecorded(folders[5]), [], 'the sixth folder shows as not recorded');
  assert.deepEqual(recorder.defaultRecorded(folders[0]), [dirs[0]]);
});

test('a checkout cleared while auto-record lists worktrees stays cleared', { skip: noGit }, async () => {
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
  current = recorder;
  const folder = mock.folders[0] as unknown as vscode.WorkspaceFolder;
  await recorder.start();
  await recorder.setCheckouts(folder, [repo, side]);
  slow = true;
  const fresh = `${repo}-fresh`;
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh);
  mock.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', 'fresh'));
  // Past the debounce, the refresh has read the first folder and waits on the second; clear side meanwhile.
  await sleep(500);
  const cleared = recorder.setCheckouts(folder, [repo]);
  await until('fresh recorded', () => recorder.recordedLanes().some((l) => l.name === 'fresh'), 10000);
  await cleared;
  slow = false;
  await recorder.refreshFilter('Settled');
  const names = recorder.recordedLanes().map((l) => l.name);
  assert.ok(!names.includes('side'), `side came back: ${names.join(', ')}`);
  assert.ok(names.includes('fresh'));
});
