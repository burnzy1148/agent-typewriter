import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache, TextHolder, TextPasses, onTextReadError, readCache, rebind, textChars, textHolder, withText } from '../src/changeText';

test('getters read through the holder and look like plain text', () => {
  const holder = new TextHolder('one\n', 'two\n');
  const e = withText({ relPath: 'a.ts', seq: 1 }, holder);
  assert.equal(e.before, 'one\n');
  assert.equal(e.after, 'two\n');
  assert.deepEqual(e, { relPath: 'a.ts', seq: 1, before: 'one\n', after: 'two\n' });
  assert.deepEqual({ ...e }, { relPath: 'a.ts', seq: 1, before: 'one\n', after: 'two\n' });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), { relPath: 'a.ts', seq: 1, before: 'one\n', after: 'two\n' });
  assert.equal(textHolder(e), holder);
  assert.equal(textChars(e), 8);
  assert.equal(textChars({ before: 'abc', after: '' }), 3);
});

test('rebind shares the text without reading it', () => {
  let reads = 0;
  const holder = new TextHolder(6, () => (reads++, { before: 'abc', after: 'def' }), 'store');
  const e = withText({ relPath: 'a.ts', seq: 1 }, holder);
  const moved = rebind(e, { seq: 9 });
  assert.equal(reads, 0);
  assert.equal(moved.seq, 9);
  assert.equal(textHolder(moved), holder);
  assert.equal(moved.after, 'def');
  assert.equal(reads, 1);
});

test('offloaded text is read once and kept in the cache', () => {
  readCache.clear();
  let reads = 0;
  const holder = new TextHolder('before', 'after');
  assert.ok(holder.inMemory);
  holder.offload(() => (reads++, { before: 'before', after: 'after' }), 'store');
  assert.ok(!holder.inMemory);
  assert.equal(holder.owner, 'store');
  // Still cached from when it was in memory.
  assert.equal(holder.read().before, 'before');
  assert.equal(reads, 0);
  readCache.clear();
  const first = holder.read();
  assert.equal(holder.read(), first);
  assert.equal(reads, 1);
  holder.pin();
  readCache.clear();
  assert.equal(holder.read().after, 'after');
  assert.ok(holder.inMemory);
  assert.equal(holder.owner, undefined);
  assert.equal(reads, 1);
});

test('the cache drops the least recently read text beyond its size, never the one just read', () => {
  const cache = new ReadCache(10);
  const h = (n: number) => new TextHolder('x'.repeat(n), '');
  const a = h(4);
  const b = h(4);
  const c = h(4);
  cache.put(a, a.read());
  cache.put(b, b.read());
  cache.get(a);
  cache.put(c, c.read());
  assert.ok(cache.get(a));
  assert.equal(cache.get(b), undefined);
  assert.ok(cache.get(c));
  assert.equal(cache.chars, 8);
  const big = h(50);
  cache.put(big, big.read());
  assert.ok(cache.get(big));
  assert.equal(cache.chars, 50);
});

test('saved changes that cannot be read give empty text, and only the first is reported', () => {
  const reports: string[] = [];
  onTextReadError((m) => reports.push(m));
  try {
    const holder = new TextHolder(3, () => {
      throw new Error('gone');
    }, 'store');
    assert.deepEqual(holder.read(), { before: '', after: '' });
    assert.deepEqual(holder.read(), { before: '', after: '' });
    const other = new TextHolder(3, () => {
      throw new Error('gone too');
    }, 'store');
    assert.deepEqual(other.read(), { before: '', after: '' });
    assert.equal(reports.length, 1);
    assert.match(reports[0], /gone/);
  } finally {
    onTextReadError(() => {});
  }
});

test('each pass reuses the text the pass before it read, and keeps nothing older', () => {
  let reads = 0;
  const make = (before: string, after: string) => {
    const holder = new TextHolder(before.length + after.length, () => (reads++, { before, after }), 'store');
    return withText({ relPath: before }, holder);
  };
  const a = make('a0', 'a1');
  const b = make('b0', 'b1');
  const passes = new TextPasses();
  readCache.clear();
  const first = passes.run((read) => [read(a, 'before'), read(a, 'after'), read(b, 'after')]);
  assert.deepEqual(first, ['a0', 'a1', 'b1']);
  assert.equal(reads, 2);
  // The read cache has dropped everything; the pass still has what the last one read.
  readCache.clear();
  passes.run((read) => {
    assert.equal(read(a, 'after'), 'a1');
    assert.equal(read(b, 'after'), 'b1');
  });
  assert.equal(reads, 2);
  // a.before was not read by the last pass, so it is read again.
  readCache.clear();
  passes.run((read) => read(a, 'before'));
  assert.equal(reads, 3);
});
