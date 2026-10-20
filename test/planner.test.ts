import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, normalizeEol, planHunks } from '../src/planner';

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
