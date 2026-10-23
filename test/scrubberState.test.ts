import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, type NewChangeEvent } from '../src/timeline';
import { describePlayback, parseScrubberMessage, rowReadout, scrubberState, type PlaybackFacts } from '../src/scrubberState';

function ev(relPath: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 0, kind: 'modify', before: '', after: 'x', eol: '\n', linesAdded: 1, linesRemoved: 0 };
}

const player = { paused: false, speed: 1, watching: true };

test('slider index follows the cursor from start to caught up', () => {
  const t = new Timeline(100);
  assert.equal(scrubberState(t, player).index, 0);
  const a = t.push(ev('a.ts'));
  const b = t.push(ev('b.ts'));
  t.push(ev('c.ts'));
  assert.equal(scrubberState(t, player).index, 0);
  t.seek(b.seq);
  assert.equal(scrubberState(t, player).index, 1);
  t.seekToEnd();
  const s = scrubberState(t, player);
  assert.equal(s.index, 3);
  assert.equal(s.queued, 0);
  assert.deepEqual(
    s.changes.map((c) => c.relPath),
    ['a.ts', 'b.ts', 'c.ts'],
  );
  assert.equal(s.changes[0].seq, a.seq);
});

test('playing seq and queue count', () => {
  const t = new Timeline(100);
  const a = t.push(ev('a.ts'));
  t.push(ev('b.ts'));
  t.push(ev('c.ts'));
  assert.equal(scrubberState(t, player).playingSeq, undefined);
  assert.equal(scrubberState(t, player).queued, 3);
  t.begin(a.seq);
  const s = scrubberState(t, player);
  assert.equal(s.playingSeq, a.seq);
  assert.equal(s.queued, 2);
  assert.equal(s.index, 0);
});

test('player flags pass through', () => {
  const s = scrubberState(new Timeline(10), { paused: true, speed: 2.5, watching: false });
  assert.equal(s.type, 'state');
  assert.equal(s.paused, true);
  assert.equal(s.speed, 2.5);
  assert.equal(s.watching, false);
});

test('index stays in range when old changes are trimmed', () => {
  const t = new Timeline(3);
  for (const p of ['a', 'b', 'c', 'd', 'e']) t.push(ev(p));
  const s = scrubberState(t, player);
  assert.deepEqual(
    s.changes.map((c) => c.relPath),
    ['c', 'd', 'e'],
  );
  assert.equal(s.index, 0);
  t.seekToEnd();
  assert.equal(scrubberState(t, player).index, 3);
});

test('index is 0 after clear', () => {
  const t = new Timeline(10);
  t.push(ev('a'));
  t.clear();
  const s = scrubberState(t, player);
  assert.equal(s.index, 0);
  assert.equal(s.changes.length, 0);
});

function facts(over: Partial<PlaybackFacts>): PlaybackFacts {
  return {
    changes: [
      { seq: 11, relPath: 'a.ts', kind: 'modify' },
      { seq: 12, relPath: 'src/b.ts', kind: 'modify' },
    ],
    index: 0,
    playingSeq: undefined,
    queued: 0,
    paused: false,
    speed: 1,
    watching: true,
    ...over,
  };
}

test('label for an empty buffer', () => {
  assert.deepEqual(describePlayback(facts({ changes: [] })), { label: 'Waiting for changes', position: '0 / 0' });
  assert.equal(describePlayback(facts({ changes: [], watching: false })).label, 'Not watching');
});

test('label while typing or paused mid-change', () => {
  assert.deepEqual(describePlayback(facts({ index: 1, playingSeq: 12, queued: 3 })), {
    label: 'Typing #12 src/b.ts \u00b7 3 queued',
    position: '2 / 2',
  });
  assert.equal(describePlayback(facts({ playingSeq: 11, paused: true })).label, 'Paused in #11 a.ts');
});

test('label between changes', () => {
  assert.equal(describePlayback(facts({ index: 1, queued: 1 })).label, 'Next: #12 src/b.ts \u00b7 1 queued');
  assert.equal(describePlayback(facts({ index: 0, queued: 2, paused: true })).label, 'Paused before #11 a.ts \u00b7 2 queued');
  assert.deepEqual(describePlayback(facts({ index: 2 })), { label: 'Caught up', position: '2 / 2' });
});

test('state carries the label and position', () => {
  const t = new Timeline(10);
  const a = t.push(ev('a.ts'));
  t.begin(a.seq);
  const s = scrubberState(t, player);
  assert.equal(s.label, `Typing #${a.seq} a.ts`);
  assert.equal(s.position, '1 / 1');
});

test('row readout keeps icon syntax in file names literal', () => {
  assert.equal(rowReadout({ label: 'Next: #3 a.ts', position: '1 / 3' }), 'Next: #3 a.ts \u00b7 1 / 3');
  assert.equal(
    rowReadout({ label: 'Typing #3 docs/$(home)-notes.md', position: '1 / 3' }),
    'Typing #3 docs/\\$(home)-notes.md \u00b7 1 / 3',
  );
  // Not icon syntax, so nothing to escape.
  assert.equal(rowReadout({ label: 'Next: #4 $(odd name.ts', position: '2 / 3' }), 'Next: #4 $(odd name.ts \u00b7 2 / 3');
});

test('valid messages parse', () => {
  for (const type of ['ready', 'togglePause', 'finishCurrent', 'skipToNext', 'catchUp', 'replayAll']) {
    assert.deepEqual(parseScrubberMessage({ type }), { type });
  }
  assert.deepEqual(parseScrubberMessage({ type: 'seek', seq: 7, extra: 1 }), { type: 'seek', seq: 7 });
  assert.deepEqual(parseScrubberMessage({ type: 'speed', value: 0.5 }), { type: 'speed', value: 0.5 });
});

test('malformed messages are rejected', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'togglePause',
    42,
    {},
    { type: 'deleteEverything' },
    { type: 'seek' },
    { type: 'seek', seq: 1.5 },
    { type: 'seek', seq: -1 },
    { type: 'seek', seq: '3' },
    { type: 'speed', value: 0 },
    { type: 'speed', value: -2 },
    { type: 'speed', value: 'fast' },
    { type: 'speed', value: Infinity },
    { type: 'speed', value: NaN },
  ];
  for (const m of bad) assert.equal(parseScrubberMessage(m), undefined, JSON.stringify(m));
});

test('a rename is described with both paths', () => {
  const changes = [{ seq: 7, relPath: 'src/b.ts', kind: 'rename' as const, fromRelPath: 'src/a.ts' }];
  assert.equal(describePlayback(facts({ changes, paused: true })).label, 'Paused before #7 src/a.ts \u2192 src/b.ts');
  const t = new Timeline(10);
  t.push({ uri: 'file:///w/src/b.ts', relPath: 'src/b.ts', fromUri: 'file:///w/src/a.ts', fromRelPath: 'src/a.ts', time: 1, kind: 'rename', before: 'x', after: 'x', eol: '\n', linesAdded: 0, linesRemoved: 0 });
  t.push({ uri: 'file:///w/c.ts', relPath: 'c.ts', time: 2, kind: 'create', before: '', after: 'c', eol: '\n', linesAdded: 1, linesRemoved: 0 });
  const s = scrubberState(t, { paused: false, speed: 1, watching: true });
  assert.equal(s.changes[0].fromRelPath, 'src/a.ts');
  assert.equal('fromRelPath' in s.changes[1], false);
});
