import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
