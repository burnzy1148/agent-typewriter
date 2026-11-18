import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEol } from '../claude-code/hooks/core.mjs';
import {
  MAX_WAITING,
  MAX_WAITING_CHARS,
  SAVED_SHAPE,
  MAX_PROMPT,
  changeById,
  chaptersOf,
  chipLabel,
  headerLabel,
  keptTurns,
  listLines,
  promptOf,
  turnChipAnchor,
  turnChipLabel,
  turnChips,
  scrollTargets,
  TICK_MS,
  enqueue,
  finish,
  frame,
  listWindow,
  listingOf,
  newDeck,
  playOptions,
  queued,
  relativePath,
  replayFromStart,
  restore,
  rowLabel,
  savedFrom,
  scrolledTop,
  savedOf,
  seek,
  showControls,
  skipToLatest,
  tick,
  togglePause,
  viewOf,
  MAX_CAPTION,
  MAX_ROW_CAPTION,
  captionLines,
  captionsOf,
  cellWidth,
  forgetLoop,
  narrate,
  normalizeCaption,
  setCaption,
  type HeardRow,
  type Narration,
  type RowBlock,
  type Change,
  type Deck,
  type NewChange,
  type PlayOptions,
  type Listing,
  type Row,
  type Saved,
  type TurnInfo,
} from '../claude-code/hooks/replay';

const FAST: PlayOptions = { charsPerMinute: 6000, naturalOrder: true };

function change(id: string, before: string, after: string, path = `/w/${id}.ts`): NewChange {
  return { id, path, before, after, kind: 'modify', time: 0 };
}

/** The changes a reload finds for `saved`: each saved change with the texts of the recorded change of its id, none for one not in `recorded`. */
function withTexts(saved: Saved, recorded: NewChange[]): Change[] {
  return saved.changes.flatMap((s) => {
    const c = recorded.find((r) => r.id === s.id);
    return c ? [{ ...s, before: c.before, after: c.after }] : [];
  });
}

/** A new deck with `changes` recorded in order. */
function deckOf(...changes: NewChange[]): Deck {
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
  finish(d, FAST);
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
  const d = deckOf({ ...change('big', '', '', '/w/big.json'), isTooLarge: true }, change('next', '', 'n\n'));
  tick(d, FAST);
  assert.deepEqual(d.shown, { id: 'big', path: '/w/big.json', text: '', caret: 0, isTooLarge: true });
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
  const view = viewOf({ ...newDeck(), shown: { id: 'v', path: '/w/long.txt', text, caret } });
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
  const view = viewOf({ ...newDeck(), shown: { id: 'v', path: '/w/a', text: '\nabc', caret: 0 } });
  assert.deepEqual([view.caretLine, view.caretColumn, view.firstLine], [0, 0, 1]);
  assert.deepEqual(view.lines, ['', 'abc']);
});

test('the view shows control characters as symbols, keeping tabs and columns', () => {
  assert.equal(showControls('a\fb\x1b\x00\x7f\x85\tc'), 'a\u240cb\u241b\u2400\u2421\ufffd\tc');
  const view = viewOf({ ...newDeck(), shown: { id: 'v', path: '/w/a', text: 'x = 1\n\f\ny = 2\n', caret: 0 } });
  assert.deepEqual(view.lines, ['x = 1', '\u240c', 'y = 2', '']);
});

test('the view cuts a long line around the caret and the frame keeps the caret on screen', () => {
  const text = 'x'.repeat(150_000) + 'HERE' + 'y'.repeat(150_000);
  const view = viewOf({ ...newDeck(), playing: undefined, shown: { id: 'v', path: '/w/min.js', text, caret: 150_002 } });
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

test('saved state lists the played changes, the one being typed, then the waiting ones, and restores them', () => {
  const changes = [change('a', '', 'alpha\n'), { ...change('b', '', 'beta\n'), tool: 'Edit' } as const, { ...change('c', '', 'gamma\n'), tool: 'Write', kind: 'create', time: 7 } as const];
  const d = deckOf(...changes);
  tick(d, FAST);
  finish(d, FAST);
  tick(d, FAST);
  assert.equal(playingId(d), 'b');
  togglePause(d);
  const saved = savedOf(d);
  assert.deepEqual(saved, {
    changes: [
      { id: 'a', number: 1, path: '/w/a.ts', kind: 'modify', time: 0 },
      { id: 'b', number: 2, tool: 'Edit', path: '/w/b.ts', kind: 'modify', time: 0 },
      { id: 'c', number: 3, tool: 'Write', path: '/w/c.ts', kind: 'create', time: 7 },
    ],
    played: 1,
    recorded: 3,
    isPaused: true,
  });

  // The one being typed starts over and, paused, is shown cued; the played one stays played.
  const back = restore(saved, withTexts(saved, changes), FAST);
  assert.equal(back.playing, undefined);
  assert.deepEqual(
    back.timeline.all().map((e) => [e.kind, e.time, back.timeline.stateOf(e.seq)]),
    [
      ['modify', 0, 'played'],
      ['modify', 0, 'pending'],
      ['create', 7, 'pending'],
    ],
  );
  assert.deepEqual(queued(back).map((c) => c.id), ['b', 'c']);
  assert.deepEqual(back.shown, { id: 'b', path: '/w/b.ts', text: '', caret: 0 });
  assert.equal(back.isPaused, true);
  assert.deepEqual(savedOf(back), saved);
  // Unpaused, the played one is shown done until the next starts.
  assert.deepEqual(restore({ ...saved, isPaused: false }, withTexts(saved, changes), FAST).shown, { id: 'a', path: '/w/a.ts', text: 'alpha\n', caret: 6 });
});

test('a reload with every change played plays none again and shows the last one done', () => {
  const changes = [change('a', '', 'alpha\n'), change('b', 'one\ntwo\n', 'one\nbeta\ntwo\n')];
  const d = deckOf(...changes);
  playOut(d);
  const saved = savedOf(d);
  assert.equal(saved.played, 2);
  const back = restore(saved, withTexts(saved, changes), FAST);
  assert.deepEqual(back.shown, d.shown);
  assert.equal(tick(back, FAST), false);
  assert.equal(back.timeline.pendingCount(), 0);
  assert.deepEqual(savedOf(back), saved);
});

test('a reload skips a saved change whose texts are gone, and the rest keep their states', () => {
  const [a, b, c] = [change('a', '', 'a\n'), change('b', '', 'b\n'), change('c', '', 'c\n')];
  const d = deckOf(a, b, c);
  for (let i = 0; i < 2; i++) {
    tick(d, FAST);
    finish(d, FAST);
  }
  const saved = savedOf(d);
  assert.equal(saved.played, 2);

  const noB = restore(saved, withTexts(saved, [a, c]), FAST);
  assert.deepEqual(savedOf(noB), { ...saved, changes: saved.changes.filter((s) => s.id !== 'b'), played: 1 });
  assert.equal(noB.shown?.text, 'a\n');
  const onlyC = restore(saved, withTexts(saved, [c]), FAST);
  assert.deepEqual(savedOf(onlyC), { ...saved, changes: saved.changes.filter((s) => s.id === 'c'), played: 0 });
  assert.equal(onlyC.shown, undefined);
});

test('saved state is read under its own tag, under saved-2 and saved-1 numbered by place, and not under any other', () => {
  const d = deckOf({ ...change('a', '', 'a\n'), tool: 'Write', kind: 'create', time: 5 });
  playOut(d);
  const saved = savedOf(d);
  assert.equal(SAVED_SHAPE, 'saved-4');
  assert.deepEqual(savedFrom({ shape: SAVED_SHAPE, value: saved }), saved);
  const v2 = {
    changes: [
      { id: 'p', path: '/w/p.ts', kind: 'create', time: 4 },
      { id: 'q', path: '/w/q.ts', kind: 'modify', time: 6 },
    ],
    played: 1,
    recorded: 5,
    isPaused: false,
  };
  assert.deepEqual(savedFrom({ shape: 'saved-2', value: v2 }), {
    ...v2,
    changes: [
      { id: 'p', number: 4, path: '/w/p.ts', kind: 'create', time: 4 },
      { id: 'q', number: 5, path: '/w/q.ts', kind: 'modify', time: 6 },
    ],
  });
  const v1 = { changes: [{ id: 'r', path: '/w/r.ts' }, { id: 'big', path: '/w/big.json', isTooLarge: true }], recorded: 3, isPaused: true };
  assert.deepEqual(savedFrom({ shape: 'saved-1', value: v1 }), {
    changes: [
      { id: 'r', number: 2, path: '/w/r.ts', kind: 'modify', time: 0 },
      { id: 'big', number: 3, path: '/w/big.json', kind: 'modify', time: 0, isTooLarge: true },
    ],
    played: 0,
    recorded: 3,
    isPaused: true,
  });
  const empty = { changes: [], played: 0, recorded: 0, isPaused: false };
  assert.deepEqual(savedFrom({ shape: 'saved-0', value: saved }), empty);
  assert.deepEqual(savedFrom(undefined), empty);
});

test('a reload at either limit keeps the change being typed, which starts over', () => {
  const recorded: NewChange[] = [];
  const record = (d: Deck, c: NewChange) => {
    recorded.push(c);
    enqueue(d, c);
  };
  const reload = (d: Deck) => {
    const saved = savedOf(d);
    return restore(saved, withTexts(saved, recorded), FAST);
  };

  const d = newDeck();
  record(d, change('typing', '', 'a\n'));
  tick(d, FAST);
  for (let i = 0; i < MAX_WAITING; i++) record(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(playingId(d), 'typing');
  const back = reload(d);
  assert.equal(queued(back).length, MAX_WAITING + 1);
  assert.deepEqual(queued(back).map((c) => c.id), savedOf(d).changes.map((c) => c.id));
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
  const bigBack = reload(big);
  assert.equal(queued(bigBack)[0]?.id, 'typingBig');
  enqueue(bigBack, change('newBig', half, half + '?'));
  const waiting = queued(bigBack);
  assert.ok(waiting.reduce((n, c) => n + c.before.length + c.after.length, 0) <= MAX_WAITING_CHARS);
  assert.notEqual(waiting[0]?.id, 'typingBig');
  assert.equal(waiting.at(-1)?.id, 'newBig');
});

/** A deck typing a change with MAX_WAITING more recorded behind it, so the timeline has dropped the one being typed. */
function typingPastTheLimit() {
  const d = deckOf(change('typing', '', 'typed\n'));
  tick(d, FAST);
  for (let i = 0; i < MAX_WAITING; i++) enqueue(d, change(`c${i}`, '', `${i}\n`));
  assert.equal(d.timeline.get(d.playing!.seq), undefined, 'the timeline dropped the change being typed');
  return d;
}

test('the change being typed still finishes, and is saved, once the timeline drops it', () => {
  const d = typingPastTheLimit();
  assert.deepEqual(savedOf(d).changes.slice(0, 2).map((c) => c.id), ['typing', 'c0']);
  assert.equal(queued(d).length, MAX_WAITING);
  const frames: string[] = [];
  while (playingId(d) === 'typing') {
    tick(d, FAST);
    frames.push(d.shown!.text);
  }
  assert.ok(frames.includes('typed\n'));
  while (!d.playing) tick(d, FAST);
  assert.equal(playingId(d), 'c0');
  assert.equal(queued(d).length, MAX_WAITING - 1);
});

test('skip to latest works once the timeline has dropped the change being typed', () => {
  const d = typingPastTheLimit();
  skipToLatest(d, FAST);
  assert.equal(d.playing, undefined);
  assert.equal(queued(d).length, 0);
  assert.equal(d.shown?.text, `${MAX_WAITING - 1}\n`);
  assert.deepEqual([savedOf(d).changes.length, savedOf(d).played], [MAX_WAITING, MAX_WAITING]);
  enqueue(d, change('next', '', 'n\n'));
  assert.equal(playOut(d).deck.shown?.text, 'n\n');
});

test('timeline events name the path relative to the working directory and count lines', () => {
  const edit = change('a', 'one\ntwo\n', 'one\n2\n3\n', '/w/src/a.ts');
  const d = newDeck();
  enqueue(d, edit, '/w');
  const [e] = d.timeline.all();
  assert.deepEqual([e?.uri, e?.relPath, e?.linesAdded, e?.linesRemoved], ['/w/src/a.ts', 'src/a.ts', 2, 1]);
  assert.equal(restore(savedOf(d), withTexts(savedOf(d), [edit]), FAST, '/w').timeline.all()[0]?.relPath, 'src/a.ts');
  const win = newDeck();
  enqueue(win, change('b', '', 'b\n', 'C:\\w\\src\\b.ts'), 'C:\\w');
  assert.equal(win.timeline.all()[0]?.relPath, 'src/b.ts');
});

test('timeline events carry each change\'s kind and time', () => {
  const d = deckOf({ ...change('a', '', 'a\n'), kind: 'create', time: 1_700_000_000_000 }, { ...change('b', 'b\n', 'B\n'), time: 1_700_000_000_500 });
  assert.deepEqual(
    d.timeline.all().map((e) => [e.kind, e.time]),
    [
      ['create', 1_700_000_000_000],
      ['modify', 1_700_000_000_500],
    ],
  );
  assert.deepEqual(queued(d).map((c) => [c.kind, c.time]), [
    ['create', 1_700_000_000_000],
    ['modify', 1_700_000_000_500],
  ]);
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
  finish(d, FAST);
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

test('changes are numbered in recorded order and keep their tool; an unchanged file takes no number', () => {
  const d = deckOf({ ...change('a', '', 'a\n'), tool: 'Write' }, change('same', 'x\n', 'x\n'), { ...change('b', 'b\n', 'B\n'), tool: 'Edit' }, change('c', '', 'c\n'));
  assert.deepEqual(
    d.timeline.all().map((e) => [(e as unknown as Change).id, (e as unknown as Change).number, (e as unknown as Change).tool]),
    [
      ['a', 1, 'Write'],
      ['b', 2, 'Edit'],
      ['c', 3, undefined],
    ],
  );
  assert.deepEqual(queued(d).map((c) => [c.number, c.tool]), [
    [1, 'Write'],
    [2, 'Edit'],
    [3, undefined],
  ]);
});

test('saved state round-trips numbers and tools', () => {
  const changes = [{ ...change('a', '', 'a\n'), tool: 'Write' } as const, { ...change('b', 'b\n', 'B\n'), tool: 'Edit' } as const];
  const d = deckOf(...changes);
  tick(d, FAST);
  finish(d, FAST);
  const saved = savedOf(d);
  assert.deepEqual(saved.changes.map((c) => [c.id, c.number, c.tool]), [
    ['a', 1, 'Write'],
    ['b', 2, 'Edit'],
  ]);
  const back = restore(saved, withTexts(saved, changes), FAST);
  assert.deepEqual(savedOf(back), saved);
  assert.deepEqual(listingOf(back).rows.map((r) => [r.number, r.tool, r.state]), [
    [1, 'Write', 'played'],
    [2, 'Edit', 'pending'],
  ]);
});

/** Six changes, each a new file holding its id, with the `n`th (1-based) being typed. */
function sixWithTyping(n: number) {
  const d = deckOf(...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => change(id, '', `${id}${id}${id}\n`)));
  for (let i = 1; i < n; i++) {
    tick(d, FAST);
    finish(d, FAST);
  }
  tick(d, FAST);
  assert.equal(playingId(d), ['a', 'b', 'c', 'd', 'e', 'f'][n - 1]);
  return d;
}

/** The ids each change starts typing in, until nothing is left. */
function startOrder(d: Deck) {
  const order: string[] = [];
  while (!isIdle(d)) {
    tick(d, FAST);
    const id = playingId(d);
    if (id && order.at(-1) !== id) order.push(id);
  }
  return order;
}

test('a seek back while playing types the picked change next, then the rest, and earlier ones stay played', () => {
  const d = sixWithTyping(5);
  assert.equal(seek(d, 'b', FAST), true);
  assert.equal(d.playing, undefined);
  assert.deepEqual(d.shown, { id: 'b', path: '/w/b.ts', text: '', caret: 0 });
  assert.deepEqual(listingOf(d).rows.map((r) => r.state), ['played', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(startOrder(d), ['b', 'c', 'd', 'e', 'f']);
  assert.equal(d.shown?.text, 'fff\n');
});

test('a seek forward while playing skips the changes before the picked one', () => {
  const d = sixWithTyping(2);
  seek(d, 'e', FAST);
  assert.deepEqual(listingOf(d).rows.map((r) => r.state), ['played', 'played', 'played', 'played', 'pending', 'pending']);
  assert.deepEqual(startOrder(d), ['e', 'f']);
});

test('a seek while paused types nothing until resume, then the picked change and the rest', () => {
  const d = sixWithTyping(5);
  togglePause(d);
  seek(d, 'b', FAST);
  assert.equal(d.isPaused, true);
  for (let i = 0; i < 20; i++) assert.equal(tick(d, FAST), false);
  assert.equal(d.shown?.id, 'b');
  assert.equal(listingOf(d).current, 'b');
  togglePause(d);
  assert.deepEqual(startOrder(d), ['b', 'c', 'd', 'e', 'f']);
});

test('a seek to the change being typed starts it over', () => {
  const d = deckOf(change('long', '', 'one two three four five six\n'), change('next', '', 'n\n'));
  for (let i = 0; i < 4; i++) tick(d, FAST);
  assert.ok(d.shown!.text.length > 0);
  seek(d, 'long', FAST);
  assert.deepEqual(d.shown, { id: 'long', path: '/w/long.ts', text: '', caret: 0 });
  tick(d, FAST);
  assert.equal(playingId(d), 'long');
  assert.equal(d.playing?.text, '');
});

test('a seek overtakes the change being typed, so its stale completion moves nothing', () => {
  const d = sixWithTyping(5);
  const { seq, token } = d.playing!;
  seek(d, 'b', FAST);
  const cursor = d.timeline.cursor;
  d.timeline.complete(seq, token);
  assert.equal(d.timeline.cursor, cursor);
  assert.equal(queued(d)[0]?.id, 'b');
});

test('a seek to a change no longer kept changes nothing', () => {
  const d = sixWithTyping(3);
  assert.equal(seek(d, 'gone', FAST), false);
  assert.equal(playingId(d), 'c');
});

test('a seek to the change being typed starts it over even once the timeline has dropped it', () => {
  const d = typingPastTheLimit();
  tick(d, FAST);
  assert.ok(d.playing!.text.length > 0);
  assert.equal(seek(d, 'typing', FAST), true);
  assert.equal(playingId(d), 'typing');
  assert.equal(d.playing!.text, '');
  assert.equal(listingOf(d).rows[0]?.id, 'typing');
});

test('from start plays every kept change again after everything played', () => {
  const d = deckOf(change('a', '', 'a\n'), change('b', '', 'b\n'), change('c', '', 'c\n'));
  playOut(d);
  assert.equal(replayFromStart(d, FAST), true);
  assert.deepEqual(startOrder(d), ['a', 'b', 'c']);
  assert.equal(replayFromStart(newDeck(), FAST), false);
});

test('from start while paused cues the first change and stays paused', () => {
  const d = sixWithTyping(4);
  togglePause(d);
  replayFromStart(d, FAST);
  assert.equal(d.isPaused, true);
  assert.deepEqual(d.shown, { id: 'a', path: '/w/a.ts', text: '', caret: 0 });
  assert.equal(tick(d, FAST), false);
});

test('finish current after a seek while paused shows the picked change done, and the next follows on resume', () => {
  const d = sixWithTyping(4);
  togglePause(d);
  seek(d, 'b', FAST);
  finish(d, FAST);
  assert.deepEqual(d.shown, { id: 'b', path: '/w/b.ts', text: 'bbb\n', caret: 4 });
  assert.deepEqual(listingOf(d).rows.slice(0, 3).map((r) => r.state), ['played', 'played', 'pending']);
  assert.equal(tick(d, FAST), false);
  togglePause(d);
  assert.deepEqual(startOrder(d), ['c', 'd', 'e', 'f']);
});

test('finish current during the hold after a change shown at once leaves the next change waiting', () => {
  const d = deckOf({ ...change('big', '', '', '/w/big.json'), isTooLarge: true }, change('n', '', 'n\n'));
  tick(d, FAST);
  assert.ok(d.hold > 0);
  finish(d, FAST);
  assert.equal(d.hold, 0);
  assert.equal(d.shown?.id, 'big');
  assert.equal(queued(d)[0]?.id, 'n');
});

test('a seek while paused survives a reload: still paused, the picked change cued, the rest after it', () => {
  const changes = ['a', 'b', 'c', 'd'].map((id) => change(id, `${id}\n`, `${id}${id}\n`));
  const d = deckOf(...changes);
  for (let i = 0; i < 3; i++) {
    tick(d, FAST);
    finish(d, FAST);
  }
  togglePause(d);
  seek(d, 'b', FAST);
  const saved = savedOf(d);
  assert.equal(saved.played, 1);
  const back = restore(saved, withTexts(saved, changes), FAST);
  assert.equal(back.isPaused, true);
  assert.equal(back.shown?.text, 'b\n');
  assert.deepEqual(back.shown, d.shown);
  assert.deepEqual(listingOf(back), {
    rows: listingOf(d).rows,
    dropped: 0,
    current: 'b',
    isPaused: true,
  });
  togglePause(back);
  assert.deepEqual(startOrder(back), ['b', 'c', 'd']);
});

test('the listing has a row per kept change with its state, counts and the change shown', () => {
  const d = deckOf(
    { ...change('a', '', 'one\ntwo\n'), tool: 'Write' },
    { ...change('b', 'x\ny\n', 'x\nY\n'), tool: 'Edit' },
    change('c', '', 'c\n'),
    { ...change('big', '', '', '/w/big.json'), isTooLarge: true },
    change('e', 'gone\n', ''),
  );
  tick(d, FAST);
  finish(d, FAST);
  tick(d, FAST);
  finish(d, FAST);
  tick(d, FAST);
  assert.deepEqual(listingOf(d), {
    rows: [
      { id: 'a', number: 1, tool: 'Write', path: '/w/a.ts', state: 'played', added: 2, removed: 0 },
      { id: 'b', number: 2, tool: 'Edit', path: '/w/b.ts', state: 'played', added: 1, removed: 1 },
      { id: 'c', number: 3, path: '/w/c.ts', state: 'playing', added: 1, removed: 0 },
      { id: 'big', number: 4, path: '/w/big.json', state: 'pending', isTooLarge: true, added: 0, removed: 0 },
      { id: 'e', number: 5, path: '/w/e.ts', state: 'pending', added: 0, removed: 1 },
    ],
    dropped: 0,
    current: 'c',
    isPaused: false,
  });
  assert.deepEqual(listingOf(newDeck()), { rows: [], dropped: 0, isPaused: false });
  togglePause(d);
  assert.equal(listingOf(d).isPaused, true);
});

test('the listing counts the changes dropped before the oldest kept one', () => {
  const d = newDeck();
  for (let i = 0; i < MAX_WAITING + 12; i++) enqueue(d, change(`c${i}`, '', `${i}\n`));
  const l = listingOf(d);
  assert.equal(l.rows.length, MAX_WAITING);
  assert.equal(l.rows[0]?.number, 13);
  assert.equal(l.dropped, 12);
});

test('the list window follows the current row a third of the way down, or stays where it was scrolled', () => {
  assert.equal(listWindow(80, 0, 10), 0);
  assert.equal(listWindow(80, 39, 10), 36);
  assert.equal(listWindow(80, 79, 10), 70);
  assert.equal(listWindow(5, 4, 10), 0, 'a list that fits starts at its first row');
  assert.equal(listWindow(80, undefined, 10), 0);
  assert.equal(listWindow(80, 39, 10, 2), 2);
  assert.equal(listWindow(80, 39, 10, -5), 0);
  assert.equal(listWindow(80, 39, 10, 500), 70);
});

const ROW: Row = { id: 'r', number: 7, tool: 'Edit', path: '/w/src/routes/signup.ts', state: 'played', added: 4, removed: 0 };
const AT = { isCurrent: false, isPaused: false };

test('a row label shows a glyph, number, tool, path and counts, and the state word only where it belongs', () => {
  const label = (row: Partial<Row>, at: Partial<typeof AT> = {}) => {
    const l = rowLabel({ ...ROW, ...row }, 'src/routes/signup.ts', { ...AT, ...at }, 80);
    return `${l.lead}${l.dir}${l.file}${l.tail}`;
  };
  assert.deepEqual(rowLabel(ROW, 'src/routes/signup.ts', AT, 80), { lead: '✓ #7 Edit ', dir: 'src/routes/', file: 'signup.ts', tail: ' +4' });
  assert.equal(label({ state: 'playing' }, { isCurrent: true }), '▸ #7 Edit src/routes/signup.ts Typing +4');
  assert.equal(label({ state: 'playing' }, { isCurrent: true, isPaused: true }), '▸ #7 Edit src/routes/signup.ts Paused +4');
  assert.equal(label({ state: 'pending' }, { isCurrent: true, isPaused: true }), '▸ #7 Edit src/routes/signup.ts Next +4');
  assert.equal(label({ state: 'pending', added: 1, removed: 1 }), '○ #7 Edit src/routes/signup.ts +1 −1');
  assert.equal(label({ state: 'played' }, { isCurrent: true }), '✓ #7 Edit src/routes/signup.ts +4');
  assert.equal(label({ isTooLarge: true, added: 0 }, { isCurrent: true }), '⊘ #7 Edit src/routes/signup.ts Too large');
  assert.equal(label({ isTooLarge: true, added: 0 }), '⊘ #7 Edit src/routes/signup.ts Not typed');
  assert.equal(label({ isTooLarge: true, state: 'pending', added: 0 }), '○ #7 Edit src/routes/signup.ts');
  assert.equal(label({ isTooLarge: true, state: 'pending', added: 0 }, { isCurrent: true, isPaused: true }), '▸ #7 Edit src/routes/signup.ts Too large');
  assert.equal(label({ tool: undefined }), '✓ #7 src/routes/signup.ts +4');
});

test('a row label cuts the folder, then the file name, to fit', () => {
  const fit = (width: number) => rowLabel(ROW, 'src/routes/signup.ts', AT, width);
  assert.deepEqual(fit(28), { lead: '✓ #7 Edit ', dir: 'src/r…', file: 'signup.ts', tail: ' +4' });
  for (const width of [40, 28, 22, 18, 15]) {
    const l = fit(width);
    assert.equal(`${l.lead}${l.dir}${l.file}${l.tail}`.length <= width, true, `width ${width}: ${JSON.stringify(l)}`);
  }
  assert.deepEqual(fit(22), { lead: '✓ #7 Edit ', dir: '', file: 'signup.ts', tail: ' +4' });
  assert.deepEqual(fit(18), { lead: '✓ #7 Edit ', dir: '', file: 'sign…', tail: ' +4' });
  assert.equal(rowLabel(ROW, 'signup.ts', AT, 80).dir, '');
  assert.equal(rowLabel(ROW, 'C:\\w\\src\\a.ts', AT, 80).file, 'a.ts');
});

test('a scroll moves the list by its kind: a wheel over the list by its ticks, a page by the list, Home and End to its ends, an arrow a row', () => {
  const list = { top: 10, height: 8, count: 80, firstRow: 12 };
  const key = (by: number, contentRows = 19) => scrolledTop({ by, bodyRows: 20, contentRows }, list);
  assert.equal(scrolledTop({ by: 3, bodyRows: 20, contentRows: 19, pointerRow: 15 }, list), 13);
  assert.equal(scrolledTop({ by: -1, bodyRows: 20, contentRows: 19, pointerRow: 12 }, list), 9);
  assert.equal(scrolledTop({ by: 3, bodyRows: 20, contentRows: 19, pointerRow: 11 }, list), undefined, 'a wheel over the code is not the list\'s');
  assert.equal(key(20), 18, 'page down moves by the rows the list shows');
  assert.equal(key(-20), 2);
  assert.equal(key(19), 72, 'End goes to the last rows');
  assert.equal(key(-19), 0, 'Home goes to the first');
  assert.equal(key(20, 20), 18, 'Home and End read as a page when the tree fills the body');
  assert.equal(key(1), 11);
  assert.equal(key(-100), 2, 'a long scroll up by keys is a page');
  assert.equal(scrolledTop({ by: -50, bodyRows: 20, contentRows: 19, pointerRow: 15 }, list), 0);
  assert.equal(scrolledTop({ by: 1, bodyRows: 20, contentRows: 19 }, { ...list, count: 8 }), undefined, 'a list that fits has nothing to scroll');
});

const MAIN = { turnId: 't1', mainTurnId: 't1' } as const;
const AGENT = { turnId: 'ta', agentId: 'ag', mainTurnId: 't1', agentCallId: 'toolu_agent' } as const;

test('a change keeps its turn and agent through the timeline, saved state and a reload', () => {
  const changes = [{ ...change('a', '', 'a\n'), ...MAIN }, { ...change('b', 'b\n', 'B\n'), ...AGENT }, change('c', 'c\n', 'C\n')];
  const d = deckOf(...changes);
  tick(d, FAST);
  const saved = savedOf(d);
  assert.deepEqual(
    saved.changes.map(({ id, turnId, agentId, mainTurnId, agentCallId }) => ({ id, turnId, agentId, mainTurnId, agentCallId })),
    [
      { id: 'a', ...MAIN, agentId: undefined, agentCallId: undefined },
      { id: 'b', ...AGENT },
      { id: 'c', turnId: undefined, agentId: undefined, mainTurnId: undefined, agentCallId: undefined },
    ],
  );
  assert.equal('agentId' in saved.changes[0]!, false, 'a link a change lacks is left out, not saved as undefined');
  assert.equal('turnId' in saved.changes[2]!, false);
  const back = restore(saved, withTexts(saved, changes), FAST);
  assert.deepEqual(savedOf(back), saved);
  assert.deepEqual(changeById(back, 'b'), { ...changes[1], number: 2 });
  assert.deepEqual(changeById(d, 'a'), { ...changes[0], number: 1 }, 'the change being typed is found too');
  assert.equal(changeById(d, 'nope'), undefined);
});

test('state saved under saved-3, which kept no links, loads as stored', () => {
  const v3 = {
    changes: [
      { id: 'p', number: 1, tool: 'Write', path: '/w/p.ts', kind: 'create', time: 4 },
      { id: 'q', number: 2, tool: 'Edit', path: '/w/q.ts', kind: 'modify', time: 6 },
    ],
    played: 1,
    recorded: 2,
    isPaused: false,
  };
  assert.deepEqual(savedFrom({ shape: 'saved-3', value: v3 }), v3);
});

test('changeById finds the change being typed once the timeline has dropped it', () => {
  const d = deckOf({ ...change('first', '', 'x\n'), ...AGENT });
  tick(d, FAST);
  for (let i = 0; i < MAX_WAITING + 1; i++) enqueue(d, change(`n${i}`, '', `${i}\n`));
  assert.equal(d.timeline.all().some((e) => (e as unknown as Change).id === 'first'), false);
  assert.equal(changeById(d, 'first')?.agentCallId, 'toolu_agent');
});

test('show in conversation tries the call, then the Agent call for an agent\'s change', () => {
  assert.deepEqual(scrollTargets({ id: 'toolu_1', ...MAIN }), ['toolu_1']);
  assert.deepEqual(scrollTargets({ id: 'toolu_2', ...AGENT }), ['toolu_2', 'toolu_agent']);
  assert.deepEqual(scrollTargets({ id: 'toolu_3' }), ['toolu_3']);
});

test('a chip names the change\'s state and number', () => {
  const row = (state: Row['state'], extra: Partial<Row> = {}): Row => ({ id: 'x', number: 2, path: '/w/x.ts', state, added: 1, removed: 0, ...extra });
  const at = (isCurrent: boolean, isPaused = false) => ({ isCurrent, isPaused });
  assert.equal(chipLabel(row('played'), at(false)), 'Replay #2');
  assert.equal(chipLabel(row('played'), at(true)), 'Replay #2', 'the last change played, shown done');
  assert.equal(chipLabel(row('playing'), at(true)), 'Typing #2');
  assert.equal(chipLabel(row('playing'), at(true, true)), 'Paused #2');
  assert.equal(chipLabel(row('pending'), at(true, true)), 'Next #2');
  assert.equal(chipLabel(row('pending'), at(false)), 'Queued #2');
  assert.equal(chipLabel(row('pending', { isTooLarge: true }), at(true)), 'Too large #2');
  assert.equal(chipLabel(row('played', { isTooLarge: true }), at(true)), 'Too large #2', 'shown during its hold');
  assert.equal(chipLabel(row('played', { isTooLarge: true }), at(false)), 'Not typed #2');
  assert.equal(chipLabel(row('pending', { isTooLarge: true }), at(false)), 'Queued #2');
});

test('rows carry the turn and Agent call of their change, and lack the ones it lacks', () => {
  const d = deckOf({ ...change('a', '', 'a\n'), ...MAIN }, { ...change('b', '', 'b\n'), ...AGENT }, change('c', '', 'c\n'));
  const rows = listingOf(d).rows;
  assert.deepEqual(rows.map((r) => [r.id, r.mainTurnId, r.agentCallId]), [
    ['a', 't1', undefined],
    ['b', 't1', 'toolu_agent'],
    ['c', undefined, undefined],
  ]);
  assert.equal('agentCallId' in rows[0]!, false);
  assert.equal('mainTurnId' in rows[2]!, false);
});

// Chapters by turn.

/** A row of change `n`, in main turn `turn` (none when undefined), started through Agent call `call` when given. */
function turnRow(n: number, turn?: string, call?: string): Row {
  return { id: `toolu_${n}`, number: n, path: `/w/${n}.ts`, state: 'pending', added: 1, removed: 0, ...(turn && { mainTurnId: turn }), ...(call && { agentCallId: call }) };
}

function listingFrom(rows: Row[], dropped = 0): Listing {
  return { rows, dropped, isPaused: false };
}

const TURNS: TurnInfo[] = [
  { turnId: 't1', number: 1, prompt: 'Add a rate limiter.', isEnded: true },
  { turnId: 't2', number: 2, prompt: 'Cover it with tests.' },
];

test('chapters group rows by main turn, in recorded order, ordered by their first row', () => {
  const rows = [turnRow(1, 't1'), turnRow(2, 't1'), turnRow(3, 't2'), turnRow(4, 't2')];
  const chapters = chaptersOf(listingFrom(rows), TURNS);
  assert.deepEqual(
    chapters.map((ch) => [ch.key, ch.kind, ch.number, ch.prompt, ch.isEnded, ch.rows.map((r) => r.number)]),
    [
      ['t1', 'turn', 1, 'Add a rate limiter.', true, [1, 2]],
      ['t2', 'turn', 2, 'Cover it with tests.', undefined, [3, 4]],
    ],
  );
});

test("a background agent's later change joins its own turn's chapter, which still comes first", () => {
  // Change 3, from an agent turn 1 started, was recorded after turn 2's change 2.
  const rows = [turnRow(1, 't1'), turnRow(2, 't2'), turnRow(3, 't1', 'toolu_agent')];
  const chapters = chaptersOf(listingFrom(rows), TURNS);
  assert.deepEqual(chapters.map((ch) => [ch.key, ch.rows.map((r) => r.number)]), [
    ['t1', [1, 3]],
    ['t2', [2]],
  ]);
});

test('changes in no turn share an Outside a turn chapter, and a turn known by id only is an Earlier turn', () => {
  const rows = [turnRow(1), turnRow(2, 't0'), turnRow(3), turnRow(4, 't1')];
  const chapters = chaptersOf(listingFrom(rows), TURNS);
  assert.deepEqual(chapters.map((ch) => [ch.key, ch.kind, ch.rows.map((r) => r.number)]), [
    ['', 'outside', [1, 3]],
    ['t0', 'earlier', [2]],
    ['t1', 'turn', [4]],
  ]);
  assert.deepEqual(headerLabel(chapters[0]!, 80), { title: 'Outside a turn', prompt: '', count: '2 changes', play: 'Play from first' });
  assert.deepEqual(headerLabel(chapters[1]!, 80), { title: 'Earlier turn', prompt: '', count: '1 change', play: 'Play turn' });
});

test("a turn whose first changes were dropped starts its chapter at its first kept change", () => {
  const d = newDeck();
  for (let i = 0; i < MAX_WAITING + 3; i++) enqueue(d, { ...change(`c${i}`, '', `${i}\n`), ...(i < 5 ? MAIN : { turnId: 't2', mainTurnId: 't2' }) });
  const l = listingOf(d);
  const lines = listLines(l, chaptersOf(l, TURNS));
  assert.equal(lines[0]?.kind, 'dropped');
  assert.equal(lines[1]?.kind === 'header' && lines[1].chapter.rows[0]?.number, 4);
  assert.equal(lines[1]?.kind === 'header' && lines[1].chapter.rows.length, 2);
});

test('the list is the dropped note, then each chapter\'s header and rows', () => {
  const rows = [turnRow(4, 't1'), turnRow(5, 't2')];
  const l = listingFrom(rows, 3);
  const lines = listLines(l, chaptersOf(l, TURNS));
  assert.deepEqual(
    lines.map((x) => (x.kind === 'dropped' ? 'dropped' : x.kind === 'header' ? `header ${x.chapter.key}` : `row ${x.row.number}`)),
    ['dropped', 'header t1', 'row 4', 'header t2', 'row 5'],
  );
  assert.deepEqual(listLines(listingFrom([]), []), []);
});

test('a header names the turn, its prompt cut to fit, its count and Play turn', () => {
  const ch = { key: 't2', kind: 'turn' as const, number: 2, prompt: 'Cover it with tests and update the other callers.', rows: [1, 2, 3, 4].map((n) => turnRow(n, 't2')) };
  assert.deepEqual(headerLabel(ch, 120), { title: 'Turn 2', prompt: 'Cover it with tests and update the other callers.', count: '4 changes', play: 'Play turn' });
  const cut = headerLabel(ch, 40);
  // 40 columns: 'Turn 2' and '4 changes' with their gaps, then 'Play turn' and its padding, leave 11 for the prompt.
  assert.equal(cut.prompt, 'Cover it w…');
  assert.equal(headerLabel(ch, 30).prompt, '', 'no room for a prompt leaves it out');
  assert.equal(headerLabel({ ...ch, rows: [turnRow(1, 't2')] }, 120).count, '1 change');
  assert.equal(headerLabel({ ...ch, prompt: '' }, 120).prompt, '');
  assert.equal(headerLabel({ ...ch, prompt: 'two\n\n  lines\tand tabs' }, 120).prompt, 'two lines and tabs');
  assert.equal(headerLabel({ ...ch, prompt: 'fix \x1b[31merror\x07' }, 120).prompt, 'fix \u241b[31merror\u2407', 'control characters drawn as stand-ins');
});

test('a prompt kept to 200 characters shows its ellipsis on a pane wide enough for all of it', () => {
  const ch = { key: 't1', kind: 'turn' as const, number: 1, prompt: promptOf('x'.repeat(500)), rows: [turnRow(1, 't1')] };
  for (const width of [240, 300]) assert.equal(headerLabel(ch, width).prompt, 'x'.repeat(MAX_PROMPT - 1) + '…', `${width} columns`);
});

test('a prompt is kept on one line, whitespace runs as single spaces, control characters shown, at most 200 characters', () => {
  assert.equal(promptOf('  Fix the\n\nlogin   bug.\t '), 'Fix the login bug.');
  assert.equal(promptOf(''), '');
  assert.equal(promptOf('fix \x1b[31merror\x1b[0m please\x07'), 'fix \u241b[31merror\u241b[0m please\u2407');
  assert.equal(promptOf('x'.repeat(MAX_PROMPT)), 'x'.repeat(MAX_PROMPT), 'exactly 200 is kept whole');
  assert.equal(promptOf('x'.repeat(500)), 'x'.repeat(MAX_PROMPT - 1) + '…');
  assert.equal(promptOf('x'.repeat(MAX_PROMPT - 2) + '😀x'), 'x'.repeat(MAX_PROMPT - 2) + '…', 'never half a surrogate pair');
});

test("a turn's chip sits on its last kept change's call, or on the Agent call that started it", () => {
  const main = { key: 't1', kind: 'turn' as const, number: 1, isEnded: true, rows: [turnRow(1, 't1', 'toolu_agent'), turnRow(2, 't1')] };
  assert.equal(turnChipAnchor(main), 'toolu_2');
  assert.equal(turnChipLabel(main), 'Play turn · 2 changes');
  const agent = { ...main, rows: [turnRow(1, 't1'), turnRow(2, 't1', 'toolu_agent')] };
  assert.equal(turnChipAnchor(agent), 'toolu_agent');
  assert.equal(turnChipLabel({ ...main, rows: [turnRow(1, 't1')] }), 'Play turn · 1 change');
});

test('only ended turns get a chip; a running turn, an earlier one and the changes in no turn get none', () => {
  const rows = [turnRow(1), turnRow(2, 't0'), turnRow(3, 't1'), turnRow(4, 't2')];
  const chips = turnChips(chaptersOf(listingFrom(rows), TURNS));
  assert.deepEqual([...chips].map(([anchor, ch]) => [anchor, ch.key]), [['toolu_3', 't1']]);
});

test('kept turns are the running one and those a change or agent names', () => {
  const turns = {
    next: 5,
    turns: [
      { turnId: 't1', number: 1, prompt: 'a', isEnded: true },
      { turnId: 't2', number: 2, prompt: 'b', isEnded: true },
      { turnId: 't3', number: 3, prompt: 'c', isEnded: true },
      { turnId: 't4', number: 4, prompt: 'd' },
    ],
  };
  assert.deepEqual(keptTurns(turns, new Set(['t2'])), { next: 5, turns: [turns.turns[1], turns.turns[3]] });
  const ended = { ...turns, turns: turns.turns.map((t) => ({ ...t, isEnded: true })) };
  assert.deepEqual(keptTurns(ended, new Set()).turns, [], 'an ended newest turn with no changes goes too');
});

// Captions: what the agent wrote before each Edit or Write call.

const say = (text: string): RowBlock => ({ type: 'text', text });
const call = (id: string, name = 'Edit'): RowBlock => ({ type: 'tool_use', id, name, input: {} });
const think: RowBlock = { type: 'thinking', thinking: 'hmm', signature: 's' };
const response = (content: RowBlock[], agentId?: string): HeardRow => ({ door: 'response', content, ...(agentId !== undefined && { agentId }) });
const result = (id: string, agentId?: string): HeardRow => ({
  door: 'tool-result',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  ...(agentId !== undefined && { agentId }),
});

/** Every caption the rows settle, in order, by call id. */
function captionsFrom(rows: HeardRow[], n: Narration = new Map()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) for (const [id, caption] of narrate(n, row)) out[id] = caption;
  return out;
}

test('a call takes the text written before it in the same response', () => {
  assert.deepEqual(captionsFrom([response([say("Now I'll guard the login route."), call('e1')])]), { e1: "Now I'll guard the login route." });
});

test('text between two calls goes to the second one', () => {
  const rows = [response([say('Add the limiter.'), call('w1', 'Write'), say('Export it.'), call('e1')])];
  assert.deepEqual(captionsFrom(rows), { w1: 'Add the limiter.', e1: 'Export it.' });
});

test('calls made together share the text before the first', () => {
  const rows = [response([say('Update both callers.'), call('e1'), call('e2')])];
  assert.deepEqual(captionsFrom(rows), { e1: 'Update both callers.', e2: 'Update both callers.' });
});

test('text before another tool does not reach a call in the next response', () => {
  const rows = [response([say('Let me read the file.'), call('r1', 'Read')]), result('r1'), response([call('e1')])];
  assert.deepEqual(captionsFrom(rows), {});
});

test('text after another tool in the same response goes to the call after it', () => {
  const rows = [response([say('Checking first.'), call('g1', 'Grep'), say('Fix the typo.'), call('e1')])];
  assert.deepEqual(captionsFrom(rows), { e1: 'Fix the typo.' });
});

test('thinking is never a caption', () => {
  assert.deepEqual(captionsFrom([response([think, call('e1')])]), {});
  assert.deepEqual(captionsFrom([response([say('Plan.'), think, call('e1')])]), { e1: 'Plan.' });
});

test('blank text is not a caption, and does not break a run of calls', () => {
  assert.deepEqual(captionsFrom([response([say('  \n'), call('e1')])]), {});
  assert.deepEqual(captionsFrom([response([say('Both.'), call('e1'), say(' '), call('e2')])]), { e1: 'Both.', e2: 'Both.' });
});

test('a response kept as a row per block gives the same captions as one row', () => {
  const blocks = [say('Add the limiter.'), call('w1', 'Write'), say('Export it.'), call('e1'), call('e2')];
  const expected = { w1: 'Add the limiter.', e1: 'Export it.', e2: 'Export it.' };
  assert.deepEqual(captionsFrom([response(blocks)]), expected);
  assert.deepEqual(captionsFrom(blocks.map((b) => response([b]))), expected);
});

test('a tool result kept between calls of one response ends the run: the later call has no caption', () => {
  const rows = [response([say('Both.'), call('e1')]), result('e1'), response([call('e2')])];
  assert.deepEqual(captionsFrom(rows), { e1: 'Both.' });
});

test("two loops' rows interleaved keep their own captions", () => {
  const rows = [
    response([say('Covering the refill.')], 'a1'),
    response([say('Signup gets the same guard.')], 'a2'),
    response([call('w1', 'Write')], 'a1'),
    response([call('e1')], 'a2'),
  ];
  assert.deepEqual(captionsFrom(rows), { w1: 'Covering the refill.', e1: 'Signup gets the same guard.' });
});

test("the main conversation's text before an Agent call does not reach the agent's calls", () => {
  const rows = [response([say("I'll hand the tests to a subagent."), call('ag', 'Agent')]), response([call('w1', 'Write')], 'a1')];
  assert.deepEqual(captionsFrom(rows), {});
});

test('a queued message changes nothing; a loop forgotten at its turn end starts fresh', () => {
  const n: Narration = new Map();
  assert.deepEqual(captionsFrom([response([say('Fix it.')]), { door: 'queue', content: [say('also this')] }, response([call('e1')])], n), { e1: 'Fix it.' });
  captionsFrom([response([say('Dangling.')])], n);
  forgetLoop(n, undefined);
  assert.deepEqual(captionsFrom([response([call('e2')])], n), {});
});

test('only Edit and Write calls are answered, and a block missing its id is skipped', () => {
  assert.deepEqual(captionsFrom([response([say('Run it.'), call('b1', 'Bash')])]), {});
  assert.deepEqual(captionsFrom([response([say('Odd.'), { type: 'tool_use', name: 'Edit' }])]), {});
});

test('a caption joins paragraphs with one space, shows control characters, and is cut to its limit', () => {
  assert.deepEqual(captionsFrom([response([say('First para.\n\nSecond\tpara.'), say('Third.'), call('e1')])]), { e1: 'First para. Second para. Third.' });
  assert.equal(normalizeCaption('a\u0007b'), 'a␇b');
  assert.equal(normalizeCaption(' \n '), undefined);
  const long = normalizeCaption('x'.repeat(5000))!;
  assert.equal(long.length, MAX_CAPTION);
  assert.ok(long.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(normalizeCaption('😀'.repeat(600))!), 'never ends on half a pair');
});

test('a caption rides with its change through playback, seek and a reload, and shows in the view and its row', () => {
  const d = deckOf({ ...change('a', 'x\n', 'y\n'), caption: 'Swap x for y.' }, change('b', 'p\n', 'q\n'));
  tick(d, FAST);
  assert.equal(viewOf(d).caption, 'Swap x for y.');
  assert.equal(listingOf(d).rows[0]!.caption, 'Swap x for y.');
  assert.equal('caption' in listingOf(d).rows[1]!, false);
  playOut(d);
  assert.equal(viewOf(d).caption, undefined, 'the last change shown has no caption');
  seek(d, 'a', FAST);
  assert.equal(viewOf(d).caption, 'Swap x for y.', 'cued while paused or not, it shows its caption');
  playOut(d);

  const saved = savedOf(d);
  assert.equal(JSON.stringify(saved).includes('Swap'), false, '`saved` keeps no caption');
  const back = restore(saved, withTexts(saved, [change('a', 'x\n', 'y\n'), change('b', 'p\n', 'q\n')]).map((c) => (c.id === 'a' ? { ...c, caption: 'Swap x for y.' } : c)), FAST);
  assert.deepEqual([...captionsOf(back)], [['a', 'Swap x for y.']]);
  seek(back, 'a', FAST);
  assert.equal(viewOf(back).caption, 'Swap x for y.');
});

test('a caption that arrives after its change is set on it, on the one being typed too, once', () => {
  const d = deckOf(change('a', 'x\n', 'y\n'.repeat(50)), change('b', 'p\n', 'q\n'));
  tick(d, FAST);
  assert.equal(playingId(d), 'a');
  assert.equal(setCaption(d, 'a', 'Grow it.'), true);
  assert.equal(viewOf(d).caption, 'Grow it.');
  assert.equal(setCaption(d, 'a', 'Again.'), false);
  assert.equal(setCaption(d, 'b', 'Next.'), true);
  assert.equal(setCaption(d, 'gone', 'No.'), false);
  assert.deepEqual([...captionsOf(d)], [['a', 'Grow it.'], ['b', 'Next.']]);
  playOut(d);
  assert.equal(viewOf(d).caption, 'Next.');
});

test("a row's caption is cut for the card", () => {
  const d = deckOf({ ...change('a', 'x\n', 'y\n'), caption: 'w '.repeat(400).trim() });
  const row = listingOf(d).rows[0]!;
  assert.equal(row.caption!.length, MAX_ROW_CAPTION);
  assert.ok(row.caption!.endsWith('…'));
});

test('a too-large change keeps its caption in the view', () => {
  const d = deckOf({ ...change('big', '', ''), isTooLarge: true, caption: 'Regenerate the lockfile.' });
  tick(d, FAST);
  assert.equal(viewOf(d).isTooLarge, true);
  assert.equal(viewOf(d).caption, 'Regenerate the lockfile.');
});

test('caption lines wrap at spaces and cut the last with an ellipsis', () => {
  assert.deepEqual(captionLines('Short one.', 20, 3), ['Short one.']);
  assert.deepEqual(captionLines('exactly ten', 11, 3), ['exactly ten']);
  assert.deepEqual(captionLines('one two three four', 9, 3), ['one two', 'three', 'four']);
  assert.deepEqual(captionLines('one two three four five six seven', 9, 2), ['one two', 'three fo…']);
  assert.deepEqual(captionLines('abcdefghijklmnop', 5, 3), ['abcde', 'fghij', 'klmn…']);
  assert.deepEqual(captionLines('abcdefghij', 5, 3), ['abcde', 'fghij']);
  for (const lines of [captionLines('word '.repeat(100), 17, 3), captionLines('x'.repeat(100), 17, 3)]) {
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => cellWidth(l) <= 17));
    assert.ok(lines[2]!.endsWith('…'));
  }
});

test('caption lines count wide characters as two cells', () => {
  assert.equal(cellWidth('abc'), 3);
  assert.equal(cellWidth('日本語'), 6);
  assert.equal(cellWidth('한글'), 4);
  assert.equal(cellWidth('ＡＢ'), 4);
  assert.equal(cellWidth('🎉 ok'), 5);
  assert.deepEqual(captionLines('あ'.repeat(30), 10, 3), ['あああああ', 'あああああ', 'ああああ…']);
  assert.deepEqual(captionLines('🎉'.repeat(10), 7, 3), ['🎉🎉🎉', '🎉🎉🎉', '🎉🎉🎉…']);
  assert.deepEqual(captionLines('Fix 日本語 and 中文 text', 10, 3), ['Fix 日本語', 'and 中文', 'text']);
  // A wide character that would cross the edge moves to the next line whole.
  assert.deepEqual(captionLines('ab日本', 3, 3), ['ab', '日', '本']);
  for (const text of ['認証'.repeat(40), '🎉 '.repeat(40), 'x日'.repeat(40)]) {
    const lines = captionLines(text, 17, 3);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => cellWidth(l) <= 17), JSON.stringify(lines));
    assert.ok(lines[2]!.endsWith('…'));
  }
});
