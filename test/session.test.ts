import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Timeline,
  parseSession,
  toSession,
  SessionFormatError,
  SESSION_FORMAT,
  SESSION_VERSION,
  type NewChangeEvent,
} from '../src/timeline';

function ev(relPath: string, before: string, after: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1000, kind: 'modify', before, after, eol: '\n', linesAdded: 1, linesRemoved: 0 };
}

function filled(n: number, limit = 100): Timeline {
  const t = new Timeline(limit);
  for (let i = 0; i < n; i++) t.push(ev(`f${i}.ts`, String(i), String(i + 1)));
  return t;
}

/** What a session looks like after a trip through a file. */
const viaJson = (t: Timeline) => parseSession(JSON.parse(JSON.stringify(toSession(t).session)));

test('session round trip keeps every field and the cursor', () => {
  const t = filled(3);
  t.push({ ...ev('crlf.ts', 'a\nb', 'a\nc'), kind: 'create', eol: '\r\n' });
  t.complete(2);
  const s = viaJson(t);
  assert.equal(s.format, SESSION_FORMAT);
  assert.equal(s.version, SESSION_VERSION);
  assert.equal(s.cursor, 3);
  assert.deepEqual(s.events, t.all());
});

test('toSession keeps the newest events within the text cap', () => {
  const t = new Timeline(100);
  t.push(ev('a', 'xxxx', 'yyyy'));
  t.push(ev('b', 'xx', 'yy'));
  t.push(ev('c', 'x', 'y'));
  const { session, omitted } = toSession(t, 7);
  assert.deepEqual(session.events.map((e) => e.relPath), ['b', 'c']);
  assert.equal(omitted, 1);
  assert.equal(toSession(t).omitted, 0);
});

test('parseSession refuses a newer version', () => {
  const raw = { ...toSession(filled(1)).session, version: SESSION_VERSION + 1 };
  assert.throws(() => parseSession(raw), (e: Error) => e instanceof SessionFormatError && /newer version/.test(e.message));
});

test('parseSession refuses bad shapes', () => {
  const good = () => JSON.parse(JSON.stringify(toSession(filled(2)).session));
  const cases: Array<[string, (s: any) => unknown]> = [
    ['not an Agent Typewriter session', () => ({ hello: 1 })],
    ['not an Agent Typewriter session', () => null],
    ['version', (s) => ({ ...s, version: 'one' })],
    ['cursor', (s) => ({ ...s, cursor: undefined })],
    ['events', (s) => ({ ...s, events: {} })],
    ['unknown kind', (s) => (s.events[0].kind = 'rename', s)],
    ['eol', (s) => (s.events[0].eol = '\r', s)],
    ['no before', (s) => (delete s.events[1].before, s)],
    ['no time', (s) => (s.events[0].time = '1', s)],
    ['seq', (s) => (s.events[1].seq = s.events[0].seq, s)],
    ['not an object', (s) => (s.events[0] = 'x', s)],
  ];
  for (const [why, mutate] of cases) {
    assert.throws(
      () => parseSession(mutate(good())),
      (e: Error) => e instanceof SessionFormatError && e.message.includes(why),
      `expected "${why}"`,
    );
  }
});

test('restore renumbers after earlier pushes and keeps played state', () => {
  const saved = filled(4);
  saved.complete(2); // events 1 and 2 played
  const s = viaJson(saved);
  const t = filled(3); // seqs 1..3 already handed out
  t.restore(s.events, s.cursor);
  assert.deepEqual(t.all().map((e) => e.seq), [4, 5, 6, 7]);
  assert.deepEqual(t.all().map((e) => e.after), ['1', '2', '3', '4']);
  assert.deepEqual(t.all().map((e) => t.stateOf(e.seq)), ['played', 'played', 'pending', 'pending']);
  assert.equal(t.pendingCount(), 2);
  assert.equal(t.peek()?.after, '3');
  const next = t.push(ev('new', '', 'n'));
  assert.equal(next.seq, 8);
});

test('restore of a fully played or fully pending buffer', () => {
  const played = filled(3);
  played.seekToEnd();
  const a = viaJson(played);
  const t1 = new Timeline(100);
  t1.restore(a.events, a.cursor);
  assert.equal(t1.pendingCount(), 0);
  assert.equal(t1.peek(), undefined);

  const b = viaJson(filled(3));
  const t2 = new Timeline(100);
  t2.restore(b.events, b.cursor);
  assert.equal(t2.pendingCount(), 3);
  assert.equal(t2.peek()?.after, '1');
});

test('restore applies the current limit, newest kept', () => {
  const s = viaJson(filled(50));
  const t = new Timeline(10);
  t.restore(s.events, s.cursor);
  assert.equal(t.all().length, 10);
  assert.equal(t.all()[0].after, '41');
  assert.equal(t.all()[9].after, '50');
  assert.equal(t.droppedUnplayed, 0);

  // Played events trimmed away leave the cursor at the first kept event.
  const playedHalf = filled(50);
  playedHalf.complete(25);
  const p = viaJson(playedHalf);
  const t2 = new Timeline(10);
  t2.restore(p.events, p.cursor);
  assert.equal(t2.peek()?.after, '41');
});

test('a playback token from before restore is stale after it', () => {
  const t = filled(2);
  const token = t.begin(1);
  const s = viaJson(filled(3));
  t.restore(s.events, s.cursor);
  t.complete(1, token);
  assert.equal(t.pendingCount(), 3);
  assert.equal(t.peek()?.after, '1');
});
