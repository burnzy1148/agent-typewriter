import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { readCache, textHolder } from '../src/changeText';
import { crc32, sessionFromBytes, sessionToBytes, TimelineStore } from '../src/persistence';
import { sessionClears, sessionLanes, SessionFormatError, Timeline, toSession, type NewChangeEvent, type Session } from '../src/timeline';

function ev(relPath: string, before: string, after: string, lane?: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1000, kind: 'modify', before, after, eol: '\n', linesAdded: 1, linesRemoved: 0, ...(lane && { lane }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'at-store-'));
const historyOf = (dir: string) => path.join(dir, 'history');
const logsOf = (dir: string) => (fs.existsSync(historyOf(dir)) ? fs.readdirSync(historyOf(dir)).filter((f) => f.endsWith('.log')).sort() : []);
const loadFrom = (dir: string, logs: string[] = []) => new TimelineStore(dir, new Timeline(100), (l) => logs.push(l)).load();
/** Loads `dir` into a new timeline as activation does. */
function reload(dir: string, logs: string[] = [], limit = 100, maxChars = Infinity): { timeline: Timeline; store: TimelineStore } {
  const timeline = new Timeline(limit, maxChars);
  const store = new TimelineStore(dir, timeline, (l) => logs.push(l), 10);
  const saved = store.load();
  if (saved) timeline.restore(saved.events, saved.cursor, sessionClears(saved), sessionLanes(saved));
  return { timeline, store };
}
const plain = (t: Timeline) => t.all().map((e) => ({ relPath: e.relPath, before: e.before, after: e.after, lane: e.lane }));

/** Makes reads (and, when asked, renames) of one file fail as if another process held it. */
function lockFile(t: TestContext, file: string, ops: Array<'readFileSync' | 'renameSync'>): void {
  const busy = () => Object.assign(new Error(`EBUSY: resource busy or locked, '${file}'`), { code: 'EBUSY' });
  if (ops.includes('readFileSync')) {
    const real = nodeFs.readFileSync;
    t.mock.method(nodeFs, 'readFileSync', (p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (p === file) throw busy();
      return real(p, o as undefined);
    });
  }
  if (ops.includes('renameSync')) {
    const real = nodeFs.renameSync;
    t.mock.method(nodeFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (from === file) throw busy();
      real(from, to);
    });
  }
}

test('save then load restores the timeline in a new store', async () => {
  const dir = path.join(tempDir(), 'nested');
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a.ts', '', 'one'));
  t.push({ ...ev('b.ts', 'x\ny', 'x\nz'), eol: '\r\n' });
  t.push({ ...ev('c.ts', 'é ü 😀', 'ünïcödé 😀'), kind: 'rename', fromUri: 'file:///w/old.ts', fromRelPath: 'old.ts' });
  t.complete(1);
  await store.flush();
  store.stop();

  const loaded = loadFrom(dir);
  assert.ok(loaded);
  assert.deepEqual(
    loaded.events.map(({ seq, ...e }) => e),
    t.all().map(({ seq, ...e }) => e),
  );
  const { timeline } = reload(dir);
  assert.deepEqual(timeline.all(), t.all());
  assert.equal(timeline.cursor, 2);
});

test('saves are throttled while the timeline keeps changing', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 100);
  store.start();
  for (let i = 0; i < 8; i++) {
    t.push(ev(`f${i}`, '', String(i)));
    await sleep(30);
  }
  // Changes kept coming for ~240 ms; a debounce would not have written yet.
  assert.ok(fs.existsSync(path.join(historyOf(dir), 'state.json')), 'no save during continuous changes');
  await store.flush();
  assert.equal(loadFrom(dir)?.events.length, 8);
  store.stop();
});

test('each save appends only the changes it has not written; cursor moves write no text', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a', '', '1'));
  t.push(ev('b', '', '2'));
  await store.flush();
  assert.equal(store.appendedCount, 2);
  const size = () => logsOf(dir).reduce((n, f) => n + fs.statSync(path.join(historyOf(dir), f)).size, 0);
  const before = size();
  t.seekToEnd();
  await store.flush();
  assert.equal(store.appendedCount, 2);
  assert.equal(size(), before);
  assert.equal(reload(dir).timeline.pendingCount(), 0);
  t.push(ev('c', '', '3'));
  await store.flush();
  assert.equal(store.appendedCount, 3);
  assert.ok(size() > before);
  const { timeline } = reload(dir);
  assert.deepEqual(timeline.all().map((e) => e.relPath), ['a', 'b', 'c']);
  assert.equal(timeline.pendingCount(), 1);
  t.clear();
  await store.flush();
  assert.equal(loadFrom(dir), undefined);
  assert.deepEqual(logsOf(dir), []);
  store.stop();
});

test('saved text leaves memory and is read back from the log, as recorded', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  const recorded = t.push(ev('a.ts', 'recorded before', 'recorded after'));
  assert.ok(textHolder(recorded).inMemory);
  await store.flush();
  assert.ok(!textHolder(recorded).inMemory);
  readCache.clear();
  assert.equal(recorded.before, 'recorded before');
  assert.equal(recorded.after, 'recorded after');
  store.stop();

  // After a reload, nothing is read until it is needed.
  const { timeline } = reload(dir);
  const e = timeline.all()[0];
  assert.ok(!textHolder(e).inMemory);
  assert.equal(readCache.get(textHolder(e)), undefined);
  assert.equal(e.after, 'recorded after');
  assert.ok(readCache.get(textHolder(e)));
});

test('dispose saves pending changes synchronously', () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 60_000);
  store.start();
  t.push(ev('a', '', '1'));
  store.dispose();
  assert.equal(loadFrom(dir)?.events.length, 1);
});

test('two lanes save and restore with their cursors, the followed lane and clears', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  t.defineLane({ id: 'main', label: 'main', root: '/w', color: 1, recording: true });
  t.defineLane({ id: 'feat', label: 'feat', root: '/f', color: 2, recording: true });
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a.ts', '', '1', 'main'));
  t.push(ev('feat/a.ts', '', '1', 'feat'));
  t.push(ev('a.ts', '1', '2', 'main'));
  t.complete(1);
  t.clearHighlights();
  t.follow('feat');
  await store.flush();
  store.stop();
  const loaded = loadFrom(dir);
  assert.ok(loaded);
  assert.deepEqual(loaded.lanes?.map((l) => l.id), ['main', 'feat']);
  assert.equal(loaded.followed, 'feat');
  const { timeline } = reload(dir);
  assert.deepEqual(plain(timeline), plain(t));
  assert.equal(timeline.followed, 'feat');
  assert.equal(timeline.pendingCount('main'), 1);
  assert.equal(timeline.pendingCount('feat'), 1);
  assert.deepEqual(timeline.highlightClears, [{ seq: 2, lane: 'main' }, { seq: 2, lane: 'feat' }]);
  assert.equal(timeline.laneInfo('feat')?.label, 'feat');
  assert.equal(logsOf(dir).length, 2);
});

test('a timeline saved without clears loads with none', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a.ts', '', 'one'));
  await store.flush();
  store.stop();
  assert.equal(loadFrom(dir)?.highlightsFrom, undefined);
});

test('changes that fall off the buffer leave the log as whole segments', async () => {
  const dir = tempDir();
  const t = new Timeline(100, 1000);
  const store = new TimelineStore(dir, t, () => {}, 10, 300);
  store.start();
  for (let i = 0; i < 30; i++) {
    t.push(ev(`f${i}`, 'x'.repeat(100), 'y'.repeat(100), i % 2 ? 'b' : 'a'));
    await store.flush();
  }
  // 1000 characters hold the newest 5 changes.
  assert.deepEqual(t.all().map((e) => e.relPath), ['f25', 'f26', 'f27', 'f28', 'f29']);
  const disk = logsOf(dir).reduce((n, f) => n + fs.statSync(path.join(historyOf(dir), f)).size, 0);
  // A few segments of at most ~300 bytes plus one record each, never all 30 changes.
  assert.ok(disk < 3000, `log holds ${disk} bytes`);
  assert.ok(logsOf(dir).length <= 6, logsOf(dir).join(' '));
  store.stop();
  const { timeline } = reload(dir);
  assert.deepEqual(plain(timeline), plain(t));
});

test('restore applies both bounds to the saved changes', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  for (let i = 0; i < 6; i++) t.push(ev(`f${i}`, 'x'.repeat(10), 'y'.repeat(10)));
  await store.flush();
  store.stop();
  assert.deepEqual(reload(dir, [], 4).timeline.all().map((e) => e.relPath), ['f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(reload(dir, [], 100, 60).timeline.all().map((e) => e.relPath), ['f3', 'f4', 'f5']);
});

test('replacing the buffer replaces the log', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('old1', '', 'a', 'main'));
  t.push(ev('old2', '', 'b', 'feat'));
  await store.flush();
  const other = new Timeline(100);
  other.push(ev('new1', '', 'c'));
  other.push(ev('new2', 'c', 'd'));
  t.restore(other.all(), 1, undefined, {});
  await store.flush();
  assert.equal(logsOf(dir).length, 1);
  store.stop();
  assert.deepEqual(reload(dir).timeline.all().map((e) => e.relPath), ['new1', 'new2']);
});

test('a change older than the written ones makes the log be written again, in order', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('b', '', '2'));
  t.push(ev('c', '', '3'));
  await store.flush();
  t.restore([{ ...ev('a', '', '1'), seq: 0 }, ...t.all()], 0);
  await store.flush();
  readCache.clear();
  assert.deepEqual(t.all().map((e) => e.after), ['1', '2', '3']);
  store.stop();
  assert.deepEqual(plain(reload(dir).timeline), plain(t));
});

test('a torn change at the end is left out, and saving carries on after the last complete one', async () => {
  for (const cut of ['mid-text', 'mid-header', 'checksum'] as const) {
    const dir = tempDir();
    const t = new Timeline(100);
    const store = new TimelineStore(dir, t, () => {}, 10);
    store.start();
    t.push(ev('a', '', 'first'));
    t.push(ev('b', 'first', 'second'));
    await store.flush();
    t.push(ev('c', '', 'third change text'));
    await store.flush();
    store.stop();
    const file = path.join(historyOf(dir), logsOf(dir)[0]);
    const bytes = fs.readFileSync(file);
    const lastHeader = bytes.lastIndexOf('{"o":3');
    if (cut === 'mid-text') fs.writeFileSync(file, bytes.subarray(0, bytes.length - 5));
    else if (cut === 'mid-header') fs.writeFileSync(file, bytes.subarray(0, lastHeader + 10));
    else fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from('#')]));

    const logs: string[] = [];
    const first = reload(dir, logs);
    assert.deepEqual(first.timeline.all().map((e) => e.relPath), ['a', 'b'], cut);
    assert.match(logs.join('\n'), /cut short .*left out 1 change/, cut);
    assert.equal(fs.statSync(file).size, lastHeader, cut);
    first.store.start();
    first.timeline.push(ev('d', '', 'fourth'));
    await first.store.flush();
    first.store.stop();
    const quiet: string[] = [];
    const again = reload(dir, quiet);
    assert.deepEqual(plain(again.timeline), plain(first.timeline), cut);
    assert.deepEqual(quiet, [], cut);
  }
});

test('changes in later segments of a lane cut short are left out too', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10, 50);
  store.start();
  for (const f of ['a', 'b', 'c', 'd']) {
    t.push(ev(f, '', f.repeat(60)));
    await store.flush();
  }
  store.stop();
  const segments = logsOf(dir);
  assert.equal(segments.length, 4);
  const second = path.join(historyOf(dir), segments[1]);
  fs.truncateSync(second, fs.statSync(second).size - 3);
  const logs: string[] = [];
  assert.deepEqual(reload(dir, logs).timeline.all().map((e) => e.relPath), ['a']);
  assert.match(logs.join('\n'), /left out 3 change/);
  assert.deepEqual(logsOf(dir), segments.slice(0, 2));
});

test('records newer than the state load as pending; leftover temp files go', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a', '', '1'));
  t.seekToEnd();
  await store.flush();
  const state = fs.readFileSync(path.join(historyOf(dir), 'state.json'));
  t.push(ev('b', '', '2'));
  await store.flush();
  store.stop();
  // The crash came after the append and before the state was replaced.
  fs.writeFileSync(path.join(historyOf(dir), 'state.json'), state);
  fs.writeFileSync(path.join(historyOf(dir), 'state.json.tmp'), '{"half');
  const { timeline } = reload(dir);
  assert.deepEqual(timeline.all().map((e) => e.relPath), ['a', 'b']);
  assert.equal(timeline.pendingCount(), 1);
  assert.ok(!fs.existsSync(path.join(historyOf(dir), 'state.json.tmp')));
});

test('a damaged state restores the changes as pending and says so', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a', '', '1'));
  t.push(ev('b', '', '2'));
  t.seekToEnd();
  await store.flush();
  store.stop();
  fs.writeFileSync(path.join(historyOf(dir), 'state.json'), 'not json');
  const logs: string[] = [];
  const { timeline } = reload(dir, logs);
  assert.equal(timeline.pendingCount(), 2);
  assert.match(logs.join('\n'), /state could not be read \(it is not JSON\)/);
});

test('a history saved by a newer version is moved aside, not overwritten', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const first = new TimelineStore(dir, tl, () => {}, 10);
  first.start();
  tl.push(ev('a', '', '1'));
  await first.flush();
  first.stop();
  const stateFile = path.join(historyOf(dir), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ format: 'agent-typewriter-history', version: 99, first: 1, next: 2, cursor: 1 }));

  const logs: string[] = [];
  const t2 = new Timeline(100);
  const store = new TimelineStore(dir, t2, (l) => logs.push(l), 10);
  lockFile(t, historyOf(dir), ['renameSync']);
  assert.equal(store.load(), undefined);
  assert.match(logs.join('\n'), /newer version .*history version 99/);
  assert.match(logs.join('\n'), /will not be saved/);
  store.start();
  t2.push(ev('new', '', 'x'));
  store.flushSync();
  assert.match(fs.readFileSync(stateFile, 'utf8'), /"version":99/);
  t.mock.restoreAll();

  // Once it can be moved, the final save keeps it aside and saves.
  store.dispose();
  assert.match(logs.join('\n'), /Moved the unreadable saved timeline to history.unreadable/);
  assert.match(fs.readFileSync(path.join(dir, 'history.unreadable', 'state.json'), 'utf8'), /"version":99/);
  assert.deepEqual(loadFrom(dir)?.events.map((e) => e.relPath), ['new']);
});

test('a state that cannot be read is reported and moved aside', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const first = new TimelineStore(dir, tl, () => {}, 10);
  first.start();
  tl.push(ev('a', '', '1'));
  await first.flush();
  first.stop();
  const logs: string[] = [];
  const store = new TimelineStore(dir, new Timeline(100), (l) => logs.push(l), 10);
  lockFile(t, path.join(historyOf(dir), 'state.json'), ['readFileSync']);
  assert.equal(store.load(), undefined);
  t.mock.restoreAll();
  assert.match(logs.join('\n'), /could not read the saved timeline \(EBUSY/i);
  assert.ok(fs.existsSync(path.join(dir, 'history.unreadable', 'state.json')));
  // A missing history is not worth a log line.
  const quiet: string[] = [];
  assert.equal(loadFrom(tempDir(), quiet), undefined);
  assert.deepEqual(quiet, []);
});

/** Writes `t` as the one-file timeline earlier versions saved. */
function writeLegacy(dir: string, t: Timeline): Session {
  const { session } = toSession(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'timeline.json.gz'), sessionToBytes(session, { gzip: true }));
  return session;
}

test('a timeline saved by an earlier version is migrated to the log, then removed', async () => {
  const dir = tempDir();
  const old = new Timeline(100);
  old.defineLane({ id: 'feat', label: 'feat', root: '/f', color: 2, recording: false });
  old.push(ev('a.ts', '', 'one'));
  old.push(ev('b.ts', '', 'two', 'feat'));
  old.push(ev('a.ts', 'one', 'three'));
  old.complete(1);
  old.clearHighlights('a.ts');
  writeLegacy(dir, old);

  const { timeline, store } = reload(dir);
  assert.deepEqual(plain(timeline), plain(old));
  assert.equal(timeline.pendingTotal(), 2);
  assert.equal(timeline.highlightClears.length, 1);
  store.start();
  await store.flush();
  store.stop();
  assert.ok(!fs.existsSync(path.join(dir, 'timeline.json.gz')));
  const again = reload(dir).timeline;
  assert.deepEqual(plain(again), plain(old));
  assert.equal(again.pendingTotal(), 2);
  assert.deepEqual(again.highlightClears, timeline.highlightClears);
});

test('an interrupted migration starts over from the earlier file', async () => {
  const dir = tempDir();
  const old = new Timeline(100);
  old.push(ev('a.ts', '', 'one'));
  old.push(ev('b.ts', '', 'two'));
  writeLegacy(dir, old);
  const { timeline, store } = reload(dir);
  store.start();
  await store.flush();
  store.stop();
  // As if the state had never been written.
  fs.rmSync(path.join(historyOf(dir), 'state.json'));
  writeLegacy(dir, old);
  assert.equal(timeline.all().length, 2);
  const again = reload(dir).timeline;
  assert.deepEqual(plain(again), plain(old));
});

test('an earlier timeline file that is damaged is reported and moved aside', () => {
  const dir = tempDir();
  const logs: string[] = [];
  fs.writeFileSync(path.join(dir, 'timeline.json.gz'), 'not gzip');
  assert.equal(loadFrom(dir, logs), undefined);
  assert.match(logs.join('\n'), /Could not restore/);
  assert.ok(fs.existsSync(path.join(dir, 'timeline.unreadable.json.gz')));
  fs.writeFileSync(path.join(dir, 'timeline.json.gz'), zlib.gzipSync(JSON.stringify({ format: 'agent-typewriter-session', version: 99, cursor: 1, events: [] })));
  assert.equal(loadFrom(dir, logs), undefined);
  assert.match(logs.join('\n'), /newer version/);
});

test('deleteSaved brings saved text back into memory and removes every file', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a', 'before', 'after'));
  await store.flush();
  store.stop();
  fs.mkdirSync(path.join(dir, 'history.unreadable'));
  fs.writeFileSync(path.join(dir, 'timeline.unreadable.json.gz'), 'old');
  store.deleteSaved();
  assert.deepEqual(fs.readdirSync(dir), []);
  readCache.clear();
  assert.ok(textHolder(t.all()[0]).inMemory);
  assert.equal(t.all()[0].after, 'after');
  assert.equal(JSON.parse(Buffer.from(sessionToBytes(toSession(t).session, { gzip: false })).toString()).events[0].before, 'before');
  // Turned back on, it saves the current buffer again.
  store.start();
  t.push(ev('b', '', 'x'));
  await store.flush();
  store.stop();
  assert.equal(loadFrom(dir)?.events.length, 2);
});

test('a log removed while running reads as empty text', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a', 'before', 'after'));
  await store.flush();
  store.stop();
  fs.rmSync(historyOf(dir), { recursive: true });
  readCache.clear();
  assert.equal(t.all()[0].after, '');
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('session files round trip as plain JSON and as gzip', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', '', 'one\n'));
  t.push({ ...ev('b.ts', 'x\ny', 'x\nz'), eol: '\r\n' });
  const { session } = toSession(t);
  const plainBytes = sessionToBytes(session, { gzip: false });
  assert.equal(JSON.parse(Buffer.from(plainBytes).toString('utf8')).format, 'agent-typewriter-session');
  assert.deepEqual(sessionFromBytes(plainBytes).events, t.all());
  assert.deepEqual(sessionFromBytes(sessionToBytes(session, { gzip: true })).events, t.all());
});

test('non-session and damaged files are refused with a reason', () => {
  const refuses = (bytes: Uint8Array, why: RegExp) =>
    assert.throws(() => sessionFromBytes(bytes), (e: Error) => e instanceof SessionFormatError && why.test(e.message));
  refuses(Buffer.from('{"name":"package"}'), /not an Agent Typewriter session/);
  refuses(Buffer.from('hello'), /not JSON/);
  refuses(Buffer.from([0x1f, 0x8b, 1, 2, 3]), /damaged/);
});

test('stop and deleteSaved leave nothing saved', async () => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const store = new TimelineStore(dir, tl, () => {}, 10);
  store.start();
  tl.push(ev('a', '', 'secret one'));
  await store.flush();
  tl.push(ev('b', '', 'secret two'));
  store.stop();
  store.deleteSaved();
  await store.flush();
  assert.deepEqual(fs.readdirSync(dir), []);
});
