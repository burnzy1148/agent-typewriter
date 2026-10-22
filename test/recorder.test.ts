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
    charsPerSecond: 35,
    languageSpeeds: {},
    jitter: 0,
    catchUpFactor: 0,
    maxSpeedup: 1,
    maxAnimatedChars: 6000,
    fileSwitchDelayMs: 0,
    debounceMs: 50,
    reorderWindowMs: 0,
    maxFileSizeKB: 512,
    gitBaselines: true,
    baselineBudgetMB: 256,
    historyLimit: 500,
    persistHistory: false,
    ignoreOwnSaves: true,
    viewColumn: 'beside',
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
    for (let i = 0; i < 100 && recorder.describeActivity().includes('debouncing: ') && !recorder.describeActivity().includes('debouncing: none'); i++) await sleep(20);
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

test('rebuild: turning gitBaselines off moves untouched files to memory, within the budget', { skip: noGit }, async () => {
  const repo = committedRepo({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
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
    const t = recorderOn(settings({ gitBaselines }), dir);
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
