import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEol } from '../claude-code/hooks/core.mjs';
import {
  MAX_WAITING,
  MAX_WAITING_CHARS,
  TICK_MS,
  enqueue,
  finish,
  frame,
  liveIds,
  newDeck,
  playOptions,
  queued,
  relativePath,
  restore,
  savedOf,
  showControls,
  skipToLatest,
  tick,
  togglePause,
  viewOf,
  type Change,
  type Deck,
  type PlayOptions,
} from '../claude-code/hooks/replay';

const FAST: PlayOptions = { charsPerMinute: 6000, naturalOrder: true };

function change(id: string, before: string, after: string, path = `/w/${id}.ts`): Change {
  return { id, path, before, after };
}

/** A new deck with `changes` recorded in order. */
function deckOf(...changes: Change[]): Deck {
  const d = newDeck();
  for (const c of changes) enqueue(d, c);
  return d;
}

/** Id of the change being typed. A function, so a check of `d.playing` earlier in a test does not narrow it. */
function playingId(d: Deck) {
  return d.playing?.change.id;
}

function isIdle(d: Deck) {
  return d.timeline.pendingCount() === 0 && !d.playing && d.hold === 0;
}

/** Ticks until nothing is left to play, returning the final deck, every shown text, and the ticks taken. */
function playOut(d: Deck, opts: PlayOptions = FAST, max = 1_000_000) {
  const frames: string[] = [];
  let ticks = 0;
  while (!isIdle(d) && ticks < max) {
    tick(d, opts);
    ticks++;
    if (d.playing) assert.equal(d.shown?.text, d.playing.text, 'the pane shows the text being typed');
    if (d.shown) frames.push(d.shown.text);
  }
  return { deck: d, frames, ticks };
}

test('a change plays from its before text to its after text in steps', () => {
  const before = 'function add(a, b) {\n  return a + b;\n}\n';
  const after = 'function add(a, b, c = 0) {\n  // sum\n  return a + b + c;\n}\n';
  const { deck, frames } = playOut(deckOf(change('add', before, after)), { charsPerMinute: 1000, naturalOrder: true });
  assert.equal(deck.shown?.text, after);
  assert.equal(deck.playing, undefined);
  assert.ok(new Set(frames).size > 5, 'typed in steps, not in one jump');
});

// Same generator as the planner's fuzz test: code-like random edits.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const tokens = ['foo', 'bar', '(', ')', '{', '}', ';', ' ', '  ', '\n', '\n    ', '=', 'return', 'x', '"s"', '\t', '//c', '😀'];
function randomText(r: () => number, n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += tokens[Math.floor(r() * tokens.length)];
  return s;
}
function mutate(r: () => number, text: string) {
  let s = text;
  for (let k = 1 + Math.floor(r() * 6); k > 0; k--) {
    const at = Math.floor(r() * (s.length + 1));
    const len = Math.floor(r() * 12);
    const choice = r();
    if (choice < 0.33) s = s.slice(0, at) + randomText(r, 1 + Math.floor(r() * 5)) + s.slice(at);
    else if (choice < 0.66) s = s.slice(0, at) + s.slice(at + len);
    else s = s.slice(0, at) + randomText(r, 1 + Math.floor(r() * 4)) + s.slice(at + len);
  }
  return s;
}

test('fuzz: every change finishes on its after text, at any speed and order', () => {
  const r = rng(7);
  for (let i = 0; i < 400; i++) {
    const before = randomText(r, Math.floor(r() * 60));
    const after = mutate(r, before);
    for (const opts of [
      { charsPerMinute: 1000, naturalOrder: true },
      { charsPerMinute: 9000, naturalOrder: false },
      { charsPerMinute: 137, naturalOrder: true },
    ]) {
      const { deck } = playOut(deckOf(change('f', before, after)), opts);
      if (before !== after) assert.equal(deck.shown?.text, after, JSON.stringify({ before, after, opts }));
    }
  }
});

test('changes play one at a time in recorded order', () => {
  const d = deckOf(change('a', '', 'aaa\n'), change('b', '', 'bbb\n'));
  const order: string[] = [];
  while (!isIdle(d)) {
    tick(d, FAST);
    const id = playingId(d);
    if (id && order[order.length - 1] !== id) order.push(id);
  }
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(d.shown?.path, '/w/b.ts');
});

test('typing speed follows charsPerMinute', () => {
  const after = 'x'.repeat(299) + '\n';
  const at = (cpm: number) => playOut(deckOf(change('s', '', after)), { charsPerMinute: cpm, naturalOrder: true }).ticks;
  // 300 characters: 18 s at 1000 per minute, 6 s at 3000.
  const ms1000 = at(1000) * TICK_MS;
  const ms3000 = at(3000) * TICK_MS;
  assert.ok(Math.abs(ms1000 - 18_000) <= 18_000 * 0.05, `1000 cpm took ${ms1000} ms`);
  assert.ok(Math.abs(ms3000 - 6_000) <= 6_000 * 0.05, `3000 cpm took ${ms3000} ms`);
});

test('options: an invalid speed is the default, natural order is on unless false', () => {
  for (const v of [0, -5, 'abc', undefined, Number.NaN, Infinity]) assert.equal(playOptions({ charsPerMinute: v }).charsPerMinute, 1000);
  assert.equal(playOptions({ charsPerMinute: 2500 }).charsPerMinute, 2500);
  assert.equal(playOptions({}).naturalOrder, true);
  assert.equal(playOptions({ naturalOrder: false }).naturalOrder, false);
});

test('pause stops progress and resume continues from where it stopped', () => {
  const d = deckOf(change('p', '', 'line one\nline two\nline three\n'));
  for (let i = 0; i < 6; i++) tick(d, FAST);
  const halfway = d.shown?.text;
  togglePause(d);
  assert.equal(tick(d, FAST), false, 'a paused tick changes nothing');
  assert.equal(d.shown?.text, halfway);
  togglePause(d);
  tick(d, FAST);
  assert.ok(d.shown!.text.startsWith(halfway!) && d.shown!.text.length > halfway!.length);
  assert.equal(playOut(d).deck.shown?.text, 'line one\nline two\nline three\n');
});

test('finish shows the current change done and the next one starts', () => {
  const d = deckOf(change('a', '', 'alpha\n'), change('b', '', 'beta\n'), change('c', '', 'gamma\n'));
  tick(d, FAST);
  tick(d, FAST);
  finish(d);
  assert.equal(d.shown?.text, 'alpha\n');
  assert.equal(d.playing, undefined);
  tick(d, FAST);
  assert.equal(playingId(d), 'b');
});

test('skip to latest leaves nothing queued and shows the last change', () => {
  const d = deckOf(...['a', 'b', 'c', 'd'].map((id) => change(id, '', `${id}\n`)));
  tick(d, FAST);
  skipToLatest(d, FAST);
  assert.equal(queued(d).length, 0);
  assert.equal(d.playing, undefined);
  assert.equal(d.shown?.text, 'd\n');
  assert.equal(tick(d, FAST), false, 'nothing left to play');
});

test('at most MAX_WAITING changes wait; the oldest is dropped', () => {
  const d = newDeck();
  for (let i = 0; i <= MAX_WAITING; i++) enqueue(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(queued(d).length, MAX_WAITING);
  assert.equal(queued(d)[0]?.id, 'c1');
  assert.equal(d.recorded, MAX_WAITING + 1);
});

test('an unchanged file records nothing', () => {
  const d = newDeck();
  assert.equal(enqueue(d, change('u', 'same\n', 'same\n')), false);
  assert.equal(d.timeline.all().length, 0);
  assert.equal(d.recorded, 0);
});

test('a too-large change is named, held briefly, and skipped', () => {
  const d = deckOf({ id: 'big', path: '/w/big.json', before: '', after: '', isTooLarge: true }, change('next', '', 'n\n'));
  tick(d, FAST);
  assert.deepEqual(d.shown, { path: '/w/big.json', text: '', caret: 0, isTooLarge: true });
  assert.ok(d.hold > 0);
  const { deck } = playOut(d);
  assert.equal(deck.shown?.text, 'n\n');
});

test('natural order types a block\'s closing line before its body; off types top to bottom', () => {
  const after = 'function f() {\n  return 1;\n}\n';
  const closedEarly = (opts: PlayOptions) =>
    playOut(deckOf(change('n', '', after)), { ...opts, charsPerMinute: 1200 }).frames.some(
      (t) => t.includes('}') && !t.includes('return'),
    );
  assert.equal(closedEarly({ charsPerMinute: 0, naturalOrder: true }), true);
  assert.equal(closedEarly({ charsPerMinute: 0, naturalOrder: false }), false);
});

test('paths are named relative to the working directory', () => {
  assert.equal(relativePath('/w/src/app.ts', '/w'), 'src/app.ts');
  assert.equal(relativePath('/w/src/app.ts', '/w/'), 'src/app.ts');
  assert.equal(relativePath('/wx/app.ts', '/w'), '/wx/app.ts');
  assert.equal(relativePath('/tmp/a.ts', '/w'), '/tmp/a.ts');
  assert.equal(relativePath('C:\\w\\src\\a.ts', 'C:\\w'), 'src\\a.ts');
  assert.equal(relativePath('/w/a.ts', undefined), '/w/a.ts');
});

test('the view follows the caret deep in a long file', () => {
  const text = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n');
  const caret = text.indexOf('line 400') + 4;
  const view = viewOf({ ...newDeck(), shown: { path: '/w/long.txt', text, caret } });
  assert.equal(view.caretLine, 399);
  assert.equal(view.caretColumn, 4);
  assert.ok(view.lines.length <= 120);
  const f = frame({ ...view, isTyping: true }, 20, 80);
  assert.equal(f.startLine, 390);
  assert.equal(f.source.split('\n').length, 20);
  assert.ok(f.source.includes('line▍ 400'));
  assert.ok(!frame(view, 20, 80).source.includes('▍'), 'no caret mark when not typing');
});

test('the view handles the caret at the very start, before a leading newline', () => {
  const view = viewOf({ ...newDeck(), shown: { path: '/w/a', text: '\nabc', caret: 0 } });
  assert.deepEqual([view.caretLine, view.caretColumn, view.firstLine], [0, 0, 1]);
  assert.deepEqual(view.lines, ['', 'abc']);
});

test('the view shows control characters as symbols, keeping tabs and columns', () => {
  assert.equal(showControls('a\fb\x1b\x00\x7f\x85\tc'), 'a\u240cb\u241b\u2400\u2421\ufffd\tc');
  const view = viewOf({ ...newDeck(), shown: { path: '/w/a', text: 'x = 1\n\f\ny = 2\n', caret: 0 } });
  assert.deepEqual(view.lines, ['x = 1', '\u240c', 'y = 2', '']);
});

test('the view cuts a long line around the caret and the frame keeps the caret on screen', () => {
  const text = 'x'.repeat(150_000) + 'HERE' + 'y'.repeat(150_000);
  const view = viewOf({ ...newDeck(), playing: undefined, shown: { path: '/w/min.js', text, caret: 150_002 } });
  assert.ok(view.lines[0]!.length <= 400);
  assert.ok(view.lines[0]!.includes('HERE'));
  const f = frame({ ...view, isTyping: true }, 10, 72);
  assert.ok(f.source.length <= 73);
  assert.ok(f.source.includes('HE▍RE'));
});

test('a long or multi-line deletion goes in one step', () => {
  const before = Array.from({ length: 200 }, (_, i) => `  statement${i}();`).join('\n') + '\n';
  const d = deckOf(change('del', before, ''));
  tick(d, FAST);
  assert.equal(d.shown?.caret, before.length, 'the caret waits after the text to delete');
  tick(d, FAST);
  assert.equal(d.playing, undefined);
  assert.equal(d.shown?.text, '');
});

test('a short deletion within a line is backspaced in steps', () => {
  const { frames } = playOut(deckOf(change('ren', 'const total = 1;\n', 'const sum = 1;\n')), { charsPerMinute: 1000, naturalOrder: true });
  assert.ok(frames.includes('const tota = 1;\n') || frames.includes('const tot = 1;\n'), 'total is backspaced a little at a time');
});

test('the caret starts at the end of the text a hunk deletes', () => {
  const d = deckOf(change('c', 'abc xyz;\n', 'abc;\n'));
  tick(d, FAST);
  const h = d.playing!.hunks[0]!;
  assert.equal(d.shown?.caret, h.offset + h.deleteText.length);
});

test('high speeds type several lines in one tick', () => {
  const after = 'ab\n'.repeat(300);
  const { ticks } = playOut(deckOf(change('fast', '', after)), { charsPerMinute: 60_000, naturalOrder: false });
  // 900 characters at 1000 a second: 0.9 s, 18 ticks, plus the tick that starts the change.
  assert.ok(ticks <= 20, `took ${ticks} ticks`);
});

test('a change inserting more than 6,000 characters is shown at once', () => {
  const d = deckOf(change('gen', '', 'x'.repeat(7_000) + '\n'));
  tick(d, FAST);
  assert.equal(d.playing, undefined);
  assert.equal(d.shown?.text.length, 7_001);
  assert.ok(d.hold > 0);
  enqueue(d, change('next', '', 'n\n'));
  assert.equal(playOut(d).deck.shown?.text, 'n\n');
});

test('waiting text is capped; the oldest waiting changes are dropped', () => {
  const d = newDeck();
  const half = 'x'.repeat(500_000);
  for (let i = 0; i < 25; i++) enqueue(d, change(`c${i}`, half, half + i));
  const waiting = queued(d);
  const total = waiting.reduce((n, c) => n + c.before.length + c.after.length, 0);
  assert.ok(total <= MAX_WAITING_CHARS);
  assert.equal(waiting[waiting.length - 1]?.id, 'c24');
  assert.equal(d.recorded, 25);
});

test('saved state lists the playing change first and restores with it starting over', () => {
  const d = deckOf(change('a', '', 'alpha\n'), change('b', '', 'beta\n'));
  tick(d, FAST);
  tick(d, FAST);
  assert.deepEqual(liveIds(d), ['a', 'b']);
  togglePause(d);
  const saved = savedOf(d);
  assert.deepEqual(saved, { changes: [{ id: 'a', path: '/w/a.ts' }, { id: 'b', path: '/w/b.ts' }], recorded: 2, isPaused: true });
  const back = restore(saved, [change('a', '', 'alpha\n'), change('b', '', 'beta\n')]);
  assert.equal(back.playing, undefined);
  assert.deepEqual(queued(back).map((c) => c.id), ['a', 'b']);
  assert.equal(back.isPaused, true);
});

test('a reload at either limit keeps the change being typed, which starts over', () => {
  const recorded = new Map<string, Change>();
  const record = (d: Deck, c: Change) => {
    recorded.set(c.id, c);
    enqueue(d, c);
  };
  const reload = (d: Deck) => {
    const saved = savedOf(d);
    return restore(saved, saved.changes.map((s) => recorded.get(s.id)!));
  };

  const d = newDeck();
  record(d, change('typing', '', 'a\n'));
  tick(d, FAST);
  for (let i = 0; i < MAX_WAITING; i++) record(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(playingId(d), 'typing');
  const back = reload(d);
  assert.equal(queued(back).length, MAX_WAITING + 1);
  assert.deepEqual(queued(back).map((c) => c.id), liveIds(d));
  // Recording another brings the waiting changes back within the limit, oldest dropped.
  enqueue(back, change('new', '', 'n\n'));
  assert.equal(queued(back).length, MAX_WAITING);
  assert.equal(queued(back)[0]?.id, 'c1');

  const half = 'line\n'.repeat(100_000);
  const big = newDeck();
  record(big, change('typingBig', half, half + '!'));
  tick(big, FAST);
  for (let i = 0; i < 20; i++) record(big, change(`b${i}`, half, half + i));
  assert.equal(playingId(big), 'typingBig');
  assert.equal(queued(reload(big))[0]?.id, 'typingBig');
});

test('played changes are dropped before waiting ones', () => {
  const d = deckOf(change('p', '', 'p\n'));
  playOut(d);
  for (let i = 0; i < MAX_WAITING; i++) enqueue(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(d.timeline.all().length, MAX_WAITING);
  assert.equal(queued(d).length, MAX_WAITING);
  assert.equal(queued(d)[0]?.id, 'c0');
});

test('the timeline keeps played changes and marks each one played, playing or pending', () => {
  const d = deckOf(change('a', '', 'alpha\n'), change('b', '', 'beta\n'), change('c', '', 'gamma\n'));
  const seqs = d.timeline.all().map((e) => e.seq);
  tick(d, FAST);
  finish(d);
  tick(d, FAST);
  assert.deepEqual(seqs.map((s) => d.timeline.stateOf(s)), ['played', 'playing', 'pending']);
  assert.equal(d.timeline.cursor, seqs[1]);
  assert.equal(d.timeline.pendingCount(), 1);
  skipToLatest(d, FAST);
  assert.deepEqual(seqs.map((s) => d.timeline.stateOf(s)), ['played', 'played', 'played']);
});

test('the shared bundle normalizes line endings', () => {
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
});
