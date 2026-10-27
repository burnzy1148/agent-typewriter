import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCache, textHolder } from '../src/changeText';
import { baselines } from '../src/highlights';
import { fitLimits, MB_CHARS, newestFitting, Timeline, type ChangeEvent, type NewChangeEvent } from '../src/timeline';

function ev(relPath: string, before: string, after: string, lane?: string): NewChangeEvent {
  return { uri: 'file:///w/' + relPath, relPath, time: 1, kind: 'modify', before, after, eol: '\n', linesAdded: 0, linesRemoved: 0, ...(lane && { lane }) };
}
const x = (n: number) => 'x'.repeat(n);

test('the size bound drops the oldest changes, whichever lane they are in', () => {
  const t = new Timeline(100, 1000);
  t.push(ev('a', x(200), x(100), 'main'));
  t.push(ev('b', x(200), x(100), 'feat'));
  t.push(ev('c', x(200), x(100), 'main'));
  assert.equal(t.textChars, 900);
  t.push(ev('d', x(200), x(100), 'feat'));
  assert.deepEqual(t.all().map((e) => e.relPath), ['b', 'c', 'd']);
  assert.equal(t.textChars, 900);
  // Nothing was played, so the dropped change counts as a dropped queued one.
  assert.equal(t.droppedUnplayed, 1);
});

test('the newest change stays even when it alone is over the bound', () => {
  const t = new Timeline(100, 10);
  t.push(ev('a', 'abc', 'def'));
  t.push(ev('b', x(50), x(50)));
  assert.deepEqual(t.all().map((e) => e.relPath), ['b']);
  t.push(ev('c', 'a', 'b'));
  assert.deepEqual(t.all().map((e) => e.relPath), ['c']);
});

test('both bounds apply: count and size', () => {
  const t = new Timeline(3, 1_000_000);
  for (const f of ['a', 'b', 'c', 'd']) t.push(ev(f, '', '1'));
  assert.deepEqual(t.all().map((e) => e.relPath), ['b', 'c', 'd']);
  t.setSizeLimit(2);
  assert.deepEqual(t.all().map((e) => e.relPath), ['c', 'd']);
  assert.equal(t.textChars, 2);
});

test('lowering the size bound drops the oldest at once', () => {
  const t = new Timeline(100);
  for (let i = 0; i < 10; i++) t.push(ev(`f${i}`, x(50), x(50)));
  let changes = 0;
  t.onDidChange(() => changes++);
  t.setSizeLimit(350);
  assert.equal(t.all().length, 3);
  assert.equal(t.all()[0].relPath, 'f7');
  assert.equal(changes, 1);
});

test('restore keeps the newest changes that fit both bounds and shares their text', () => {
  const src = new Timeline(100);
  for (let i = 0; i < 6; i++) src.push(ev(`f${i}`, x(10), x(10)));
  const t = new Timeline(5, 50);
  t.restore(src.all(), 1);
  assert.deepEqual(t.all().map((e) => e.relPath), ['f4', 'f5']);
  assert.equal(t.textChars, 40);
  assert.equal(textHolder(t.all()[1]), textHolder(src.all()[5]));
  t.clear();
  assert.equal(t.textChars, 0);
});

test('newestFitting counts from the newest, at least one', () => {
  const events = [ev('a', x(5), ''), ev('b', x(5), ''), ev('c', x(5), '')] as ChangeEvent[];
  assert.equal(newestFitting(events, 10, 10), 2);
  assert.equal(newestFitting(events, 1, 100), 1);
  assert.equal(newestFitting(events, 10, 1), 1);
  assert.equal(newestFitting([], 10, 10), 0);
});

test('mirror states and baselines read saved text once per file', () => {
  const t = new Timeline(100);
  for (let i = 1; i <= 5; i++) t.push(ev('a.ts', `v${i - 1}`, `v${i}`));
  t.push(ev('b.ts', 'b0', 'b1'));
  let reads = 0;
  for (const e of t.all()) {
    const { before, after } = e;
    textHolder(e).offload(() => (reads++, { before, after }), 'test');
  }
  readCache.clear();
  t.seek(4);
  const states = t.mirrorStates();
  assert.deepEqual(states.get('a.ts'), { text: 'v3', eol: '\n' });
  assert.deepEqual(states.get('b.ts'), { text: 'b0', eol: '\n' });
  assert.equal(reads, 2);
  readCache.clear();
  reads = 0;
  const base = baselines(t.all(), 4, []);
  assert.equal(base.get('a.ts'), 'v0');
  assert.equal(reads, 1);
});

test('fitLimits names the limits that would fit every change', () => {
  const big = [ev('a', x(MB_CHARS), ''), ev('b', x(MB_CHARS), ''), ev('c', x(MB_CHARS / 2), '')] as ChangeEvent[];
  assert.deepEqual(fitLimits(big, 500, 64), { fits: 3, historyLimit: 500, historySizeMB: 64 });
  assert.deepEqual(fitLimits(big, 500, 2), { fits: 2, historyLimit: 500, historySizeMB: 3 });
  assert.deepEqual(fitLimits(big, 2, 1), { fits: 1, historyLimit: 3, historySizeMB: 3 });
});
