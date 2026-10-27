import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GAP_WATCH_LIMIT, nodeWatchDir, shareOfSystemWatches, WatchGaps, type WatchDir } from '../src/watchGaps';
import { tempDir } from './gitFixture';

/** WatchGaps on a fake WatchDir, watching at most `total` at once: `open` lists the watched paths, and `fail` makes watches throw. */
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
  assert.equal(g.isBlindIn('/ws/a/b', false, 'c'), true, 'under a reported parent');
  assert.equal(g.isBlindIn('/ws/x', true, 'y'), true, 'under a blind parent');
  assert.equal(g.isBlindIn('/ws/x', false, 'y'), false, 'under a parent the watcher saw from the start');
  assert.equal(g.isBlindIn('/ws/a', false, 'b'), false, 'reported itself');
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
  assert.equal(g.isBlindIn('/ws/.claude', false, 'worktrees'), true);
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
  assert.equal(g.isBlindIn('/ws', false, 'd'), false, 'refused, so nothing is kept of it');
  assert.equal(g.isBlindIn('/ws', false, 'a'), true);
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

test('a directory reported or watched, or a watched one that went, is known until it is deleted', () => {
  const { g, watch, open } = gaps();
  g.noteReported('/ws/a');
  watch('/ws/a/b');
  watch('/ws/a/b/c');
  assert.equal(g.known('/ws/a'), true);
  assert.equal(g.known('/ws/a/b'), true);
  assert.equal(g.known('/ws'), false, 'only a step on the way');
  assert.equal(g.known('/ws/a/x'), false);
  // The watched directory itself went: its watches stop and what was in it is forgotten, but it stays known.
  g.gone('/ws/a/b');
  assert.deepEqual([...open], []);
  assert.equal(g.known('/ws/a/b'), true);
  assert.equal(g.known('/ws/a/b/c'), false);
  assert.equal(g.isBlindIn('/ws/a', false, 'b'), true, 'one made there again is blind as before, being in a reported one');
  g.deleted('/ws/a/b');
  assert.equal(g.known('/ws/a/b'), false);
  // Known after every watch is closed: the watcher stays blind there.
  watch('/ws/a/d');
  g.closeAll();
  assert.equal(g.known('/ws/a/d'), true);
});

test('a directory that may have been made again loses its watches and what was known in it, and keeps what it is', () => {
  const { g, watch, open } = gaps();
  g.noteReported('/ws/a');
  g.noteReported('/ws/a/r');
  watch('/ws/a/r/s');
  watch('/ws/a/b');
  watch('/ws/a/b/c');
  // Under a folder watch, or reported changed by VS Code's watcher while found blind: still blind.
  g.recheck('/ws/a/b', false);
  g.recheck('/ws/a/b', true);
  assert.deepEqual([...open], ['/ws/a/r/s']);
  assert.equal(g.known('/ws/a/b'), true);
  assert.equal(g.known('/ws/a/b/c'), false);
  assert.equal(g.isBlind('/ws/a/b'), true, 'to be watched again');
  assert.equal(g.isBlind('/ws/a/b/c'), true);
  // A reported one stays reported, and the ones in it are judged afresh: a/r/s may be a new one, made before the watcher watched a/r.
  g.recheck('/ws/a/r', true);
  assert.deepEqual([...open], []);
  assert.equal(g.isBlind('/ws/a/r'), false);
  assert.equal(g.isBlindIn('/ws/a/r', false, 's'), true);
  // One that went from a folder watch and was reported changed by VS Code's watcher was made again where it watches.
  watch('/ws/a/g');
  g.gone('/ws/a/g');
  g.recheck('/ws/a/g', true);
  assert.equal(g.isBlind('/ws/a/g'), false);
  // Of one nothing is known, nothing is kept.
  g.recheck('/ws/elsewhere', true);
  assert.equal(g.known('/ws/elsewhere'), false);
});

test('a directory named with a trailing slash is the same directory', () => {
  const { g, watch, open } = gaps();
  g.noteReported('/ws/a');
  assert.equal(watch('/ws/a/b/'), true);
  assert.equal(watch('/ws/a/b'), false);
  g.noteReported('/ws/a/b');
  assert.deepEqual([...open], []);
  watch('/ws/a/c/');
  g.keepOnly('L', new Set(['/ws/a/c']), g.mark());
  g.release('L');
  g.closeAll();
  assert.deepEqual([...open], []);
});

test('a refused watch leaves nothing known of its directory', () => {
  const { g, watch } = gaps(1);
  watch('/ws/a');
  assert.equal(watch('/ws/x/y/z'), false);
  assert.equal(g.known('/ws/x/y/z'), false);
  assert.equal(g.isBlind('/ws/x/y/z'), false);
});

test('past 20000 directories, older ones known only as reported are forgotten, and blind ones are kept', () => {
  const { g, watch } = gaps();
  g.noteReported('/ws/keep');
  watch('/ws/keep/b');
  for (let i = 0; i < 20_000; i++) g.noteReported(`/ws/many/d${i}`);
  assert.equal(g.isBlind('/ws/many/d0/x'), false, 'forgotten, so taken as watched');
  assert.equal(g.isBlind('/ws/many/d18997/x'), true, 'among the latest 1000 reports when the trim ran, so kept');
  assert.equal(g.isBlind('/ws/many/d19999/x'), true, 'reported after the trim, so still known');
  assert.equal(g.isBlind('/ws/keep/b/c'), true);
  assert.equal(g.isBlindIn('/ws/keep', false, 'c'), true, 'the parent of a blind one is kept as reported');
});

test('a directory reported a moment before a trim still makes the ones in it blind while it is walked', () => {
  const { g } = gaps();
  for (let i = 0; i < 19_990; i++) g.noteReported(`/ws/many/d${i}`);
  // mkdir -p a/b/c: a is reported just as the limit is crossed, then other reports come before its walk.
  g.noteReported('/ws/a');
  for (let i = 0; i < 500; i++) g.noteReported(`/ws/more/d${i}`);
  assert.equal(g.isBlindIn('/ws/a', false, 'b'), true);
  assert.equal(g.isBlind('/ws/a/b/c'), true);
});

test('ones forgotten by a trim in a reported directory that is kept are not taken for blind', () => {
  const { g, watch } = gaps();
  g.noteReported('/ws/.claude');
  g.noteReported('/ws/.claude/commands');
  watch('/ws/.claude/worktrees');
  for (let i = 0; i < 20_000; i++) g.noteReported(`/ws/many/d${i}`);
  assert.equal(g.isBlindIn('/ws/.claude', false, 'commands'), false, 'VS Code watches it: no second watch');
  assert.equal(g.isBlind('/ws/.claude/commands/x'), false);
  assert.equal(g.isBlind('/ws/.claude/worktrees/x'), true);
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

test('running out of inotify watches is logged even after another watch failed', () => {
  const { watch, logs, state } = gaps();
  state.fail = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  watch('/ws/root-owned');
  state.fail = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
  watch('/ws/a');
  assert.equal(logs.length, 2);
  assert.match(logs[1], /max_user_watches/);
  assert.equal(watch('/ws/b'), false);
  assert.equal(logs.length, 2);
});

test('a watch refused or failed is remembered until every watch is closed', () => {
  const { g, watch, state } = gaps(1);
  watch('/ws/a');
  assert.equal(g.refused, false);
  watch('/ws/b');
  assert.equal(g.refused, true, 'over the total');
  g.closeAll();
  assert.equal(g.refused, false);
  state.fail = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  watch('/ws/c');
  assert.equal(g.refused, true);
});

test('a trim keeps a watched directory that went, so it stays known', () => {
  const { g, watch } = gaps();
  g.noteReported('/ws/a');
  watch('/ws/a/g');
  g.gone('/ws/a/g');
  for (let i = 0; i < 20_000; i++) g.noteReported(`/ws/many/d${i}`);
  assert.equal(g.known('/ws/a/g'), true);
});

test('a watch that fails stops itself only, not a newer watch of the same directory', () => {
  const errors = new Map<string, () => void>();
  const open = new Set<number>();
  let n = 0;
  const watchDir: WatchDir = (_fsPath, _entry, onError) => {
    const id = ++n;
    open.add(id);
    errors.set(String(id), onError as () => void);
    return { close: () => open.delete(id) };
  };
  const g = new WatchGaps(watchDir, () => {}, () => {}, (o) => o, Infinity);
  g.noteReported('/ws/a');
  g.watch('/ws/a/b', '/ws/a/b', 'L');
  g.recheck('/ws/a/b', false);
  g.watch('/ws/a/b', '/ws/a/b', 'L');
  // The first watch errors late.
  errors.get('1')!();
  assert.deepEqual([...open], [2]);
  assert.equal(g.isWatched('/ws/a/b'), true);
});

test('a directory scanned again keeps when it was last read, and VS Code\'s report of an event in a watched one stops our watch', () => {
  const { g, watch, open } = gaps();
  g.noteReported('/ws/a');
  watch('/ws/a/b');
  watch('/ws/a/b/c');
  g.scanned('/ws/a/b', 100);
  g.scanned('/ws/elsewhere', 100);
  assert.equal(g.scannedAt('/ws/a/b'), 100);
  assert.equal(g.scannedAt('/ws/elsewhere'), undefined, 'not known, so nothing is kept');
  g.recheck('/ws/a/b', false);
  assert.equal(g.scannedAt('/ws/a/b'), 100, 'kept for the check that follows');
  watch('/ws/a/b');
  watch('/ws/a/b/c');
  g.seenByWatcher('/ws/a/b');
  assert.deepEqual([...open], ['/ws/a/b/c'], 'what is known in it stays');
  assert.equal(g.isBlind('/ws/a/b'), false);
  assert.equal(g.isBlind('/ws/a/b/c'), true);
});
