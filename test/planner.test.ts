import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, authoringOrder, countChanges, normalizeEol, planHunks, type Hunk } from '../src/planner';

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

/** Plans and counts a big change, asserting both are fast and the plan round trips. The budget leaves room for slow CI runners; the unbounded diff took tens of seconds. */
function assertFastRoundTrip(before: string, after: string) {
  const plan = timed(() => planHunks(before, after));
  const count = timed(() => countChanges(before, after));
  assert.equal(applyHunks(before, plan.value), after);
  assert.ok(plan.ms < 2000, `planHunks took ${Math.round(plan.ms)} ms`);
  assert.ok(count.ms < 2000, `countChanges took ${Math.round(count.ms)} ms`);
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
    naturalRoundTrip(before, after);
  }
});

// ------------------------------------------------------------ authoring order

/** Plans in authoring order, asserting the round trip and that the caret never leaves the text its edit typed. */
function naturalRoundTrip(before: string, after: string): Hunk[] {
  const plain = planHunks(before, after);
  const hunks = authoringOrder(plain, after);
  assert.equal(applyHunks(before, hunks), after);
  assert.equal(hunks.filter((h) => !h.continues).length, plain.length, 'each planned hunk starts one run of pieces');
  // Who typed each character: -1 for text that was already there, else the index of the run.
  let owner: number[] = Array.from(before, () => -1);
  let doc = before;
  let run = -1;
  let caret = 0;
  for (const h of hunks) {
    if (h.continues) {
      assert.equal(h.deleteText, '', 'a continuing piece deletes nothing');
      const [from, to] = caret <= h.offset ? [caret, h.offset] : [h.offset, caret];
      assert.ok(owner.slice(from, to).every((o) => o === run), `piece at ${h.offset} crossed text its edit did not type`);
      if (h.offset < caret) assert.ok(doc.slice(from, to).split('\n').length - 1 <= 2, 'moved back more than two lines');
    } else {
      run++;
    }
    doc = doc.slice(0, h.offset) + h.insertText + doc.slice(h.offset + h.deleteText.length);
    owner = [...owner.slice(0, h.offset), ...Array.from(h.insertText, () => run), ...owner.slice(h.offset + h.deleteText.length)];
    caret = h.offset + h.insertText.length;
  }
  return hunks;
}

/** The inserted text of each piece, in typing order. */
function typedOrder(before: string, after: string): string[] {
  return naturalRoundTrip(before, after).map((h) => h.insertText);
}

test('authoring order: a new function gets its closing brace before its body', () => {
  assert.deepEqual(typedOrder('', 'function f() {\n  return 1;\n}\n'), ['function f() {\n}\n', '\n  return 1;']);
});

test('authoring order: the closing line is typed whole, with what follows the bracket', () => {
  assert.deepEqual(typedOrder('', 'const o = {\n  a: 1,\n};\nnext();\n'), ['const o = {\n};\n', '\n  a: 1,', 'next();\n']);
});

test('authoring order: an empty block, or one with only blank lines inside, is typed top to bottom', () => {
  assert.deepEqual(typedOrder('', 'f() {\n}\n'), ['f() {\n}\n']);
  assert.deepEqual(typedOrder('', 'f() {\n\n  \n}\n'), ['f() {\n\n  \n}\n']);
});

test('authoring order: spaces after the opening bracket still end its line', () => {
  const after = 'if (a) {  \n  x();\n} else { \n  y();\n}\n';
  assert.deepEqual(typedOrder('', after), ['if (a) {\n}', '  \n  x();', ' else {\n}\n', ' \n  y();']);
});

test('authoring order: a closer that does not match, or a line at the same indentation first, opens no block', () => {
  assert.deepEqual(typedOrder('', 'x = (\n  1,\n]\n'), ['x = (\n  1,\n]\n']);
  const sw = 'switch (x) {\ncase 1:\n  y();\n}\n';
  assert.deepEqual(typedOrder('', sw), [sw]);
});

test('authoring order: lines added inside an existing block are typed top to bottom', () => {
  const before = 'function f() {\n  a();\n}\n';
  const after = 'function f() {\n  a();\n  b();\n  c();\n}\n';
  assert.deepEqual(typedOrder(before, after), ['  b();\n  c();\n']);
});

test('authoring order: nested blocks are each typed outside in when reached', () => {
  const after = 'function f() {\n  if (x) {\n    y();\n  }\n  z();\n}\n';
  assert.deepEqual(typedOrder('', after), ['function f() {\n}\n', '\n  if (x) {\n  }\n', '\n    y();', '  z();']);
});

test('authoring order: the first of two blocks is finished before the second starts', () => {
  const after = 'a() {\n  x;\n}\n\nb() {\n  y;\n}\n';
  assert.deepEqual(typedOrder('', after), ['a() {\n}\n', '\n  x;', '\nb() {\n}\n', '\n  y;']);
});

test('authoring order: an else branch opens its own block on the closing line', () => {
  const after = 'if (a) {\n  x();\n} else {\n  y();\n}\n';
  assert.deepEqual(typedOrder('', after), ['if (a) {\n}', '\n  x();', ' else {\n}\n', '\n  y();']);
});

test('authoring order: parameters on several lines come before the body', () => {
  const after = 'function f(\n  a,\n  b,\n) {\n  return a + b;\n}\n';
  assert.deepEqual(typedOrder('', after), ['function f(\n)', '\n  a,\n  b,', ' {\n}\n', '\n  return a + b;']);
});

test('authoring order: Python and one-line calls are typed top to bottom, left to right', () => {
  const py = 'def f(a, b):\n    return a + b\n';
  assert.deepEqual(typedOrder('', py), [py]);
  assert.deepEqual(typedOrder('x\n', 'x\nprint(total)\n'), ['print(total)\n']);
});

test('authoring order: a replaced block deletes first, then types outside in', () => {
  const hunks = naturalRoundTrip('a();\n', 'if (c) {\n  a();\n}\n');
  assert.deepEqual(hunks.map((h) => [h.deleteText, h.insertText]), [['a();\n', 'if (c) {\n}\n'], ['', '\n  a();']]);
});

test('authoring order: an edit that starts mid-line takes its indentation from the line', () => {
  const after = '  x = foo({\n    a: 1,\n  });\n';
  const hunk: Hunk = { offset: 6, deleteText: '', insertText: 'foo({\n    a: 1,\n  });\n' };
  const hunks = authoringOrder([hunk], after);
  assert.deepEqual(hunks.map((h) => h.insertText), ['foo({\n  });\n', '\n    a: 1,']);
  assert.equal(applyHunks('  x = ', hunks), after);
  // Without that indentation the closing line is deeper than the opening one, so no block.
  const flat = 'x = foo({\n    a: 1,\n  });\n';
  assert.equal(authoringOrder([{ ...hunk, offset: 4 }], flat).length, 1);
});

test('authoring order: edits stay in document order, and other hunks pass through unchanged', () => {
  const before = 'top\nmiddle\nbottom\n';
  const after = 'top\nf() {\n  x;\n}\nmiddle\nBOTTOM\n';
  const plain = planHunks(before, after);
  const hunks = naturalRoundTrip(before, after);
  assert.deepEqual(hunks[hunks.length - 1], plain[plain.length - 1]);
  assert.ok(hunks.slice(0, -1).every((h) => h.offset < plain[plain.length - 1].offset));
});

test('authoring order: a large new file is cut quickly', () => {
  const fn = (i: number) => `function f${i}(a, b) {\n  if (a) {\n    return [\n      a,\n      b,\n    ];\n  }\n  return {\n    a,\n  };\n}\n\n`;
  const after = Array.from({ length: 3000 }, (_, i) => fn(i)).join('');
  const t0 = performance.now();
  const hunks = authoringOrder(planHunks('', after), after);
  assert.ok(performance.now() - t0 < 2000, 'took too long');
  assert.equal(applyHunks('', hunks), after);
  // Six pieces a function, and the blank line at the end.
  assert.equal(hunks.length, 3000 * 6 + 1);
});

// Random code shaped like an agent writes it: indented blocks of every bracket kind, with odd cases mixed in.
function randomCode(r: () => number, indent: string, depth: number): string {
  let s = '';
  const lines = 1 + Math.floor(r() * 5);
  for (let i = 0; i < lines; i++) {
    const pick = r();
    if (depth < 4 && pick < 0.35) {
      const [open, close] = (['{}', '[]', '()'] as const)[Math.floor(r() * 3)];
      const tail = ['', ';', ',', ')', ' else {'][Math.floor(r() * 5)];
      const trailing = r() < 0.15 ? ' \t' : '';
      s += `${indent}head${depth} ${open}${trailing}\n` + (r() < 0.9 ? randomCode(r, indent + '  ', depth + 1) : r() < 0.5 ? '\n' : '');
      if (r() < 0.08) s += `${indent}oops\n`;
      s += `${indent}${r() < 0.95 ? close : '}'}${tail}\n`;
      if (tail === ' else {') s += randomCode(r, indent + '  ', depth + 1) + `${indent}}\n`;
    } else if (pick < 0.45) {
      s += '\n';
    } else {
      s += `${indent}${tokens[Math.floor(r() * tokens.length)].trim() || 'x'}${Math.floor(r() * 9)}\n`;
    }
  }
  return s;
}

/** Inserts, deletes and replaces whole lines, sometimes with new blocks. */
function mutateLines(r: () => number, text: string): string {
  const lines = text.split(/(?<=\n)/);
  const ops = 1 + Math.floor(r() * 4);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(r() * (lines.length + 1));
    const choice = r();
    const indent = '  '.repeat(Math.floor(r() * 3));
    if (choice < 0.5) lines.splice(at, 0, randomCode(r, indent, 0));
    else if (choice < 0.75) lines.splice(at, 1 + Math.floor(r() * 4));
    else lines.splice(at, 1, randomCode(r, indent, 1));
  }
  return lines.join('');
}

test('fuzz: 3000 block-shaped edits round trip in authoring order', () => {
  const r = rng(7);
  let reordered = 0;
  for (let i = 0; i < 3000; i++) {
    const before = r() < 0.2 ? '' : randomCode(r, '', 0);
    const after = r() < 0.7 ? mutateLines(r, before) : mutate(r, mutateLines(r, before));
    const hunks = naturalRoundTrip(before, after);
    if (hunks.some((h, k) => k > 0 && h.continues && h.offset < hunks[k - 1].offset + hunks[k - 1].insertText.length)) reordered++;
  }
  assert.ok(reordered > 1000, `only ${reordered} plans were reordered`);
});
