import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GAP_WATCH_LIMIT, nodeWatchDir, shareOfSystemWatches, WatchGaps, type WatchDir } from '../src/watchGaps';
import { tempDir } from './gitFixture';

/** WatchGaps on a fake WatchDir, watching at most `total` at once: `open` lists the watched paths, `fail` makes watches throw. */
function gaps(total = Infinity) {
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
  const g = new WatchGaps(
    watchDir,
    (dir, name, kind) => entries.push(`${kind} ${dir}/${name}`),
    (l) => logs.push(l),
    (owner) => `lane ${owner}`,
    total,
  );
  /** Watches `dir` for `owner`, with its path as its file system path. */
  const watch = (dir: string, owner = 'L') => g.watch(dir, dir, owner);
  return { g, watch, open, logs, entries, state, onEntry };
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
  const { g, watch, open } = gaps();
  assert.equal(watch('/ws/t'), true);
  assert.equal(watch('/ws/t'), false, 'already watched');
  assert.equal(g.isBlind('/ws/t/u'), true);
  g.noteReported('/ws/t');
  assert.deepEqual([...open], []);
  // Found blind, then reported before its watch started.
  assert.equal(watch('/ws/t'), false);
});

test('a directory once found blind stays blind after every watch is closed, even with its reported parent forgotten', () => {
  const { g, watch } = gaps();
  watch('/ws/.claude/worktrees');
  g.closeAll();
  // A walk after a restart reaches it from a parent it has no report of.
  assert.equal(g.isBlindIn('/ws/.claude', false, '/ws/.claude/worktrees'), true);
  assert.equal(g.isBlind('/ws/.claude/worktrees/x'), true);
});

test('a deleted path stops the watches in it and forgets what was known there, through folders known only by what is in them', () => {
  const { g, watch, open } = gaps();
  g.noteReported('/ws/p/q');
  for (const d of ['/ws/p/q/r', '/ws/p/q/r/s', '/ws/pq']) watch(d);
  g.deleted('/ws/p/q/r/file.ts');
  assert.equal(open.size, 3, 'a file delete stops nothing');
  // p itself was never reported or watched.
  g.deleted('/ws/p');
  assert.deepEqual([...open], ['/ws/pq'], 'only the paths in it');
  assert.equal(g.isBlind('/ws/p/q/x'), false, 'its reports are forgotten, so a tree made there again is judged afresh');
});

test('entries changed in a watched directory are passed on with its file system path', () => {
  const { g, entries, onEntry } = gaps();
  g.watch('/ws/a/b', '/fs/a/b', 'L');
  onEntry.get('/fs/a/b')!('x.ts', 'rename');
  onEntry.get('/fs/a/b')!('x.ts', 'change');
  assert.deepEqual(entries, ['rename /fs/a/b/x.ts', 'change /fs/a/b/x.ts']);
});

test('each lane has its own limit, logged once by name until it is released', () => {
  const { g, watch, logs, open } = gaps();
  for (let i = 0; i < GAP_WATCH_LIMIT; i++) assert.equal(watch(`/ws/big/d${i}`, 'main'), true);
  assert.equal(watch('/ws/big/over', 'main'), false);
  assert.equal(watch('/ws/big/over2', 'main'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^lane main: over ${GAP_WATCH_LIMIT} new folders .*Reload Window`));
  // Another lane is not held back by it, and neither is a watch it shares.
  assert.equal(watch('/ws/.claude/worktrees/x/src', 'x'), true);
  watch('/ws/big/d0', 'x');
  assert.equal(open.size, GAP_WATCH_LIMIT + 1);
  // Letting go of its own watches frees the lane's room; the shared one stays for the other lane.
  g.release('main');
  assert.equal(open.size, 2);
  assert.equal(watch('/ws/big/over', 'main'), true);
  assert.equal(logs.length, 1);
});

test('keepOnly lets go of the watches a full walk no longer reached, and keeps ones asked for since it began', () => {
  const { g, watch, open } = gaps();
  for (const d of ['/ws/a', '/ws/b', '/ws/c']) watch(d);
  watch('/ws/c', 'other');
  const mark = g.mark();
  // During the walk: a new folder elsewhere, and b asked for again by another walk.
  watch('/ws/d');
  watch('/ws/b');
  g.keepOnly('L', new Set(['/ws/a']), mark);
  assert.deepEqual([...open].sort(), ['/ws/a', '/ws/b', '/ws/c', '/ws/d'], 'c is still the other lane’s');
  g.unwatch('/ws/c', 'other');
  assert.deepEqual([...open].sort(), ['/ws/a', '/ws/b', '/ws/d']);
  g.unwatch('/ws/a', 'other');
  assert.deepEqual([...open].sort(), ['/ws/a', '/ws/b', '/ws/d'], 'a lane that never relied on it lets go of nothing');
});

test('watches across lanes stop at the total, logged once, and a refused directory is not remembered as blind', () => {
  const { g, watch, logs, open } = gaps(3);
  assert.equal(watch('/ws/a', 'A'), true);
  assert.equal(watch('/ws/b', 'A'), true);
  assert.equal(watch('/ws/c', 'B'), true);
  assert.equal(watch('/ws/d', 'B'), false);
  assert.equal(watch('/ws/e', 'A'), false);
  assert.equal(open.size, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Over 3 new folders are hidden/);
  assert.equal(g.isBlindIn('/ws', false, '/ws/d'), false, 'refused, so nothing is kept of it');
  assert.equal(g.isBlindIn('/ws', false, '/ws/a'), true);
  // A watch a lane shares is no new one.
  watch('/ws/a', 'B');
  assert.equal(open.size, 3);
});

test('once the system is out of inotify watches, none is tried again until every watch is closed', () => {
  const { watch, g, logs, state, open } = gaps();
  state.fail = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
  assert.equal(watch('/ws/a'), false);
  state.fail = undefined;
  assert.equal(watch('/ws/b'), false, 'VS Code needs the rest');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /limit on inotify watches is reached.*max_user_watches/);
  g.closeAll();
  assert.equal(watch('/ws/b'), true);
  assert.deepEqual([...open], ['/ws/b']);
});

test('the total is a quarter of the inotify watches the system allows a user, up to every lane\'s limit', () => {
  const dir = tempDir('at-gap-max-');
  const file = path.join(dir, 'max_user_watches');
  fs.writeFileSync(file, '8192\n');
  assert.equal(shareOfSystemWatches(file), 2048);
  fs.writeFileSync(file, '1048576\n');
  assert.equal(shareOfSystemWatches(file), 5 * GAP_WATCH_LIMIT);
  assert.equal(shareOfSystemWatches(path.join(dir, 'missing')), 5 * GAP_WATCH_LIMIT);
});

test('knows a directory reported, found blind or watched, and not one only above them', () => {
  const { g, watch } = gaps();
  g.noteReported('/ws/a');
  watch('/ws/a/b');
  assert.equal(g.knows('/ws/a'), true);
  assert.equal(g.knows('/ws/a/b'), true);
  assert.equal(g.knows('/ws'), false);
  assert.equal(g.knows('/ws/a/b/c'), false);
});

test('past 20000 directories, ones known only as reported are forgotten, and blind ones are kept', () => {
  const { g, watch } = gaps();
  g.noteReported('/ws/keep');
  watch('/ws/keep/b');
  for (let i = 0; i < 20_000; i++) g.noteReported(`/ws/many/d${i}`);
  assert.equal(g.isBlind('/ws/many/d0/x'), false, 'forgotten, so taken as watched');
  assert.equal(g.isBlind('/ws/many/d19997/x'), true, 'the report whose trim forgot the others is kept');
  assert.equal(g.isBlind('/ws/many/d19999/x'), true, 'reported after the trim, so still known');
  assert.equal(g.isBlind('/ws/keep/b/c'), true);
  assert.equal(g.isBlindIn('/ws/keep', false, '/ws/keep/c'), true, 'the parent of a blind one is kept as reported');
});

test('a directory gone before its watch starts is skipped quietly; other failures are logged once', () => {
  const { watch, logs, state } = gaps();
  state.fail = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  assert.equal(watch('/ws/gone'), false);
  assert.deepEqual(logs, []);
  state.fail = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  assert.equal(watch('/ws/a'), false);
  assert.equal(watch('/ws/b'), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Could not watch \/ws\/a, a folder VS Code's file watcher does not see: .*EACCES/);
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
