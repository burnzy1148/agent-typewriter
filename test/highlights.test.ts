import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselines, clearedAt, diffMarks, lineMarks, removedPreview, renderWait, type Marks } from '../src/highlights';
import type { ChangeEvent, ChangeKind } from '../src/timeline';

/** The baseline text `marks` say `current` came from. */
function rebuild(current: string, marks: Marks): string {
  let out = '';
  let pos = 0;
  let ai = 0;
  let ri = 0;
  for (;;) {
    const a = marks.added[ai]?.start ?? Infinity;
    const r = marks.removed[ri]?.offset ?? Infinity;
    if (a === Infinity && r === Infinity) return out + current.slice(pos);
    // A removal comes before text added at the same offset.
    if (r <= a) {
      out += current.slice(pos, r) + marks.removed[ri++].text;
      pos = r;
    } else {
      out += current.slice(pos, a);
      pos = marks.added[ai++].end;
    }
  }
}

function marksOf(baseline: string, current: string) {
  const marks = diffMarks(baseline, current);
  assert.equal(rebuild(current, marks), baseline);
  return { marks, lines: lineMarks(current, marks) };
}

test('a word changed on a line marks the line and only the new characters', () => {
  const { lines } = marksOf('a\nlet foo = 1;\nb\n', 'a\nlet bar = 1;\nb\n');
  assert.deepEqual(lines.lines, [1]);
  assert.deepEqual(lines.chars, [{ line: 1, start: 4, end: 7 }]);
  assert.deepEqual(lines.removals, [{ line: 1, texts: ['foo'] }]);
});

test('new lines are marked whole, with no character tint', () => {
  const { lines } = marksOf('a\nd\n', 'a\nb\n\nc\nd\n');
  assert.deepEqual(lines.lines, [1, 2, 3]);
  assert.deepEqual(lines.chars, []);
  assert.deepEqual(lines.removals, []);
});

test('a created file is added on every line', () => {
  const { lines } = marksOf('', 'one\ntwo\nthree');
  assert.deepEqual(lines.lines, [0, 1, 2]);
  assert.deepEqual(lines.chars, []);
});

test('a deleted file is one removal on line 1', () => {
  const { lines } = marksOf('one\ntwo\n', '');
  assert.deepEqual(lines.lines, []);
  assert.deepEqual(lines.removals, [{ line: 0, texts: ['one\ntwo\n'] }]);
});

test('removed lines are marked on the line that now follows them', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  const after = before.split('\n').filter((_, i) => i < 19 || i > 23).join('\n');
  const { lines } = marksOf(before, after);
  assert.deepEqual(lines.removals.map((r) => r.line), [19]);
  assert.equal(lines.removals[0].texts.join(''), 'line 19\nline 20\nline 21\nline 22\nline 23\n');
});

test('a removal at the end of the text is marked on the last line', () => {
  const { lines } = marksOf('a\nb\nc\n', 'a\n');
  assert.deepEqual(lines.removals, [{ line: 1, texts: ['b\nc\n'] }]);
});

test('identical text has no marks', () => {
  assert.deepEqual(diffMarks('same\n', 'same\n'), { added: [], removed: [] });
});

test('a large rewrite past the diff limits still marks only the changed region', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `keep ${i}\n`);
  const before = lines.join('');
  const changed = lines.map((l, i) => (i >= 1000 && i < 3000 ? `new ${i} ${'x'.repeat(i % 7)}\n` : l));
  const { lines: m } = marksOf(before, changed.join(''));
  assert.ok(m.lines.length > 0);
  assert.ok(m.lines.every((l) => l >= 1000 && l < 3000));
});

test('removal hover text is capped by lines and by line length', () => {
  const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n') + '\n';
  const p = removedPreview([text]);
  assert.equal(p.code.split('\n').length, 20);
  assert.equal(p.more, 30);
  const long = removedPreview(['x'.repeat(600)]);
  assert.equal(long.code, 'x'.repeat(500) + '…');
  assert.equal(removedPreview(['a\n', 'b']).code, 'a\n…\nb');
});

// ------------------------------------------------------------------ baselines

let seq = 0;
function ev(relPath: string, before: string, after: string, kind: ChangeKind = 'modify', fromRelPath?: string): ChangeEvent {
  return {
    seq: ++seq,
    uri: 'file:///w/' + relPath,
    relPath,
    ...(fromRelPath !== undefined && { fromUri: 'file:///w/' + fromRelPath, fromRelPath }),
    time: 0,
    kind,
    before,
    after,
    eol: '\n',
    linesAdded: 0,
    linesRemoved: 0,
  };
}
const none: never[] = [];

test('the baseline is the before text of the earliest played change', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'b0', 'b1'), ev('a', 'a1', 'a2')];
  const end = events[2].seq + 1;
  assert.deepEqual(baselines(events, end, none), new Map([['a', 'a0'], ['b', 'b0']]));
});

test('files whose changes are all unplayed have no baseline', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'b0', 'b1')];
  assert.deepEqual(baselines(events, events[1].seq, none), new Map([['a', 'a0']]));
});

test('a clear for all files makes the text at that point the baseline', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'b0', 'b1'), ev('a', 'a1', 'a2')];
  assert.deepEqual(baselines(events, events[2].seq + 1, [{ seq: events[2].seq }]), new Map([['a', 'a1'], ['b', 'b1']]));
});

test('a clear for one file leaves the others alone', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'b0', 'b1')];
  assert.deepEqual(baselines(events, events[1].seq + 1, [{ seq: events[1].seq + 1, relPath: 'a' }]), new Map([['a', 'a1'], ['b', 'b0']]));
});

test('the later of the global and the file clear wins', () => {
  const events = [ev('a', 'a0', 'a1'), ev('a', 'a1', 'a2'), ev('a', 'a2', 'a3')];
  const end = events[2].seq + 1;
  assert.equal(baselines(events, end, [{ seq: events[1].seq, relPath: 'a' }, { seq: events[2].seq }]).get('a'), 'a2');
  assert.equal(baselines(events, end, [{ seq: events[1].seq }, { seq: events[2].seq, relPath: 'a' }]).get('a'), 'a2');
});

test('a clear before a file was first changed keeps its first before text', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'b0', 'b1')];
  assert.deepEqual(baselines(events, events[1].seq + 1, [{ seq: events[1].seq }]), new Map([['a', 'a1'], ['b', 'b0']]));
});

test('clears past the walked changes do not apply', () => {
  const events = [ev('a', 'a0', 'a1'), ev('a', 'a1', 'a2')];
  assert.equal(baselines(events, events[1].seq, [{ seq: events[1].seq + 1 }]).get('a'), 'a0');
});

test('a rename carries the old path baseline to the new path', () => {
  const events = [ev('a', 'a0', 'a1'), ev('b', 'a1', 'a1 renamed', 'rename', 'a')];
  const result = baselines(events, events[1].seq + 1, none);
  assert.deepEqual(result, new Map([['b', 'a0']]));
});

test('a clear made during a rename and keyed to the new path takes effect after it', () => {
  const events = [ev('a', 'a0', 'a1'), ev('c', 'a1', 'a1 renamed', 'rename', 'a')];
  const ren = events[1].seq;
  assert.equal(baselines(events, ren + 1, [{ seq: ren + 1, relPath: 'c' }]).get('c'), 'a1 renamed');
  // The old mirror, before the move, still uses the baseline it had.
  assert.equal(baselines(events, ren, []).get('a'), 'a0');
});

test('clearedAt is the latest clear for that file or for all files', () => {
  const clears = [{ seq: 3, relPath: 'a' }, { seq: 5 }, { seq: 7, relPath: 'b' }];
  assert.equal(clearedAt(clears, 'a'), 5);
  assert.equal(clearedAt(clears, 'b'), 7);
  assert.equal(clearedAt([], 'a'), 0);
});

test('renderWait spaces runs by the interval, longer after an expensive run', () => {
  assert.equal(renderWait(1000, 0, 0), 0);
  assert.equal(renderWait(1050, 1000, 10), 50);
  // A 100 ms diff waits 400 ms from its end, so it takes at most a fifth of the time.
  assert.equal(renderWait(1050, 1000, 100), 350);
  assert.equal(renderWait(2000, 1000, 100), 0);
});

test('a deleted then re-created file keeps its original baseline', () => {
  const events = [ev('a', 'a0', '', 'delete'), ev('a', '', 'new', 'create')];
  assert.equal(baselines(events, events[1].seq + 1, none).get('a'), 'a0');
});

test('when the oldest change leaves the buffer the next one sets the baseline', () => {
  const events = [ev('a', 'a0', 'a1'), ev('a', 'a1', 'a2')];
  assert.equal(baselines(events.slice(1), events[1].seq + 1, none).get('a'), 'a1');
});

// ------------------------------------------------------------------ fuzz

function rng(s: number) {
  let x = s >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
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

test('fuzz: 3000 random edits give marks that rebuild the baseline', () => {
  const r = rng(7);
  for (let i = 0; i < 3000; i++) {
    const baseline = randomText(r, Math.floor(r() * 80));
    // Several edits in a row, as when a file changes many times after its baseline.
    let current = baseline;
    for (let n = 1 + Math.floor(r() * 3); n > 0; n--) current = mutate(r, current);
    const marks = diffMarks(baseline, current);
    for (const a of marks.added) assert.ok(a.start >= 0 && a.start < a.end && a.end <= current.length);
    for (let k = 1; k < marks.added.length; k++) assert.ok(marks.added[k].start >= marks.added[k - 1].end);
    for (let k = 1; k < marks.removed.length; k++) assert.ok(marks.removed[k].offset > marks.removed[k - 1].offset);
    for (const m of marks.removed) assert.ok(m.offset >= 0 && m.offset <= current.length && m.text.length > 0);
    assert.equal(rebuild(current, marks), baseline);
    const lines = lineMarks(current, marks);
    const lineCount = current.split('\n').length;
    for (const l of [...lines.lines, ...lines.removals.map((x) => x.line)]) assert.ok(l >= 0 && l < lineCount);
    for (const c of lines.chars) assert.ok(lines.lines.includes(c.line) && c.start < c.end);
  }
});
