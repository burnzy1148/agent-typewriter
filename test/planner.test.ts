import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, countChanges, normalizeEol, planHunks } from '../src/planner';

function roundTrip(before: string, after: string) {
  const hunks = planHunks(before, after);
  assert.equal(applyHunks(before, hunks), after);
  return hunks;
}

test('identical text yields no hunks', () => {
  assert.deepEqual(planHunks('abc\n', 'abc\n'), []);
});

test('new file is typed in one hunk from the top', () => {
  const hunks = roundTrip('', 'class A {\n}\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].offset, 0);
});

test('renaming one identifier only retypes that token', () => {
  const before = 'const total = price * qty;\nreturn total;\n';
  const after = 'const subtotal = price * qty;\nreturn total;\n';
  const hunks = roundTrip(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].deleteText, 'total');
  assert.equal(hunks[0].insertText, 'subtotal');
});

test('appended lines are one insert at the right place', () => {
  const before = 'a\nb\n';
  const after = 'a\nb\nc\nd\n';
  const hunks = roundTrip(before, after);
  assert.deepEqual(hunks, [{ offset: 4, deleteText: '', insertText: 'c\nd\n' }]);
});

test('edits in several places are ordered top to bottom with live offsets', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\n';
  const after = 'ONE\ntwo\nthree and more\nfour\nfive\nsix\n';
  const hunks = roundTrip(before, after);
  for (let i = 1; i < hunks.length; i++) assert.ok(hunks[i].offset >= hunks[i - 1].offset);
});

test('tiny unchanged gaps are folded into one edit', () => {
  const hunks = roundTrip('call(a, b);\n', 'call(x, y);\n');
  assert.equal(hunks.length, 1);
});

test('unrelated rewrite deletes and retypes the block', () => {
  const hunks = roundTrip('alpha beta gamma\n', 'zzz qqq www rrr\n');
  assert.equal(hunks.length, 1);
});

test('missing trailing newline edge cases', () => {
  roundTrip('a\nb', 'a\nb\nc');
  roundTrip('a\nb\n', 'a\nb');
  roundTrip('x', '');
  roundTrip('', 'x');
});

test('CRLF normalizes to LF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
});

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

/** Plans and counts a big change, asserting both are fast and the plan round trips. */
function assertFastRoundTrip(before: string, after: string) {
  const plan = timed(() => planHunks(before, after));
  const count = timed(() => countChanges(before, after));
  assert.equal(applyHunks(before, plan.value), after);
  assert.ok(plan.ms < 500, `planHunks took ${Math.round(plan.ms)} ms`);
  assert.ok(count.ms < 500, `countChanges took ${Math.round(count.ms)} ms`);
  return { hunks: plan.value, counts: count.value };
}

function uniqueLines(prefix: string, bytes: number) {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `${prefix} line ${i} ${(i * 2654435761) % 1000003}\n`;
    lines.push(line);
    size += line.length;
  }
  return lines.join('');
}

test('large rewrite: a 500 KB file of all new lines is planned quickly', () => {
  const before = uniqueLines('old', 500_000);
  const after = uniqueLines('new', 500_000);
  const { hunks, counts } = assertFastRoundTrip(before, after);
  assert.equal(hunks.length, 1);
  assert.ok(hunks[0].insertText.length > 6000, 'retyped instead of applied at once');
  assert.ok(counts.added > 0 && counts.removed > 0);
});

test('large reindent: a 250 KB JSON file from 2 to 4 spaces is planned quickly', () => {
  const data = Array.from({ length: 2500 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b'], ok: i % 2 === 0 }));
  const before = JSON.stringify(data, null, 2) + '\n';
  const after = JSON.stringify(data, null, 4) + '\n';
  assert.ok(before.length > 200_000, `before is only ${before.length} chars`);
  const { counts } = assertFastRoundTrip(before, after);
  assert.ok(counts.added >= 0 && counts.removed >= 0);
});

test('large rewrite fallback: one hunk between the shared leading and trailing lines', () => {
  const head = 'header one\nheader two\n';
  const tail = 'footer one\nfooter two\n';
  // Shared characters run into the changed region on both sides: "line " and " x\n".
  const before = head + 'line ' + uniqueLines('old', 200_000) + 'old x\n' + tail;
  const after = head + 'line ' + uniqueLines('new', 200_000) + 'new x\n' + tail;
  const { hunks, counts } = assertFastRoundTrip(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].offset, head.length);
  assert.ok(hunks[0].deleteText.startsWith('line old line 0 '));
  assert.ok(hunks[0].deleteText.endsWith('\nold x\n'));
  assert.ok(hunks[0].insertText.startsWith('line new line 0 '));
  assert.ok(after.endsWith(tail) && !hunks[0].insertText.includes('footer'));
  const lines = (s: string) => s.split('\n').length - 1;
  assert.deepEqual(counts, { added: lines(hunks[0].insertText), removed: lines(hunks[0].deleteText) });
});

test('large rewrite fallback: no shared lines, or a change at the very end', () => {
  for (const [before, after] of [
    [uniqueLines('old', 100_000), uniqueLines('new', 100_000) + 'no newline'],
    ['top\n' + uniqueLines('old', 100_000), 'top\n' + uniqueLines('new', 50_000)],
    [uniqueLines('old', 100_000) + 'end\n', 'x' + uniqueLines('new', 100_000) + 'end\n'],
    ['\n' + uniqueLines('old', 100_000), 'x' + uniqueLines('new', 100_000)],
  ]) {
    const { counts } = assertFastRoundTrip(before, after);
    assert.ok(counts.added >= 0 && counts.removed >= 0);
  }
});

test('word refinement gives up on a block with too many word edits, and still round trips', () => {
  // Every other word changes: similar enough to refine, but 1200 word edits.
  const words = (changed: string) => Array.from({ length: 1200 }, (_, i) => `${i % 2 ? 'w' : changed}${i}`).join(' ');
  const before = 'keep\n' + words('a') + '\nkeep\n';
  const after = 'keep\n' + words('b') + '\nkeep\n';
  assert.ok(before.length < 8000);
  const hunks = roundTrip(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].deleteText, words('a') + '\n');
});

test('a rename across a third of a 2000-line file is still retyped word by word', () => {
  const lines = (name: string) => Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? `use(${name}, ${i});\n` : `other(${i});\n`)).join('');
  const before = lines('total');
  const after = lines('sum');
  const { hunks } = assertFastRoundTrip(before, after);
  assert.equal(hunks.length, 667);
  assert.ok(hunks.every((h) => h.deleteText === 'total' && h.insertText === 'sum'));
});

// Deterministic fuzz: random code-like edits must always round trip exactly.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const tokens = ['foo', 'bar', 'baz', '(', ')', '{', '}', ';', ' ', '  ', '\n', '\n    ', '=', 'return', 'x', '1', '"s"', '\t', '//c'];

function randomText(r: () => number, n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += tokens[Math.floor(r() * tokens.length)];
  return s;
}

function mutate(r: () => number, text: string) {
  let s = text;
  const ops = 1 + Math.floor(r() * 6);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(r() * (s.length + 1));
    const len = Math.floor(r() * 12);
    const choice = r();
    if (choice < 0.33) s = s.slice(0, at) + randomText(r, 1 + Math.floor(r() * 5)) + s.slice(at);
    else if (choice < 0.66) s = s.slice(0, at) + s.slice(at + len);
    else s = s.slice(0, at) + randomText(r, 1 + Math.floor(r() * 4)) + s.slice(at + len);
  }
  return s;
}

test('fuzz: 3000 random edits round trip', () => {
  const r = rng(42);
  for (let i = 0; i < 3000; i++) {
    const before = randomText(r, Math.floor(r() * 80));
    const after = mutate(r, before);
    roundTrip(before, after);
  }
});
