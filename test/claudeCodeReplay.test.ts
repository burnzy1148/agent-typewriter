import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WAITING,
  TICK_MS,
  emptyDeck,
  enqueue,
  finish,
  playOptions,
  relativePath,
  skipToLatest,
  tick,
  togglePause,
  windowAround,
  type Change,
  type Deck,
  type PlayOptions,
} from '../claude-code/hooks/replay';

const FAST: PlayOptions = { charsPerMinute: 6000, naturalOrder: true };

function change(id: string, before: string, after: string, path = `/w/${id}.ts`): Change {
  return { id, path, before, after };
}

function isIdle(d: Deck) {
  return d.queue.length === 0 && !d.playing && d.hold === 0;
}

/** Ticks until nothing is left to play, returning the final deck, every shown text, and the ticks taken. */
function playOut(deck: Deck, opts: PlayOptions = FAST, max = 1_000_000) {
  const frames: string[] = [];
  let d = deck;
  let ticks = 0;
  while (!isIdle(d) && ticks < max) {
    d = tick(d, opts);
    ticks++;
    if (d.playing) assert.equal(d.shown?.text, d.playing.text, 'the pane shows the text being typed');
    if (d.shown) frames.push(d.shown.text);
  }
  return { deck: d, frames, ticks };
}

test('a change plays from its before text to its after text in steps', () => {
  const before = 'function add(a, b) {\n  return a + b;\n}\n';
  const after = 'function add(a, b, c = 0) {\n  // sum\n  return a + b + c;\n}\n';
  const { deck, frames } = playOut(enqueue(emptyDeck, change('add', before, after)));
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
      const { deck } = playOut(enqueue(emptyDeck, change('f', before, after)), opts);
      if (before !== after) assert.equal(deck.shown?.text, after, JSON.stringify({ before, after, opts }));
    }
  }
});

test('changes play one at a time in recorded order', () => {
  let d = enqueue(enqueue(emptyDeck, change('a', '', 'aaa\n')), change('b', '', 'bbb\n'));
  const order: string[] = [];
  while (!isIdle(d)) {
    d = tick(d, FAST);
    const id = d.playing?.change.id;
    if (id && order[order.length - 1] !== id) order.push(id);
  }
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(d.shown?.path, '/w/b.ts');
});

test('typing speed follows charsPerMinute', () => {
  const after = 'x'.repeat(299) + '\n';
  const at = (cpm: number) => playOut(enqueue(emptyDeck, change('s', '', after)), { charsPerMinute: cpm, naturalOrder: true }).ticks;
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
  let d = enqueue(emptyDeck, change('p', '', 'line one\nline two\nline three\n'));
  for (let i = 0; i < 6; i++) d = tick(d, FAST);
  const halfway = d.shown?.text;
  d = togglePause(d);
  assert.equal(tick(d, FAST), d, 'a paused tick changes nothing');
  d = togglePause(d);
  d = tick(d, FAST);
  assert.ok(d.shown!.text.startsWith(halfway!) && d.shown!.text.length > halfway!.length);
  assert.equal(playOut(d).deck.shown?.text, 'line one\nline two\nline three\n');
});

test('finish shows the current change done and the next one starts', () => {
  let d = enqueue(enqueue(enqueue(emptyDeck, change('a', '', 'alpha\n')), change('b', '', 'beta\n')), change('c', '', 'gamma\n'));
  d = tick(tick(d, FAST), FAST);
  d = finish(d);
  assert.equal(d.shown?.text, 'alpha\n');
  assert.equal(d.playing, undefined);
  d = tick(d, FAST);
  assert.equal(d.playing?.change.id, 'b');
});

test('skip to latest leaves nothing queued and shows the last change', () => {
  let d = emptyDeck;
  for (const id of ['a', 'b', 'c', 'd']) d = enqueue(d, change(id, '', `${id}\n`));
  d = tick(d, FAST);
  d = skipToLatest(d, FAST);
  assert.equal(d.queue.length, 0);
  assert.equal(d.playing, undefined);
  assert.equal(d.shown?.text, 'd\n');
  assert.equal(tick(d, FAST), d, 'nothing left to play');
});

test('at most MAX_WAITING changes wait; the oldest is dropped', () => {
  let d = emptyDeck;
  for (let i = 0; i <= MAX_WAITING; i++) d = enqueue(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(d.queue.length, MAX_WAITING);
  assert.equal(d.queue[0]?.id, 'c1');
  assert.equal(d.recorded, MAX_WAITING + 1);
});

test('an unchanged file records nothing', () => {
  assert.equal(enqueue(emptyDeck, change('u', 'same\n', 'same\n')), emptyDeck);
});

test('a too-large change is named, held briefly, and skipped', () => {
  let d = enqueue(emptyDeck, { id: 'big', path: '/w/big.json', before: '', after: '', isTooLarge: true });
  d = enqueue(d, change('next', '', 'n\n'));
  d = tick(d, FAST);
  assert.deepEqual(d.shown, { path: '/w/big.json', text: '', caret: 0, isTooLarge: true });
  assert.ok(d.hold > 0);
  const { deck } = playOut(d);
  assert.equal(deck.shown?.text, 'n\n');
});

test('natural order types a block\'s closing line before its body; off types top to bottom', () => {
  const after = 'function f() {\n  return 1;\n}\n';
  const closedEarly = (opts: PlayOptions) =>
    playOut(enqueue(emptyDeck, change('n', '', after)), { ...opts, charsPerMinute: 1200 }).frames.some(
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

test('the window follows the caret deep in a long file', () => {
  const text = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n');
  const caret = text.indexOf('line 400') + 4;
  const w = windowAround(text, caret, 20, true);
  assert.equal(w.startLine, 390);
  assert.equal(w.source.split('\n').length, 20);
  assert.ok(w.source.includes('line▍ 400'));
  assert.ok(!windowAround(text, caret, 20, false).source.includes('▍'));
  assert.equal(windowAround('a\nb', 0, 20, false).startLine, 1);
});
