import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GAP_WATCH_LIMIT, nodeWatchDir, WatchGaps, type WatchDir } from '../src/watchGaps';
import { tempDir } from './gitFixture';

/** WatchGaps on a fake WatchDir: `open` lists the watched paths, `fail` makes the next watch throw. */
function gaps() {
  const open = new Set<string>();
  const logs: string[] = [];
  const entries: string[] = [];
  const state = { fail: undefined as NodeJS.ErrnoException | undefined };
  const onEntry = new Map<string, (name: string, kind: 'rename' | 'change') => void>();
  const watchDir: WatchDir = (fsPath, entry) => {
    if (state.fail) throw state.fail;
    open.add(fsPath);
    onEntry.set(fsPath, entry);
    return { close: () => open.delete(fsPath) };
  };
  const g = new WatchGaps(watchDir, (dir, name, kind) => entries.push(`${kind} ${dir}/${name}`), (l) => logs.push(l));
  return { g, open, logs, entries, state, onEntry };
}

test('a directory is blind under a reported one until reported itself, and anything under a blind one is too', () => {
  const { g } = gaps();
  assert.equal(g.isBlind('/ws/a/b'), false, 'with nothing reported, a directory is taken as watched');
  g.noteReported('/ws/a');
  assert.equal(g.isBlind('/ws/a'), false);
  assert.equal(g.isBlind('/ws/a/b'), true);
  assert.equal(g.isBlind('/ws/a/b/c'), true);
  assert.equal(g.isBlind('/ws/other'), false);
  g.noteReported('/ws/a/b');
  assert.equal(g.isBlind('/ws/a/b'), false);
  assert.equal(g.isBlind('/ws/a/b/c'), true);
  // One found in a walk goes by its parent.
  assert.equal(g.isBlindIn('/ws/a/b', false, '/ws/a/b/c'), true, 'under a reported parent');
  assert.equal(g.isBlindIn('/ws/x', true, '/ws/x/y'), true, 'under a blind parent');
  assert.equal(g.isBlindIn('/ws/x', false, '/ws/x/y'), false, 'under a parent the watcher saw from the start');
  assert.equal(g.isBlindIn('/ws/a', false, '/ws/a/b'), false, 'reported itself');
});

test('a watched directory is blind, and a report of it stops the watch', () => {
  const { g, open } = gaps();
  assert.equal(g.watch('/ws/t', '/ws/t'), true);
  assert.equal(g.watch('/ws/t', '/ws/t'), false, 'already watched');
  assert.equal(g.isBlind('/ws/t/u'), true);
  g.noteReported('/ws/t');
  assert.deepEqual([...open], []);
  // Found blind, then reported before its watch started.
  assert.equal(g.watch('/ws/t', '/ws/t'), false);
});

test('a deleted path stops the watches in it and forgets the reports in it', () => {
  const { g, open } = gaps();
  g.noteReported('/ws/a');
  g.noteReported('/ws/a/b');
  for (const d of ['/ws/a/b/c', '/ws/a/b/c/d', '/ws/ab']) g.watch(d, d);
  g.deleted('/ws/a/b/c/file.ts');
  assert.equal(open.size, 3, 'a file delete stops nothing');
  g.deleted('/ws/a');
  assert.deepEqual([...open], ['/ws/ab'], 'only the paths in it');
  assert.equal(g.isBlind('/ws/a/b/x'), false, 'its reports are forgotten, so a tree made there again is judged afresh');
});

test('entries changed in a watched directory are passed on with its file system path', () => {
  const { g, entries, onEntry } = gaps();
  g.watch('/ws/a/b', '/fs/a/b');
  onEntry.get('/fs/a/b')!('x.ts', 'rename');
  onEntry.get('/fs/a/b')!('x.ts', 'change');
  assert.deepEqual(entries, ['rename /fs/a/b/x.ts', 'change /fs/a/b/x.ts']);
});

test('watches stop at the limit, which is logged once until every watch is closed', () => {
  const { g, logs, open } = gaps();
  for (let i = 0; i < GAP_WATCH_LIMIT; i++) assert.equal(g.watch(`/ws/d${i}`, `/ws/d${i}`), true);
  assert.equal(g.watch('/ws/over', '/ws/over'), false);
  assert.equal(g.watch('/ws/over2', '/ws/over2'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`Over ${GAP_WATCH_LIMIT} new folders`));
  g.closeAll();
  assert.equal(open.size, 0);
  assert.equal(g.watch('/ws/again', '/ws/again'), true);
});

test('a directory gone before its watch starts is skipped quietly; other failures are logged once', () => {
  const { g, logs, state } = gaps();
  state.fail = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  assert.equal(g.watch('/ws/gone', '/ws/gone'), false);
  assert.deepEqual(logs, []);
  state.fail = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
  assert.equal(g.watch('/ws/a', '/ws/a'), false);
  assert.equal(g.watch('/ws/b', '/ws/b'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Could not watch \/ws\/a.*ENOSPC/);
});

test('reports outlive closeAll, so a restarted recording watches the same blind directories', () => {
  const { g } = gaps();
  g.noteReported('/ws/a');
  g.watch('/ws/a/b', '/ws/a/b');
  g.closeAll();
  assert.equal(g.isBlind('/ws/a/b'), true);
});

test('nodeWatchDir names entries created and written in the directory', async () => {
  const dir = tempDir('at-gap-');
  const seen: string[] = [];
  const watch = nodeWatchDir(dir, (name) => seen.push(name), () => {});
  try {
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    for (let i = 0; i < 100 && !seen.includes('x.ts'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.includes('x.ts'), `saw ${seen.join(', ')}`);
  } finally {
    watch.close();
  }
});
