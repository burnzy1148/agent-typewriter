import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { baselines, clearedAt, diffMarks, highlightPair, lineMarks, netHunks, removedPreview, renderAction, renderWait, type HighlightState, type Marks } from '../src/highlights';
import { applyHunks } from '../src/planner';
import { Timeline, type ChangeEvent, type ChangeKind } from '../src/timeline';

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

test('unchanged characters between changed words are not marked', () => {
  // The planner retypes "foo(bar" as one edit; the "(" stays unmarked.
  const { lines } = marksOf('let x = foo(bar);\n', 'let x = baz(qux);\n');
  assert.deepEqual(lines.chars, [{ line: 0, start: 8, end: 11 }, { line: 0, start: 12, end: 15 }]);
  assert.deepEqual(lines.removals, [{ line: 0, texts: ['foo', 'bar'] }]);
});

test('a line break added at the end draws nothing', () => {
  const { lines } = marksOf('ab', 'ab\n');
  assert.deepEqual(lines, { lines: [], chars: [], removals: [] });
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

test('a large net diff in two places marks only those places', () => {
  // About 1400 changed lines in two blocks: past the planner's own edit limit.
  for (const n of [2000, 4000]) {
    const before = Array.from({ length: n }, (_, i) => `const v${i} = ${i};\n`).join('');
    const after = before.split('\n').map((l, i) => (i < 700 || (i >= n - 700 && i < n) ? l.replace('const', 'let') : l)).join('\n');
    const { lines: m } = marksOf(before, after);
    assert.equal(m.lines.length, 1400, `${n} lines`);
    assert.ok(m.lines.every((l) => l < 700 || l >= n - 700));
  }
});

test('removed lines on one line count only removed lines as more', () => {
  const block = (tag: string) => Array.from({ length: 15 }, (_, i) => `${tag}${i}`).join('\n') + '\n';
  const p = removedPreview([block('a'), block('b')]);
  // 20 rows shown: 15 lines of a, the separator, 4 lines of b; 11 of b are left.
  assert.equal(p.more, 11);
  assert.equal(p.code.split('\n')[15], '\u2026');
  assert.equal(removedPreview([block('a'), block('b')], 40).more, 0);
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

const state = (over: Partial<HighlightState> = {}): HighlightState => ({
  bases: new Map([['a', 'base a\n'], ['b', 'base b\n'], ['c', 'base a\n']]),
  texts: new Map([['a', { text: 'now a\n' }], ['b', { text: 'now b\n' }]]),
  clears: [],
  ...over,
});

test('a file being typed shows nothing once a clear was made during that change, live text or not', () => {
  const st = state({ playing: { seq: 7, relPath: 'a' }, clears: [{ seq: 8 }] });
  assert.equal(highlightPair(st, 'a'), undefined);
  assert.equal(highlightPair(st, 'a', 'half typed\n'), undefined);
  // Other files compare as usual.
  assert.deepEqual(highlightPair(st, 'b'), { baseline: 'base b\n', text: 'now b\n', live: false });
  // A clear from before this change does not hide it.
  assert.deepEqual(highlightPair(state({ playing: { seq: 7, relPath: 'a' }, clears: [{ seq: 7 }] }), 'a', 'typed\n'), { baseline: 'base a\n', text: 'typed\n', live: true });
});

test('during a rename move the old mirror uses the earlier baseline, and a clear kept under the new path hides it', () => {
  const moving = state({
    bases: new Map([['c', 'base a\n']]),
    basesBefore: new Map([['a', 'base a\n']]),
    movingFrom: 'a',
    playing: { seq: 7, relPath: 'c', fromRelPath: 'a' },
  });
  assert.deepEqual(highlightPair(moving, 'a', 'before rename\n'), { baseline: 'base a\n', text: 'before rename\n', live: true });
  assert.equal(highlightPair({ ...moving, clears: [{ seq: 8, relPath: 'c' }] }, 'a', 'before rename\n'), undefined);
});

test('renderAction draws on matching text and keeps marks only within the same live change', () => {
  const live = { baseline: 'b', text: 'x', live: true };
  assert.equal(renderAction(undefined, 'x', 1, 1), 'clear');
  assert.equal(renderAction(live, 'x', undefined, 1), 'draw');
  // The document is a step ahead of the player within the same change: keep.
  assert.equal(renderAction(live, 'xy', 1, 1), 'keep');
  // Marks from before a seek: a different change is live now.
  assert.equal(renderAction(live, 'xy', 1, 2), 'clear');
  assert.equal(renderAction(live, 'xy', undefined, 1), 'clear');
  assert.equal(renderAction({ ...live, live: false }, 'xy', 1, 1), 'clear');
});

test('the title bar clear button is scoped to the highlighted playback mirror', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const entry = pkg.contributes.menus['editor/title'].find((m: { command: string }) => m.command === 'agentTypewriter.clearHighlightsInFile');
  assert.ok(entry, 'no title bar entry');
  for (const part of ['resourceScheme == agent-typewriter', 'resourcePath in agentTypewriter.playbackMirror', 'resourcePath in agentTypewriter.highlightedMirrors']) {
    assert.ok(entry.when.includes(part), `when clause lacks ${part}`);
  }
});

test('after a reload, a clear made while the next change was typed holds for every other file', () => {
  // a@1, a@2, b@3: 1 and 2 played, 3 being typed when highlights were cleared, then a reload.
  const t = new Timeline(100);
  const push = (relPath: string, before: string, after: string) =>
    t.push({ uri: 'file:///w/' + relPath, relPath, time: 0, kind: 'modify', before, after, eol: '\n', linesAdded: 0, linesRemoved: 0 });
  push('a', '0', '1');
  push('a', '1', '2');
  const b = push('b', 'b0', 'b1');
  t.seek(b.seq);
  t.begin(b.seq);
  t.clearHighlights();
  const r = new Timeline(100);
  r.restore(t.all(), t.cursor, t.highlightClears);
  const next = r.peek()!;
  const bases = baselines(r.all(), r.cursor, r.highlightClears, { seq: next.seq, paths: [next.relPath] });
  // a.ts shows nothing, as before the reload; b.ts keeps its baseline until its change plays.
  assert.equal(bases.get('a'), '2');
  assert.equal(r.mirrorStates().get('a')?.text, '2');
  const st: HighlightState = { bases, texts: r.mirrorStates(), clears: r.highlightClears, next: { seq: next.seq, relPath: 'b' } };
  // b.ts showed nothing while typed with the clear made; it shows nothing until it plays again.
  assert.equal(highlightPair(st, 'b'), undefined);
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
  // One very slow run holds the next back at most two seconds.
  assert.equal(renderWait(1000, 1000, 5000), 2000);
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
    assert.equal(applyHunks(baseline, netHunks(baseline, current)), current);
    const lines = lineMarks(current, marks);
    const lineCount = current.split('\n').length;
    for (const l of [...lines.lines, ...lines.removals.map((x) => x.line)]) assert.ok(l >= 0 && l < lineCount);
    for (const c of lines.chars) assert.ok(lines.lines.includes(c.line) && c.start < c.end);
  }
});

test('fuzz: anchored hunks rebuild line-heavy texts with repeated lines', () => {
  const r = rng(11);
  const pool = ['}\n', '{\n', 'return x;\n', '\n', ...Array.from({ length: 40 }, (_, i) => `line ${i};\n`)];
  for (let i = 0; i < 1500; i++) {
    const baseline = Array.from({ length: Math.floor(r() * 60) }, () => pool[Math.floor(r() * pool.length)]).join('');
    const lines = baseline.split(/(?<=\n)/);
    for (let k = Math.floor(r() * 8); k > 0; k--) {
      const at = Math.floor(r() * (lines.length + 1));
      if (r() < 0.5) lines.splice(at, 1);
      else lines.splice(at, 0, pool[Math.floor(r() * pool.length)]);
    }
    const current = lines.join('') + (r() < 0.2 ? 'tail' : '');
    assert.equal(applyHunks(baseline, netHunks(baseline, current)), current);
    assert.equal(rebuild(current, diffMarks(baseline, current)), baseline);
  }
});
