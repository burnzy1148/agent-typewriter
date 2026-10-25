// Runs the real Recorder and Timeline on real files and git repositories, with
// 'vscode' replaced by test/vscode-mock.ts. Watcher events are fired by hand.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Recorder } from '../src/recorder';
import { Timeline } from '../src/timeline';
import type { Settings } from '../src/config';
import { mock } from './vscode-mock';
import { git, noGit, tempDir, tempRepo, write } from './gitFixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function settings(over: Partial<Settings> = {}): Settings {
  return {
    autoStart: false,
    include: ['**/*'],
    exclude: ['**/.git/**', '**/node_modules/**'],
    extensions: [],
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
    readPauseSeconds: 0,
    readPauseFromDeprecatedSetting: false,
    scrollLinesPerSecond: 60,
    arrowNavigation: false,
    arrowKeysPerSecond: 15,
    naturalOrder: false,
    debounceMs: 50,
    reorderWindowMs: 0,
    maxFileSizeKB: 512,
    gitBaselines: true,
    baselineBudgetMB: 256,
    historyLimit: 500,
    persistHistory: false,
    ignoreOwnSaves: true,
    ignoreGitOperations: true,
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

/** A recorder on these folders. `s` is read on every use, so a test can change it. */
function recorderOn(s: Settings, ...dirs: string[]) {
  mock.open(...dirs);
  const timeline = new Timeline(1000);
  const logs: string[] = [];
  const log = { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel;
  const recorder = new Recorder(timeline, () => s, log);
  current = recorder;
  const uri = (file: string) => vscode.Uri.file(file);
  /** Writes the file and reports the change, as an agent's write and the watcher would. */
  const change = (file: string, text: string | Uint8Array, kind: 'create' | 'change' = 'change') => {
    fs.writeFileSync(file, text);
    mock.fire(kind, file);
  };
  /** Waits for every debounce and read to finish, then hands held changes to the timeline. */
  const settle = async () => {
    await sleep(s.debounceMs + 150);
    for (let i = 0; i < 250 && !recorder.describeActivity().includes('debouncing: none; reading: 0;'); i++) await sleep(20);
    await sleep(50);
    recorder.drainHeld();
  };
  const events = () => timeline.all().map((e) => ({ kind: e.kind, relPath: e.relPath, before: e.before, after: e.after }));
  return { recorder, timeline, logs, uri, change, settle, events };
}

/** A gate that holds every directory read until opened. */
function holdDirectoryReads(): () => void {
  let open!: () => void;
  mock.readDirectoryGate = new Promise<void>((r) => (open = r));
  return () => {
    mock.readDirectoryGate = undefined;
    open();
  };
}

function committedRepo(files: Record<string, string>): string {
  const repo = tempRepo('at-rec-');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

// --- at-l3q.9.3: rebuilding baselines keeps the current ones until the new set is complete.

test('control: a committed file edit is recorded from the committed text', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/app.ts': 'one\n' });
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  t.change(path.join(repo, 'src/app.ts'), 'one\ntwo\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'src/app.ts', before: 'one\n', after: 'one\ntwo\n' }]);
});

for (const trigger of ['gitBaselines off', 'gitBaselines on', 'baselineBudgetMB'] as const) {
  test(`rebuild (${trigger}): an edit whose read finishes during the rebuild is recorded`, { skip: noGit }, async () => {
    const repo = committedRepo({ 'src/app.ts': 'one\n', 'src/other.ts': 'other\n' });
    const s = settings({ gitBaselines: trigger !== 'gitBaselines on' });
    const t = recorderOn(s, repo);
    await t.recorder.start();
    if (trigger === 'gitBaselines off') s.gitBaselines = false;
    else if (trigger === 'gitBaselines on') s.gitBaselines = true;
    else s.baselineBudgetMB = 128;
    const release = holdDirectoryReads();
    const rebuilt = t.recorder.refreshBaselines();
    t.change(path.join(repo, 'src/app.ts'), 'one\ntwo\n');
    await sleep(s.debounceMs + 300);
    release();
    await rebuilt;
    await t.settle();
    assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'src/app.ts', before: 'one\n', after: 'one\ntwo\n' }]);
    // The next change starts from the edit, not from a baseline the rebuild took meanwhile.
    t.change(path.join(repo, 'src/app.ts'), 'one\ntwo\nthree\n');
    await t.settle();
    assert.equal(t.events()[1]?.before, 'one\ntwo\n');
    // An untouched file got the rebuilt baseline.
    assert.ok(t.recorder.hasBaseline(t.uri(path.join(repo, 'src/other.ts'))));
  });
}

test('rebuild: an edit flushed after the rebuild finished is recorded from the old baseline', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/app.ts': 'one\n' });
  const s = settings({ debounceMs: 400 });
  const t = recorderOn(s, repo);
  await t.recorder.start();
  s.gitBaselines = false;
  const release = holdDirectoryReads();
  const rebuilt = t.recorder.refreshBaselines();
  t.change(path.join(repo, 'src/app.ts'), 'one\ntwo\n');
  await sleep(50);
  release();
  await rebuilt;
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(repo, 'src/app.ts'))), 'the rebuild dropped the baseline of a file mid-change');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'src/app.ts', before: 'one\n', after: 'one\ntwo\n' }]);
});

test('rebuild: a write just before the rebuild, reported after it, is recorded from the old baseline', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/app.ts': 'one\n' });
  const s = settings();
  const t = recorderOn(s, repo);
  await t.recorder.start();
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'one\ntwo\n');
  await sleep(20);
  s.gitBaselines = false;
  await t.recorder.refreshBaselines();
  mock.fire('change', path.join(repo, 'src/app.ts'));
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'src/app.ts', before: 'one\n', after: 'one\ntwo\n' }]);
});

test('rebuild: a write between the stat and the read of a file is recorded from the old baseline', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/app.ts': 'one\n' });
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(repo, 'src/app.ts'), hourAgo, hourAgo);
  const s = settings();
  const t = recorderOn(s, repo);
  await t.recorder.start();
  s.gitBaselines = false;
  let open!: () => void;
  mock.readFileGate = new Promise<void>((r) => (open = r));
  const reading = new Promise<void>((r) => (mock.onReadFile = () => r()));
  const rebuilt = t.recorder.refreshBaselines();
  await reading;
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'one\ntwo\n');
  mock.readFileGate = undefined;
  open();
  await rebuilt;
  mock.fire('change', path.join(repo, 'src/app.ts'));
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'src/app.ts', before: 'one\n', after: 'one\ntwo\n' }]);
});

test('rebuild: turning gitBaselines off moves untouched files to memory, within the budget', { skip: noGit }, async () => {
  const repo = committedRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
  // Files written moments ago keep their baseline through a rebuild.
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const f of ['a.ts', 'b.ts']) fs.utimesSync(path.join(repo, f), hourAgo, hourAgo);
  const s = settings();
  const t = recorderOn(s, repo);
  await t.recorder.start();
  assert.equal(t.recorder.watchedCount, 2);
  s.gitBaselines = false;
  s.baselineBudgetMB = 2 / (1024 * 1024);
  await t.recorder.refreshBaselines();
  assert.equal(t.recorder.watchedCount, 1, 'over the budget, a file keeps no baseline');
  s.baselineBudgetMB = 256;
  await t.recorder.refreshBaselines();
  assert.equal(t.recorder.watchedCount, 2);
});

test('rebuild: stop during the rebuild swaps nothing in', { skip: noGit }, async () => {
  const repo = committedRepo({ 'a.ts': 'a\n' });
  const s = settings();
  const t = recorderOn(s, repo);
  await t.recorder.start();
  s.gitBaselines = false;
  const release = holdDirectoryReads();
  const rebuilt = t.recorder.refreshBaselines();
  t.recorder.stop();
  release();
  await rebuilt;
  assert.equal(t.recorder.watchedCount, 0);
});

test('a new file a filter refresh reads before its create event arrives is recorded as a create', async () => {
  const dir = tempDir('at-rec-race-');
  write(dir, 'src/a.ts', 'a\n');
  const t = recorderOn(settings({ gitBaselines: false }), dir);
  await t.recorder.start();
  write(dir, 'src/new.ts', 'brand new\n');
  await t.recorder.refreshFilter();
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(dir, 'src/new.ts'))), 'the refresh did not read the new file');
  mock.fire('create', path.join(dir, 'src/new.ts'));
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.before, e.after]), [['create', '', 'brand new\n']]);
});

test('a refresh leaves a file with a change in its debounce to that change', async () => {
  // The debounce outlasts the refresh, which runs git and can be slow.
  const dir = tempDir('at-rec-race2-');
  const t = recorderOn(settings({ gitBaselines: false, debounceMs: 2000 }), dir);
  await t.recorder.start();
  write(dir, 'src/new.ts', 'brand new\n');
  mock.fire('create', path.join(dir, 'src/new.ts'));
  await t.recorder.refreshFilter();
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(dir, 'src/new.ts'))), false);
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.before]), [['create', '']]);
});

// --- at-l3q.9.1: nested workspace folders.

for (const order of ['outer first', 'inner first'] as const) {
  test(`nested folders (${order}): an inner file's git baseline is its own`, { skip: noGit }, async () => {
    const repo = committedRepo({ 'package.json': '{ "name": "ROOT" }\n', 'pkg/package.json': '{ "name": "PKG" }\n' });
    const inner = path.join(repo, 'pkg');
    const t = recorderOn(settings(), ...(order === 'outer first' ? [repo, inner] : [inner, repo]));
    await t.recorder.start();
    assert.equal(t.recorder.watchedCount, 2, 'each file is baselined once');
    t.change(path.join(inner, 'package.json'), '{ "name": "PKG", "version": "2" }\n');
    await t.settle();
    assert.deepEqual(
      t.events().map((e) => [e.kind, e.before]),
      [['modify', '{ "name": "PKG" }\n']],
    );
  });
}

test('nested folders: a dirty inner file starts from its disk text', { skip: noGit }, async () => {
  const repo = committedRepo({ 'package.json': '{ "name": "ROOT" }\n', 'pkg/package.json': '{ "name": "PKG" }\n' });
  const inner = path.join(repo, 'pkg');
  write(inner, 'package.json', '{ "name": "DIRTY" }\n');
  const t = recorderOn(settings(), repo, inner);
  await t.recorder.start();
  t.change(path.join(inner, 'package.json'), '{ "name": "DIRTY", "v": 2 }\n');
  await t.settle();
  assert.equal(t.events()[0]?.before, '{ "name": "DIRTY" }\n');
});

// --- at-l3q.9.2: files are decoded in their encoding.

test('a windows-1252 file is recorded with its real characters', async () => {
  const dir = tempDir('at-rec-enc-');
  write(dir, 'a.txt', '');
  fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.from('café = 1\n', 'latin1'));
  const t = recorderOn(settings(), dir);
  mock.config.set('files.encoding', 'windows1252');
  await t.recorder.start();
  t.change(path.join(dir, 'a.txt'), Buffer.from('café = 2\n', 'latin1'));
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.before, e.after]), [['café = 1\n', 'café = 2\n']]);
});

test('a UTF-16LE file with a byte order mark gets a baseline and its change is recorded', async () => {
  const dir = tempDir('at-rec-u16-');
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  fs.writeFileSync(path.join(dir, 'w.txt'), utf16('wide = 1\n'));
  const t = recorderOn(settings(), dir);
  await t.recorder.start();
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(dir, 'w.txt'))));
  t.change(path.join(dir, 'w.txt'), utf16('wide = 2\n'));
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.before, e.after]), [['modify', 'wide = 1\n', 'wide = 2\n']]);
});

// --- at-l3q.9.5: binaries do not use up the budget.

test('newer binary files do not use the budget an older text file needs', async () => {
  const dir = tempDir('at-rec-bin-');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.alloc(492, 1)]);
  write(dir, 'notes.md', 'n'.repeat(99) + '\n');
  fs.utimesSync(path.join(dir, 'notes.md'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  for (const name of ['a.png', 'b.png']) {
    fs.writeFileSync(path.join(dir, name), png);
    fs.utimesSync(path.join(dir, name), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  const t = recorderOn(settings({ gitBaselines: false, baselineBudgetMB: 1000 / (1024 * 1024) }), dir);
  await t.recorder.start();
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(dir, 'notes.md'))), 'notes.md has no baseline');
  assert.equal(t.recorder.watchedCount, 1);
  assert.deepEqual(t.logs.filter((l) => l.includes('baselineBudgetMB')), [], 'files left out were logged though every text file fits');
  t.change(path.join(dir, 'notes.md'), 'edited\n');
  await t.settle();
  assert.deepEqual(t.events().map((e) => e.kind), ['modify']);
});

test('text files left out for the budget are counted, binaries are not', async () => {
  const dir = tempDir('at-rec-bin2-');
  write(dir, 'a.md', 'a'.repeat(600));
  write(dir, 'b.md', 'b'.repeat(600));
  fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.alloc(600));
  const t = recorderOn(settings({ gitBaselines: false, baselineBudgetMB: 1000 / (1024 * 1024) }), dir);
  await t.recorder.start();
  assert.equal(t.recorder.watchedCount, 1);
  assert.match(t.logs.join('\n'), /^1 matching files have no baseline because baselineBudgetMB/m);
});

// --- at-l3q.9.6: files.watcherExclude.

test('files hidden by files.watcherExclude get no baseline, and the setting applies live', async () => {
  const dir = tempDir('at-rec-wx-');
  write(dir, 'src/a.ts', 'a1\n');
  write(dir, 'wx/w.ts', 'w1\n');
  write(dir, 'wx/big.ts', 'x'.repeat(990));
  const s = settings({ gitBaselines: false, baselineBudgetMB: 1000 / (1024 * 1024) });
  const t = recorderOn(s, dir);
  mock.config.set('files.watcherExclude', { '**/wx/**': true, '**/off/**': false });
  await t.recorder.start();
  const w = t.uri(path.join(dir, 'wx/w.ts'));
  assert.equal(t.recorder.hasBaseline(w), false);
  assert.equal(t.recorder.matches(w), false);
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(dir, 'src/a.ts'))), 'a newer hidden file took the budget');
  assert.equal(t.recorder.watchedCount, 1);
  assert.equal(t.logs.filter((l) => l.startsWith('files.watcherExclude hides **/wx/**')).length, 1);
  await t.recorder.refreshFilter();
  assert.equal(t.logs.filter((l) => l.startsWith('files.watcherExclude')).length, 1, 'logged more than once');

  const watchersBefore = mock.watchers.filter((x) => !x.disposed).length;
  fs.rmSync(path.join(dir, 'wx/big.ts'));
  mock.set('files.watcherExclude', {});
  for (let i = 0; i < 100 && !t.recorder.hasBaseline(w); i++) await sleep(20);
  assert.ok(t.recorder.hasBaseline(w), 'removing the entry gave no baseline');
  assert.equal(mock.watchers.filter((x) => !x.disposed).length, watchersBefore, 'watchers were not replaced one for one');
  t.change(path.join(dir, 'wx/w.ts'), 'w2\n');
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.relPath, e.before]), [['modify', 'wx/w.ts', 'w1\n']]);

  mock.set('files.watcherExclude', { 'wx': true });
  for (let i = 0; i < 100 && t.recorder.hasBaseline(w); i++) await sleep(20);
  assert.equal(t.recorder.hasBaseline(w), false, 'adding a path entry kept baselines under it');
});

test('a files.watcherExclude glob without a slash names a path at the root, as VS Code reads it', async () => {
  const dir = tempDir('at-rec-wx2-');
  write(dir, 'build/a.ts', 'a\n');
  write(dir, 'src/build/gen.ts', 'gen\n');
  write(dir, 'top.js', 'top\n');
  write(dir, 'src/deep.js', 'deep\n');
  const t = recorderOn(settings({ gitBaselines: false }), dir);
  mock.config.set('files.watcherExclude', { build: true, '*.js': true });
  await t.recorder.start();
  const has = (rel: string) => t.recorder.hasBaseline(t.uri(path.join(dir, rel)));
  assert.deepEqual(
    ['build/a.ts', 'src/build/gen.ts', 'top.js', 'src/deep.js'].map(has),
    [false, true, false, true],
  );
});

test('a chosen worktree outside the folder is hidden only by files.watcherExclude globs that start with **', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n', 'wx/w.ts': 'w\n', 'top/t.ts': 't\n' });
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  mock.open(repo);
  const timeline = new Timeline(100);
  const log = { appendLine: () => {} } as unknown as vscode.OutputChannel;
  const choices = new Map<string, string>([[vscode.Uri.file(repo).toString(), side]]);
  const recorder = new Recorder(timeline, () => settings(), log, choices);
  current = recorder;
  mock.config.set('files.watcherExclude', { '**/wx/**': true, top: true });
  await recorder.start();
  assert.equal(recorder.checkoutOf(mock.folders[0] as unknown as vscode.WorkspaceFolder)?.own, false, 'the worktree was not chosen');
  const has = (rel: string) => recorder.hasBaseline(vscode.Uri.file(path.join(side, rel)));
  assert.deepEqual(['src/a.ts', 'wx/w.ts', 'top/t.ts'].map(has), [true, false, true]);
});

test('a worktree added while recording is skipped even when its files are reported before its .git file', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/a.ts': 'a\n' });
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  git(repo, 'worktree', 'add', '-q', '-b', 'late', '.worktrees/late');
  // The watcher reports the checkout's files and a later write, but never the
  // new .git file: the event can come late, or be missed for a new directory.
  t.change(path.join(repo, '.worktrees/late/src/a.ts'), 'a\n', 'create');
  t.change(path.join(repo, '.worktrees/late/src/late.ts'), 'late\n', 'create');
  await t.settle();
  t.change(path.join(repo, '.worktrees/late/src/late.ts'), 'late 2\n');
  await t.settle();
  assert.deepEqual(t.events(), [], 'files of a worktree added while recording were recorded');
  // The folder's own checkout is still recorded.
  t.change(path.join(repo, 'src/a.ts'), 'a 2\n');
  await t.settle();
  assert.deepEqual(t.events().map((e) => e.relPath), ['src/a.ts']);
});

// --- at-l3q.9.7: exclude globs are applied as PathFilter reads them.

test('malformed, braced, comma and directory-name exclude globs leave matching files their baselines', { skip: noGit }, async () => {
  const repo = committedRepo({ 'src/app.ts': 'app\n', 'docs/notes/todo.md': 'todo\n', 'app.log': 'log\n', 'node_modules/p/index.js': 'p\n' });
  write(repo, 'docs/draft.md', 'draft\n');
  const t = recorderOn(settings({ exclude: ['**/node_modules/**', '**/*.{log', '**/[z-a].ts', '**/*.{log,tmp}', '**/notes,old.md', '**/notes'] }), repo);
  await t.recorder.start();
  for (const rel of ['src/app.ts', 'docs/notes/todo.md', 'docs/draft.md']) {
    const u = t.uri(path.join(repo, rel));
    assert.equal(t.recorder.matches(u), true, `${rel} should match`);
    assert.ok(t.recorder.hasBaseline(u), `${rel} has no baseline`);
  }
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(repo, 'app.log'))), false);
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(repo, 'node_modules/p/index.js'))), false);
  t.change(path.join(repo, 'docs/notes/todo.md'), 'todo 2\n');
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.before]), [['modify', 'todo\n']]);
});

// --- at-l3q.9.8: files stamped in the future.

test('a file with a future mtime gets a baseline after start, refreshFilter and refreshBaselines', async () => {
  for (const gitBaselines of [true, false]) {
    const dir = tempDir('at-rec-future-');
    write(dir, 'src/a.ts', 'a1\n');
    write(dir, 'src/future.ts', 'f1\n');
    const future = new Date('2035-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'src/future.ts'), future, future);
    const s = settings({ gitBaselines });
    const t = recorderOn(s, dir);
    const f = t.uri(path.join(dir, 'src/future.ts'));
    await t.recorder.start();
    assert.ok(t.recorder.hasBaseline(f), 'no baseline after start');
    assert.equal(t.recorder.watchedCount, 2);
    await t.recorder.refreshFilter();
    await t.recorder.refreshBaselines();
    assert.ok(t.recorder.hasBaseline(f), 'no baseline after a refresh');
    t.change(path.join(dir, 'src/future.ts'), 'f2\n');
    await t.settle();
    assert.deepEqual(t.events().map((e) => [e.kind, e.before]), [['modify', 'f1\n']]);
    if (!gitBaselines) {
      // A rebuild treats it like any other file: with no budget, its baseline goes.
      const a = t.uri(path.join(dir, 'src/a.ts'));
      fs.utimesSync(a.fsPath, future, future);
      assert.ok(t.recorder.hasBaseline(a));
      s.baselineBudgetMB = 0;
      await t.recorder.refreshBaselines();
      assert.equal(t.recorder.hasBaseline(a), false, 'a future-dated file kept its baseline over budget');
    }
    t.recorder.dispose();
    mock.reset();
  }
});

test('future-dated files left out for the budget are counted', async () => {
  const dir = tempDir('at-rec-future2-');
  const future = new Date('2035-01-01T00:00:00Z');
  for (const n of ['a', 'b']) {
    write(dir, `${n}.md`, n.repeat(600));
    fs.utimesSync(path.join(dir, `${n}.md`), future, future);
  }
  const t = recorderOn(settings({ gitBaselines: false, baselineBudgetMB: 1000 / (1024 * 1024) }), dir);
  await t.recorder.start();
  assert.equal(t.recorder.watchedCount, 1);
  assert.match(t.logs.join('\n'), /^1 matching files have no baseline/m);
});

// --- at-l3q.9.9 and at-l3q.9.10: symlinks.

function trySymlink(target: string, file: string, type: 'file' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, file, type);
    return true;
  } catch {
    return false;
  }
}

test('files under a linked directory get no baseline and take no budget', async (t0) => {
  const dir = tempDir('at-rec-ldir-');
  const lib = tempDir('at-rec-lib-');
  write(dir, 'src/main.ts', 'main\n');
  write(dir, 'src/draft.ts', 'd'.repeat(400) + '\n');
  fs.utimesSync(path.join(dir, 'src/draft.ts'), new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  write(lib, 'lib1.ts', 'l'.repeat(3000));
  if (!trySymlink(path.join(dir, 'src'), path.join(dir, 'linked'), 'junction') || !trySymlink(lib, path.join(dir, 'shared'), 'junction')) {
    t0.skip('symlinks unavailable');
    return;
  }
  const t = recorderOn(settings({ gitBaselines: false, baselineBudgetMB: 1000 / (1024 * 1024) }), dir);
  await t.recorder.start();
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(dir, 'linked/main.ts'))), false);
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(dir, 'shared/lib1.ts'))), false);
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(dir, 'src/draft.ts'))), 'a real file lost its baseline to linked files');
  assert.equal(t.recorder.watchedCount, 2);
  assert.deepEqual(t.logs.filter((l) => l.includes('baselineBudgetMB')), []);
});

test('a symlinked file gets a baseline, and swaps between link and file are modifies', { skip: noGit }, async (t0) => {
  const repo = tempRepo('at-rec-link-');
  write(repo, 'AGENTS.md', '# Agents\nline one\nline two\n');
  write(repo, 'plain.md', 'my notes\n');
  if (!trySymlink('AGENTS.md', path.join(repo, 'CLAUDE.md'), 'file')) {
    t0.skip('symlinks unavailable');
    return;
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  const claude = path.join(repo, 'CLAUDE.md');
  assert.ok(t.recorder.hasBaseline(t.uri(claude)), 'the link has no baseline');
  // As sed -i does: a temp file renamed over the link.
  fs.writeFileSync(path.join(repo, '.tmp'), '# Agents\nLINE ONE\nline two\n');
  fs.renameSync(path.join(repo, '.tmp'), claude);
  mock.fire('create', claude);
  await t.settle();
  assert.deepEqual(t.events().map((e) => [e.kind, e.relPath, e.before]), [['modify', 'CLAUDE.md', '# Agents\nline one\nline two\n']]);
  // A link renamed over a git-baselined file.
  const plain = path.join(repo, 'plain.md');
  fs.rmSync(plain);
  trySymlink('AGENTS.md', plain, 'file');
  mock.fire('create', plain);
  await t.settle();
  assert.deepEqual(t.events()[1], { kind: 'modify', relPath: 'plain.md', before: 'my notes\n', after: '# Agents\nline one\nline two\n' });
  assert.ok(t.recorder.hasBaseline(t.uri(plain)));
  // A dangling link records nothing.
  const dangling = path.join(repo, 'gone.md');
  trySymlink('nowhere.md', dangling, 'file');
  mock.fire('create', dangling);
  await t.settle();
  assert.equal(t.events().length, 2);
});

// --- at-l3q.9.11: .gitignore edits re-apply the rules even when none are known.

test('a .gitignore write re-lists the rules when no folder has any', { skip: noGit }, async () => {
  const dir = tempDir('at-rec-ign-');
  write(dir, 'notes/n.md', 'n\n');
  const t = recorderOn(settings({ respectGitignore: true }), dir);
  await t.recorder.start();
  assert.ok(!t.recorder.describeFilter().includes('not gitignored'));
  git(dir, 'init', '-q');
  write(dir, '.gitignore', 'notes/\n');
  mock.fire('create', path.join(dir, '.gitignore'));
  for (let i = 0; i < 100 && !t.recorder.describeFilter().includes('not gitignored'); i++) await sleep(20);
  assert.ok(t.recorder.describeFilter().includes('not gitignored'), 'the rules were not re-listed');
  assert.equal(t.recorder.matches(t.uri(path.join(dir, 'notes/n.md'))), false);
});

test('with respectGitignore off, a .gitignore write re-lists nothing', async () => {
  const dir = tempDir('at-rec-ign2-');
  const t = recorderOn(settings(), dir);
  await t.recorder.start();
  write(dir, '.gitignore', 'notes/\n');
  mock.fire('create', path.join(dir, '.gitignore'));
  await sleep(500);
  assert.equal(t.logs.filter((l) => l.startsWith('Filter changed')).length, 0);
});

// --- at-l3q.9.12: git baselines honor maxFileSizeKB.

test('tracked files over maxFileSizeKB get no git baseline and are never read', { skip: noGit }, async () => {
  const repo = committedRepo({ 'small.txt': 'small\n', 'big.txt': 'b'.repeat(3000) + '\n' });
  fs.writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([1, 0, 2, 0, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'binary');
  const t = recorderOn(settings({ maxFileSizeKB: 1 }), repo);
  await t.recorder.start();
  assert.equal(t.recorder.hasBaseline(t.uri(path.join(repo, 'big.txt'))), false);
  assert.ok(t.recorder.hasBaseline(t.uri(path.join(repo, 'small.txt'))));
  assert.match(t.logs.join('\n'), /Watching 2 files/);
  fs.appendFileSync(path.join(repo, 'big.txt'), 'x');
  mock.fire('change', path.join(repo, 'big.txt'));
  t.change(path.join(repo, 'logo.bin'), Buffer.from([1, 0, 9, 0, 3]));
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.deepEqual(t.logs.filter((l) => l.startsWith('Could not read the git baseline')), [], 'a binary blob was reported as unreadable');
});

// --- at-kbn.2: a delete and a create with matching content are one rename.

/** Renames on disk and reports it as the watcher does: delete and create, in either order. */
function renameOnDisk(from: string, to: string, createFirst = false) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  if (createFirst) mock.fire('create', to);
  mock.fire('delete', from);
  if (!createFirst) mock.fire('create', to);
}

const renames = (t: { timeline: Timeline }) =>
  t.timeline.all().map((e) => (e.kind === 'rename' ? `rename ${e.fromRelPath} -> ${e.relPath}` : `${e.kind} ${e.relPath}`));

for (const createFirst of [false, true]) {
  test(`a renamed file is one rename (${createFirst ? 'create' : 'delete'} reported first)`, async () => {
    const dir = tempDir('at-rec-ren-');
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const t = recorderOn(settings({ reorderWindowMs: 300 }), dir);
    await t.recorder.start();
    renameOnDisk(path.join(dir, 'src/a.ts'), path.join(dir, 'src/b.ts'), createFirst);
    await t.settle();
    assert.deepEqual(renames(t), ['rename src/a.ts -> src/b.ts']);
    const e = t.timeline.all()[0];
    assert.equal(e.fromUri, t.uri(path.join(dir, 'src/a.ts')).toString());
    assert.equal(e.uri, t.uri(path.join(dir, 'src/b.ts')).toString());
    assert.deepEqual([e.before, e.after, e.linesAdded, e.linesRemoved], ['export const a = 1;\n', 'export const a = 1;\n', 0, 0]);
    // The new path has the baseline now, so its next change is a modify from the moved text.
    t.change(path.join(dir, 'src/b.ts'), 'export const a = 2;\n');
    await t.settle();
    assert.deepEqual(t.events()[1], { kind: 'modify', relPath: 'src/b.ts', before: 'export const a = 1;\n', after: 'export const a = 2;\n' });
  });
}

test('a rename of an old file whose create is reported just before its delete is one rename (at-u47)', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  // A rename keeps the mtime, so the create's write time is from long before the window.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'src/a.ts'), old, old);
  const t = recorderOn(settings({ reorderWindowMs: 300 }), dir);
  await t.recorder.start();
  fs.renameSync(path.join(dir, 'src/a.ts'), path.join(dir, 'src/b.ts'));
  // VS Code fires a batch's creates before its deletes; a tick can fall between them.
  mock.fire('create', path.join(dir, 'src/b.ts'));
  await sleep(20);
  mock.fire('delete', path.join(dir, 'src/a.ts'));
  await t.settle();
  assert.deepEqual(renames(t), ['rename src/a.ts -> src/b.ts']);
});

test('a rename with an edit is one rename from the old text to the new', async () => {
  const dir = tempDir('at-rec-ren-');
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('');
  write(dir, 'src/a.ts', text);
  const t = recorderOn(settings({ reorderWindowMs: 300 }), dir);
  await t.recorder.start();
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/a.ts'), text.replace('line 3\n', 'line three\n'));
  fs.unlinkSync(path.join(dir, 'src/a.ts'));
  mock.fire('create', path.join(dir, 'lib/a.ts'));
  mock.fire('delete', path.join(dir, 'src/a.ts'));
  await t.settle();
  assert.deepEqual(renames(t), ['rename src/a.ts -> lib/a.ts']);
  const e = t.timeline.all()[0];
  assert.deepEqual([e.before, e.after, e.linesAdded, e.linesRemoved], [text, text.replace('line 3\n', 'line three\n'), 1, 1]);
});

test('an unrelated delete and create stay a delete and a create', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  const t = recorderOn(settings({ reorderWindowMs: 300 }), dir);
  await t.recorder.start();
  fs.unlinkSync(path.join(dir, 'src/a.ts'));
  mock.fire('delete', path.join(dir, 'src/a.ts'));
  t.change(path.join(dir, 'src/c.ts'), 'something else entirely\n', 'create');
  await t.settle();
  assert.deepEqual(renames(t).sort(), ['create src/c.ts', 'delete src/a.ts']);
});

test('a moved directory pairs each file with its namesake, empty files too', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/util/x.ts', 'export const x = 1;\n');
  write(dir, 'src/util/index.ts', '');
  const t = recorderOn(settings({ reorderWindowMs: 300 }), dir);
  await t.recorder.start();
  fs.renameSync(path.join(dir, 'src/util'), path.join(dir, 'src/lib'));
  write(dir, 'src/new.ts', '');
  mock.fire('delete', path.join(dir, 'src/util'));
  mock.fire('create', path.join(dir, 'src/new.ts'));
  mock.fire('create', path.join(dir, 'src/lib'));
  await t.settle();
  assert.deepEqual(renames(t).sort(), ['create src/new.ts', 'rename src/util/index.ts -> src/lib/index.ts', 'rename src/util/x.ts -> src/lib/x.ts']);
});

test('a rename across the filters is a create moving in and a delete moving out', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'notes.txt', 'notes\n');
  const t = recorderOn(settings({ reorderWindowMs: 300, extensions: ['ts'] }), dir);
  await t.recorder.start();
  renameOnDisk(path.join(dir, 'notes.txt'), path.join(dir, 'notes.ts'));
  await t.settle();
  assert.deepEqual(renames(t), ['create notes.ts']);
  renameOnDisk(path.join(dir, 'notes.ts'), path.join(dir, 'notes.txt'));
  await t.settle();
  assert.deepEqual(renames(t), ['create notes.ts', 'delete notes.ts']);
});

test('a rename released apart, with no reorder window, stays a delete and a create', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  const t = recorderOn(settings({ reorderWindowMs: 0 }), dir);
  await t.recorder.start();
  renameOnDisk(path.join(dir, 'src/a.ts'), path.join(dir, 'src/b.ts'));
  await t.settle();
  assert.deepEqual(renames(t).sort(), ['create src/b.ts', 'delete src/a.ts']);
});

test('a rename whose new file is edited before the delete arrives is not paired, so the edit stays last', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/a.ts', 'X\n');
  const t = recorderOn(settings({ reorderWindowMs: 3000 }), dir);
  await t.recorder.start();
  fs.renameSync(path.join(dir, 'src/a.ts'), path.join(dir, 'src/b.ts'));
  mock.fire('create', path.join(dir, 'src/b.ts'));
  await sleep(300);
  t.change(path.join(dir, 'src/b.ts'), 'Y\n');
  await sleep(300);
  mock.fire('delete', path.join(dir, 'src/a.ts'));
  await t.settle();
  assert.deepEqual(renames(t), ['create src/b.ts', 'modify src/b.ts', 'delete src/a.ts']);
  assert.equal(t.timeline.latestStates().get('src/b.ts')?.after, 'Y\n');
});

test('a rename whose old path is written again before the create arrives is not paired', async () => {
  const dir = tempDir('at-rec-ren-');
  write(dir, 'src/a.ts', 'X\n');
  const t = recorderOn(settings({ reorderWindowMs: 3000 }), dir);
  await t.recorder.start();
  fs.renameSync(path.join(dir, 'src/a.ts'), path.join(dir, 'src/b.ts'));
  mock.fire('delete', path.join(dir, 'src/a.ts'));
  await sleep(300);
  t.change(path.join(dir, 'src/a.ts'), 'Z\n', 'create');
  await sleep(300);
  mock.fire('create', path.join(dir, 'src/b.ts'));
  await t.settle();
  assert.deepEqual(renames(t).sort(), ['create src/a.ts', 'create src/b.ts', 'delete src/a.ts']);
  // The old path's own changes keep their order.
  assert.deepEqual(renames(t).filter((e) => e.endsWith('src/a.ts')), ['delete src/a.ts', 'create src/a.ts']);
  assert.deepEqual([...t.timeline.latestStates().keys()].sort(), ['src/a.ts', 'src/b.ts']);
});

// --- at-yd9: writes git operations make are not recorded.

/** A repository with `a.ts` and `b.ts` on main and a `feature` branch that changes `a.ts`, adds `c.ts` and removes `b.ts`. */
function featureRepo(): string {
  const repo = committedRepo({ 'a.ts': 'a1\n', 'b.ts': 'b1\n', 'z.ts': 'z\n' });
  git(repo, 'switch', '-qc', 'feature');
  write(repo, 'a.ts', 'a2\n');
  write(repo, 'c.ts', 'c\n');
  git(repo, 'rm', '-q', 'b.ts');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'feature');
  git(repo, 'switch', '-q', 'main');
  return repo;
}

/** Reports each file as the watcher would after git wrote it: a create, change or delete by what is on disk now. */
function fireGitWrites(repo: string, created: string[], changed: string[] = [], deleted: string[] = []): void {
  for (const rel of created) mock.fire('create', path.join(repo, rel));
  for (const rel of changed) mock.fire('change', path.join(repo, rel));
  for (const rel of deleted) mock.fire('delete', path.join(repo, rel));
}

const editorDoc = (file: string, text: string) => ({ uri: vscode.Uri.file(file), getText: () => text });

test('git: a merge records nothing, and the next edit starts from the merged text', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  git(repo, 'merge', '-q', 'feature');
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  assert.deepEqual(t.events(), []);
  const summary = /^Skipped 3 files written by git \(merge feature\) in /;
  for (let i = 0; i < 40 && !t.logs.some((l) => summary.test(l)); i++) await sleep(50);
  assert.ok(t.logs.some((l) => summary.test(l)), t.logs.join('\n'));
  t.change(path.join(repo, 'a.ts'), 'a2\nagent\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: 'a2\n', after: 'a2\nagent\n' }]);
});

test('git: a merge the watcher reports late, with no reorder window, records nothing', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings({ reorderWindowMs: 0 }), repo);
  await t.recorder.start();
  git(repo, 'merge', '-q', 'feature');
  await sleep(400);
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  assert.deepEqual(t.events(), []);
});

test('git: an agent edit during a merge, of a file the merge does not touch, is recorded', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  write(repo, 'z.ts', 'agent\n');
  git(repo, 'merge', '-q', 'feature');
  fireGitWrites(repo, ['c.ts'], ['a.ts', 'z.ts'], ['b.ts']);
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'z.ts', before: 'z\n', after: 'agent\n' }]);
});

test('git: an agent write over a merged file, read together with the merge, is recorded', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  git(repo, 'merge', '-q', 'feature');
  await sleep(120);
  t.change(path.join(repo, 'a.ts'), 'agent\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: 'a1\n', after: 'agent\n' }]);
});

/** featureRepo plus a commit on main that conflicts with feature's change to `a.ts`. */
function conflictRepo(): string {
  const repo = featureRepo();
  write(repo, 'a.ts', 'main\n');
  git(repo, 'commit', '-qam', 'main side');
  return repo;
}

test('git: conflict markers are not recorded; the resolution is, from the marker text', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  const markers = fs.readFileSync(path.join(repo, 'a.ts'), 'utf8');
  assert.match(markers, /<<<<<<</);
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  assert.deepEqual(t.events(), []);
  t.change(path.join(repo, 'a.ts'), 'resolved\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: markers, after: 'resolved\n' }]);
});

test('git: checkout --theirs is a resolution and is recorded', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  const markers = fs.readFileSync(path.join(repo, 'a.ts'), 'utf8');
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  git(repo, 'checkout', '--theirs', 'a.ts');
  fireGitWrites(repo, [], ['a.ts']);
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: markers, after: 'a2\n' }]);
});

test('git: a resolution saved from an editor is the user\'s own save', { skip: noGit }, async () => {
  const repo = conflictRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  assert.throws(() => git(repo, 'merge', '-q', 'feature'));
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  const file = path.join(repo, 'a.ts');
  mock.willSave.fire({ document: editorDoc(file, 'mine\n') });
  fs.writeFileSync(file, 'mine\n');
  mock.didSave.fire(editorDoc(file, 'mine\n'));
  mock.fire('change', file);
  await t.settle();
  assert.deepEqual(t.events(), []);
  t.change(file, 'mine\nagent\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: 'mine\n', after: 'mine\nagent\n' }]);
});

test('git: a branch switch that moves a file records no rename and holds no delete', { skip: noGit }, async () => {
  const repo = committedRepo({ 'old.ts': 'same\n' });
  git(repo, 'switch', '-qc', 'moved');
  git(repo, 'mv', 'old.ts', 'new.ts');
  git(repo, 'commit', '-qm', 'move');
  git(repo, 'switch', '-q', 'main');
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  git(repo, 'switch', '-q', 'moved');
  fireGitWrites(repo, ['new.ts'], [], ['old.ts']);
  await t.settle();
  assert.deepEqual(t.events(), []);
  assert.match(t.recorder.describeActivity(), /debouncing: none; reading: 0;/);
});

test('git: stash, pull and a pop that conflicts record nothing', { skip: noGit }, async () => {
  const origin = featureRepo();
  const clone = path.join(tempDir('at-rec-clone-'), 'clone');
  git(origin, 'clone', '-q', origin, clone);
  const t = recorderOn(settings(), clone);
  await t.recorder.start();
  t.change(path.join(clone, 'a.ts'), 'wip\n');
  await t.settle();
  assert.equal(t.events().length, 1);
  git(clone, 'stash', 'push', '-q');
  fireGitWrites(clone, [], ['a.ts']);
  await t.settle();
  git(origin, 'merge', '-q', 'feature');
  git(clone, '-c', 'pull.rebase=false', 'pull', '-q', '--no-edit');
  fireGitWrites(clone, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  assert.throws(() => git(clone, 'stash', 'pop', '-q'));
  // The pop conflicts with the pulled change to a.ts: git writes markers and keeps the stash.
  fireGitWrites(clone, [], ['a.ts']);
  await t.settle();
  assert.equal(t.events().length, 1, JSON.stringify(t.events()));
});

test('git: stash push and a clean pop record nothing', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  t.change(path.join(repo, 'z.ts'), 'wip\n');
  write(repo, 'u.ts', 'untracked\n');
  mock.fire('create', path.join(repo, 'u.ts'));
  await t.settle();
  assert.equal(t.events().length, 2);
  git(repo, 'stash', 'push', '-u', '-q');
  fireGitWrites(repo, [], ['z.ts'], ['u.ts']);
  await t.settle();
  git(repo, 'switch', '-q', 'feature');
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  git(repo, 'stash', 'pop', '-q');
  fireGitWrites(repo, ['u.ts'], ['z.ts']);
  await t.settle();
  assert.equal(t.events().length, 2, JSON.stringify(t.events()));
  t.change(path.join(repo, 'z.ts'), 'wip\nagent\n');
  await t.settle();
  assert.deepEqual(t.events().at(-1), { kind: 'modify', relPath: 'z.ts', before: 'wip\n', after: 'wip\nagent\n' });
});

test('git: restore and stash apply are recorded', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  t.change(path.join(repo, 'a.ts'), 'agent\n');
  await t.settle();
  git(repo, 'restore', 'a.ts');
  fireGitWrites(repo, [], ['a.ts']);
  await t.settle();
  assert.deepEqual(t.events().map((e) => e.after), ['agent\n', 'a1\n']);
  t.change(path.join(repo, 'a.ts'), 'wip\n');
  await t.settle();
  git(repo, 'stash', 'push', '-q');
  fireGitWrites(repo, [], ['a.ts']);
  await t.settle();
  await sleep(120);
  git(repo, 'stash', 'apply', '-q');
  fireGitWrites(repo, [], ['a.ts']);
  await t.settle();
  assert.deepEqual(t.events().map((e) => e.after), ['agent\n', 'a1\n', 'wip\n', 'wip\n']);
});

test('git: a stale index.lock delays a change by the cap, then it is recorded', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  t.change(path.join(repo, 'a.ts'), 'agent\n');
  await t.settle();
  for (let i = 0; i < 150 && t.events().length === 0; i++) await sleep(100);
  t.recorder.drainHeld();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: 'a1\n', after: 'agent\n' }]);
});

test('git: with the setting off a merge is recorded, and turning it on applies while recording', { skip: noGit }, async () => {
  const repo = featureRepo();
  const s = settings({ ignoreGitOperations: false });
  const t = recorderOn(s, repo);
  await t.recorder.start();
  git(repo, 'merge', '-q', 'feature');
  fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
  await t.settle();
  assert.deepEqual(t.events().map((e) => `${e.kind} ${e.relPath}`).sort(), ['create c.ts', 'delete b.ts', 'modify a.ts']);
  s.ignoreGitOperations = true;
  await t.recorder.refreshGitOperations();
  git(repo, 'switch', '-q', '-c', 'back', 'HEAD~1');
  fireGitWrites(repo, ['b.ts'], ['a.ts'], ['c.ts']);
  await t.settle();
  assert.equal(t.events().length, 3, JSON.stringify(t.events()));
});

test('git: a folder outside git records every write', async () => {
  const dir = tempDir('at-rec-nogit-');
  write(dir, 'a.ts', 'one\n');
  const t = recorderOn(settings(), dir);
  await t.recorder.start();
  t.change(path.join(dir, 'a.ts'), 'two\n');
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: 'one\n', after: 'two\n' }]);
});

test('git: a rebase conflict resolved, then --continue: the resolution records, the next commit does not', { skip: noGit }, async () => {
  const repo = conflictRepo();
  git(repo, 'switch', '-q', 'feature');
  write(repo, 'd.ts', 'd\n');
  git(repo, 'add', 'd.ts');
  git(repo, 'commit', '-qm', 'feature d');
  const t = recorderOn(settings(), repo);
  await t.recorder.start();
  assert.throws(() => git(repo, 'rebase', '-q', 'main'));
  const markers = fs.readFileSync(path.join(repo, 'a.ts'), 'utf8');
  fireGitWrites(repo, [], ['a.ts']);
  await t.settle();
  assert.deepEqual(t.events(), []);
  // The agent resolves and continues before the recorder reads its write.
  write(repo, 'a.ts', 'resolved\n');
  git(repo, 'add', 'a.ts');
  git(repo, '-c', 'core.editor=true', 'rebase', '--continue');
  fireGitWrites(repo, ['d.ts'], ['a.ts']);
  await t.settle();
  assert.deepEqual(t.events(), [{ kind: 'modify', relPath: 'a.ts', before: markers, after: 'resolved\n' }]);
});

test('git: git going missing while a write is classified records the write and says so once', { skip: noGit }, async () => {
  const repo = featureRepo();
  const t = recorderOn(settings({ gitBaselines: false }), repo);
  await t.recorder.start();
  git(repo, 'merge', '-q', 'feature');
  const savedPath = process.env.PATH;
  process.env.PATH = tempDir('at-rec-nopath-');
  try {
    fireGitWrites(repo, ['c.ts'], ['a.ts'], ['b.ts']);
    await t.settle();
  } finally {
    process.env.PATH = savedPath;
  }
  assert.deepEqual(t.events().map((e) => `${e.kind} ${e.relPath}`).sort(), ['create c.ts', 'delete b.ts', 'modify a.ts']);
  assert.equal(t.logs.filter((l) => l.startsWith('Git operations are recorded like any other change: git could not run')).length, 1, t.logs.join('\n'));
});
