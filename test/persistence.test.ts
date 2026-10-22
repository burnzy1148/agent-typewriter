import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { sessionFromBytes, sessionToBytes, TimelineStore } from '../src/persistence';
import { SessionFormatError, Timeline, toSession, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, before: string, after: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1000, kind: 'modify', before, after, eol: '\n', linesAdded: 1, linesRemoved: 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'at-store-'));
const loadFrom = (dir: string) => new TimelineStore(dir, new Timeline(100), () => {}).load();

/** Slows async writes down so a save stays in flight; resolves once the next one has started. */
function holdWrites(t: TestContext, ms: number): Promise<void> {
  const real = fs.promises.writeFile.bind(fs.promises);
  return new Promise((started) => {
    t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof real>) => {
      started();
      await sleep(ms);
      return real(...args);
    });
  });
}

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
  t.push(ev('b.ts', 'x', 'y'));
  t.complete(1);
  await store.flush();
  store.stop();

  const loaded = new TimelineStore(dir, new Timeline(100), () => {}).load();
  assert.ok(loaded);
  assert.deepEqual(loaded.events, t.all());
  assert.equal(loaded.cursor, 2);
});

test('saves are throttled while the timeline keeps changing', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 100);
  store.start();
  const file = store.path;
  for (let i = 0; i < 8; i++) {
    t.push(ev(`f${i}`, '', String(i)));
    await sleep(30);
  }
  // Changes kept coming for ~240 ms; a debounce would not have written yet.
  assert.ok(fs.existsSync(file), 'no save during continuous changes');
  await store.flush();
  assert.equal(store.load()?.events.length, 8);
  store.stop();
});

test('cursor-only changes are saved too', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  t.push(ev('a', '', '1'));
  t.push(ev('b', '', '2'));
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  await store.flush();
  assert.equal(store.load()?.cursor, 1);
  t.seekToEnd();
  await store.flush();
  assert.equal(store.load()?.cursor, 3);
  t.clear();
  await store.flush();
  assert.equal(store.load()?.events.length, 0);
  store.stop();
});

test('flushSync writes synchronously and dispose saves pending changes', () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 60_000);
  store.start();
  t.push(ev('a', '', '1'));
  store.dispose();
  assert.equal(new TimelineStore(dir, new Timeline(100), () => {}).load()?.events.length, 1);
});

test('a damaged file is reported, moved aside, and not restored', () => {
  const dir = tempDir();
  const logs: string[] = [];
  const store = new TimelineStore(dir, new Timeline(100), (l) => logs.push(l));
  fs.writeFileSync(store.path, 'not gzip');
  assert.equal(store.load(), undefined);
  assert.match(logs.join('\n'), /Could not restore/);
  assert.ok(!fs.existsSync(store.path));
  assert.ok(fs.existsSync(path.join(dir, 'timeline.unreadable.json.gz')));

  fs.writeFileSync(store.path, zlib.gzipSync(JSON.stringify({ format: 'agent-typewriter-session', version: 99, cursor: 1, events: [] })));
  assert.equal(store.load(), undefined);
  assert.match(logs.join('\n'), /newer version/);
});

test('missing file loads as nothing, deleteSaved removes the file', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  assert.equal(store.load(), undefined);
  store.start();
  t.push(ev('a', '', '1'));
  await store.flush();
  assert.ok(fs.existsSync(store.path));
  store.stop();
  store.deleteSaved();
  assert.ok(!fs.existsSync(store.path));
  assert.equal(store.load(), undefined);
});

test('the size cap leaves out the oldest changes and says so once', async () => {
  const dir = tempDir();
  const logs: string[] = [];
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, (l) => logs.push(l), 10, 10);
  store.start();
  t.push(ev('a', 'xxxx', 'yyyy'));
  t.push(ev('b', 'xx', 'yy'));
  t.push(ev('c', 'x', 'y'));
  await store.flush();
  t.seekToEnd();
  await store.flush();
  assert.deepEqual(store.load()?.events.map((e) => e.relPath), ['b', 'c']);
  assert.equal(logs.filter((l) => /leaves out the 1 oldest/.test(l)).length, 1);
  store.stop();
});

test('session files round trip as plain JSON and as gzip', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', '', 'one\n'));
  t.push({ ...ev('b.ts', 'x\ny', 'x\nz'), eol: '\r\n' });
  const { session } = toSession(t);
  const plain = sessionToBytes(session, { gzip: false });
  assert.equal(JSON.parse(Buffer.from(plain).toString('utf8')).format, 'agent-typewriter-session');
  assert.deepEqual(sessionFromBytes(plain).events, t.all());
  assert.deepEqual(sessionFromBytes(sessionToBytes(session, { gzip: true })).events, t.all());
});

test('the workspace storage file loads as a session file', async () => {
  const dir = tempDir();
  const t = new Timeline(100);
  const store = new TimelineStore(dir, t, () => {}, 10);
  store.start();
  t.push(ev('a.ts', '', 'one'));
  await store.flush();
  store.stop();
  assert.deepEqual(sessionFromBytes(fs.readFileSync(store.path)).events, t.all());
});

test('non-session and damaged files are refused with a reason', () => {
  const refuses = (bytes: Uint8Array, why: RegExp) =>
    assert.throws(() => sessionFromBytes(bytes), (e: Error) => e instanceof SessionFormatError && why.test(e.message));
  refuses(Buffer.from('{"name":"package"}'), /not an Agent Typewriter session/);
  refuses(Buffer.from('hello'), /not JSON/);
  refuses(Buffer.from([0x1f, 0x8b, 1, 2, 3]), /damaged/);
});

test('flushSync during an in-flight save writes the newest state, once', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const store = new TimelineStore(dir, tl, () => {}, 10);
  store.start();
  tl.push(ev('a', '', '1'));
  await store.flush();

  const started = holdWrites(t, 100);
  tl.push(ev('b', '', '2'));
  tl.complete(1);
  await started;
  // Deactivation: the final save, then the context disposables, in the same tick.
  const syncWrites = t.mock.method(nodeFs, 'writeFileSync');
  store.flushSync();
  store.dispose();
  assert.equal(syncWrites.mock.callCount(), 1);
  const saved = loadFrom(dir);
  assert.equal(saved?.events.length, 2);
  assert.equal(saved?.cursor, tl.cursor);

  // The overtaken write finishes later without replacing the file or leaving its temp copy.
  await store.flush();
  assert.equal(loadFrom(dir)?.events.length, 2);
  assert.deepEqual(fs.readdirSync(dir), ['timeline.json.gz']);

  // Nothing in flight and nothing changed: no write.
  store.flushSync();
  assert.equal(syncWrites.mock.callCount(), 1);
});

test('stop and deleteSaved during an in-flight save leave nothing saved', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const store = new TimelineStore(dir, tl, () => {}, 10);
  store.start();
  tl.push(ev('a', '', 'secret one'));
  await store.flush();

  const started = holdWrites(t, 50);
  tl.push(ev('b', '', 'secret two'));
  await started;
  store.stop();
  store.deleteSaved();
  await store.flush();
  assert.deepEqual(fs.readdirSync(dir), []);

  // Turned back on, it saves the current buffer again.
  t.mock.restoreAll();
  store.start();
  tl.push(ev('c', '', 'three'));
  await store.flush();
  assert.equal(loadFrom(dir)?.events.length, 3);
  store.stop();
});

test('a saved timeline that cannot be read is reported and moved aside, not overwritten', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const first = new TimelineStore(dir, tl, () => {}, 10);
  first.start();
  for (const f of ['a', 'b', 'c']) tl.push(ev(f, '', f));
  await first.flush();
  first.stop();

  const logs: string[] = [];
  const store = new TimelineStore(dir, new Timeline(100), (l) => logs.push(l), 10);
  lockFile(t, store.path, ['readFileSync']);
  assert.equal(store.load(), undefined);
  assert.match(logs.join('\n'), /could not read the saved timeline \(EBUSY/i);
  t.mock.restoreAll();

  store.start();
  await store.flush();
  store.stop();
  const aside = path.join(dir, 'timeline.unreadable.json.gz');
  assert.equal(sessionFromBytes(fs.readFileSync(aside)).events.length, 3);
  assert.equal(loadFrom(dir)?.events.length, 0);

  // A missing file is not worth a log line.
  const quiet: string[] = [];
  assert.equal(new TimelineStore(tempDir(), new Timeline(100), (l) => quiet.push(l)).load(), undefined);
  assert.deepEqual(quiet, []);
});

test('an unreadable saved timeline that cannot be moved aside is not saved over', async (t) => {
  const dir = tempDir();
  const tl = new Timeline(100);
  const first = new TimelineStore(dir, tl, () => {}, 10);
  first.start();
  for (const f of ['a', 'b', 'c']) tl.push(ev(f, '', f));
  await first.flush();
  first.stop();
  const original = fs.readFileSync(path.join(dir, 'timeline.json.gz'));

  const logs: string[] = [];
  const t2 = new Timeline(100);
  const store = new TimelineStore(dir, t2, (l) => logs.push(l), 10);
  lockFile(t, store.path, ['readFileSync', 'renameSync']);
  assert.equal(store.load(), undefined);
  assert.match(logs.join('\n'), /will not be saved/);
  store.start();
  t2.push(ev('new', '', 'x'));
  await store.flush();
  store.flushSync();
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(store.path), original);

  // Once the file can be moved, it is kept aside and saving resumes.
  t2.push(ev('newer', '', 'y'));
  await store.flush();
  store.stop();
  assert.match(logs.join('\n'), /Moved the unreadable saved timeline/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'timeline.unreadable.json.gz')), original);
  assert.equal(loadFrom(dir)?.events.length, 2);
});
