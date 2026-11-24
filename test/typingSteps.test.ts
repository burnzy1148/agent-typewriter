import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBACK_NUMBERS, PLAYBACK_SWITCHES, type PlaybackSettings } from '../src/playbackSettings';
import { lfOffsetToLineCol } from '../src/planner';
import { ARRIVE_MS, DELETE_FILE_MS, MAX_WAIT_MS, SELECT_MS, caretBeforeHunk, typingSteps, type TypingSettings, type TypingStep } from '../src/typingSteps';
import { splitsPair } from '../src/typingChunks';

const defaults: PlaybackSettings = {
  ...(Object.fromEntries(Object.entries(PLAYBACK_NUMBERS).map(([k, v]) => [k, v.default])) as Record<keyof typeof PLAYBACK_NUMBERS, number>),
  ...PLAYBACK_SWITCHES,
  languageSpeeds: {},
};

type Run = {
  steps: TypingStep[];
  text: string;
  caret: number;
};

type Script = {
  settings?: Partial<TypingSettings>;
  speed?: number | ((step: number) => number);
  /** Finish now turns on before the step with this index is pulled. */
  finishAt?: number;
  inView?: (first: number, last: number, text: string) => boolean | undefined;
  start?: { switching: boolean; jump: boolean };
  caret?: number;
  random?: () => number;
  kind?: string;
};

/** Pulls every step, applying edits and caret moves the way a frontend does, so the host reports live state. */
function run(before: string, after: string, o: Script = {}): Run {
  const settings: TypingSettings = { ...defaults, charsPerMinute: 1000, ...o.settings };
  let text = before;
  let caret = o.caret ?? 0;
  let finishing = false;
  const steps: TypingStep[] = [];
  const host = {
    settings: () => settings,
    speed: () => (typeof o.speed === 'function' ? o.speed(steps.length) : (o.speed ?? 1)),
    finishing: () => finishing,
    caret: () => lfOffsetToLineCol(text, caret),
    inView: (first: number, last: number) => (o.inView ? o.inView(first, last, text) : true),
    languageId: () => '',
  };
  const gen = typingSteps({ before, after, kind: o.kind ?? 'modify' }, o.start ?? { switching: false, jump: false }, host, o.random ?? (() => 0.5));
  for (;;) {
    if (o.finishAt !== undefined && steps.length >= o.finishAt) finishing = true;
    const r = gen.next();
    if (r.done) break;
    const s = r.value;
    steps.push(s);
    if (s.kind === 'delete') {
      assert.ok(s.from >= 0 && s.from <= s.to && s.to <= text.length, `delete in range: ${JSON.stringify(s)}`);
      assert.ok(!splitsPair(text, s.from) && !splitsPair(text, s.to), 'delete never splits a pair');
      text = text.slice(0, s.from) + text.slice(s.to);
      caret = s.from;
    } else if (s.kind === 'insert') {
      assert.ok(s.at >= 0 && s.at <= text.length, `insert in range: ${JSON.stringify(s)}`);
      assert.ok(!splitsPair(text, s.at), 'insert never splits a pair');
      text = text.slice(0, s.at) + s.text + text.slice(s.at);
      caret = s.at + s.text.length;
    } else if (s.kind === 'replace') {
      text = s.text;
    } else if (s.kind === 'caret') {
      assert.ok(s.at >= 0 && s.at <= text.length, `caret in range: ${JSON.stringify(s)}`);
      caret = s.at;
    } else if (s.kind === 'wait') {
      assert.ok(s.ms > 0 && s.ms <= MAX_WAIT_MS);
    }
  }
  return { steps, text, caret };
}

const kinds = (r: Run) => r.steps.map((s) => s.kind);
const waits = (r: Run) => r.steps.flatMap((s) => (s.kind === 'wait' ? [s.ms] : []));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const edits = (r: Run) => r.steps.filter((s) => s.kind === 'delete' || s.kind === 'insert' || s.kind === 'replace');

test('caret start: after a short deletion, at the start of a long or multi-line one, where an insertion goes', () => {
  assert.equal(caretBeforeHunk({ offset: 4, deleteText: 'total', insertText: 'sum' }), 9);
  assert.equal(caretBeforeHunk({ offset: 4, deleteText: 'x'.repeat(25), insertText: '' }), 4);
  assert.equal(caretBeforeHunk({ offset: 4, deleteText: 'a\nb', insertText: '' }), 4);
  assert.equal(caretBeforeHunk({ offset: 4, deleteText: '', insertText: 'y' }), 4);
});

test('a short deletion is backspaced from its end, its mark shrinking, then the mark comes down', () => {
  const r = run('let total = 1;\n', 'let sum = 1;\n', { settings: { jitter: 0 } });
  assert.deepEqual(r.steps.find((s) => s.kind === 'mark'), { kind: 'mark', from: 4, to: 9, oneStep: false });
  const deletes = r.steps.filter((s) => s.kind === 'delete');
  assert.ok(deletes.length >= 2, 'in several steps');
  assert.equal((deletes[0] as { to: number }).to, 9, 'from the end');
  assert.ok(!r.steps.some((s) => s.kind === 'select'));
  const lastMark = r.steps.filter((s) => s.kind === 'mark').at(-1);
  assert.deepEqual(lastMark, { kind: 'mark', from: 4, to: 4, oneStep: false });
  assert.equal(r.text, 'let sum = 1;\n');
});

test('a long deletion is marked, selected, held for the select beat, selected again, then deleted in one step', () => {
  const body = 'x'.repeat(60) + '\n';
  const r = run(`a\n${body}b\n`, 'a\nb\n', { settings: { jitter: 0 } });
  const i = r.steps.findIndex((s) => s.kind === 'select');
  assert.deepEqual(r.steps.slice(i, i + 4), [
    { kind: 'select', from: 2, to: 63, reveal: true },
    { kind: 'wait', ms: SELECT_MS },
    { kind: 'select', from: 2, to: 63, reveal: true },
    { kind: 'delete', from: 2, to: 63 },
  ]);
  assert.ok(r.steps.some((s) => s.kind === 'mark' && s.oneStep && s.to === 63));
});

test('the beat when the caret arrives comes before every edit and is divided by the speed', () => {
  const r = run('a\nb\nc\n', 'aX\nb\ncY\n', { settings: { jitter: 0, naturalOrder: false }, speed: 2 });
  assert.equal(waits(r).filter((ms) => ms === ARRIVE_MS / 2).length, 2);
});

test('a new line’s indent goes in at once, with no wait after it', () => {
  const r = run('f {\n}\n', 'f {\n    body;\n}\n', { settings: { jitter: 0 }, random: () => 0.99 });
  const at = r.steps.findIndex((s) => s.kind === 'insert' && s.text === '    ');
  assert.ok(at >= 0, 'indent inserted whole');
  assert.notEqual(r.steps[at + 1]?.kind, 'wait');
});

test('chunks follow characters per tick at 60 Hz', () => {
  const slow = run('', 'abcdefghij', { settings: { jitter: 0 } });
  assert.ok(slow.steps.filter((s) => s.kind === 'insert').every((s) => (s as { text: string }).text.length === 1));
  const fast = run('', 'abcdefghijklmnopqrstuvwxyz', { settings: { jitter: 0, charsPerMinute: 36000 } });
  assert.ok(fast.steps.filter((s) => s.kind === 'insert').every((s) => (s as { text: string }).text.length <= 10));
  assert.ok(fast.steps.some((s) => s.kind === 'insert' && s.text.length === 10));
});

test('jitter 0 gives exact per-character waits; jitter varies them within 48% either way', () => {
  const exact = run('', 'abc', { settings: { jitter: 0 } });
  assert.ok(waits(exact).slice(1).every((ms) => near(ms, 60)));
  const low = run('', 'abc', { random: () => 0 });
  assert.ok(waits(low).slice(1).every((ms) => Math.abs(ms - 60 * 0.52) < 1e-9));
  const high = run('', 'abc', { random: () => 0.999999 });
  assert.ok(waits(high).slice(1).every((ms) => ms > 60 * 1.479 && ms <= 60 * 1.48));
});

test('a line break, punctuation and the thinking pause add their time', () => {
  const nl = run('', 'a\n', { settings: { jitter: 0 } });
  // 'a' and '\n' are typed one at a time at 1000 per minute: the break's own 60 ms, plus two characters' time.
  assert.ok(near(waits(nl).at(-1)!, 60 * 3));
  const brk = run('', 'a\n', { settings: { jitter: 1 }, random: () => 0.01 });
  // humanize low, plus 2 + 0.04 per-char, plus a thinking pause (0.01 < 0.04).
  assert.ok(waits(brk).at(-1)! > 300);
  const semi = run('', ';', { settings: { jitter: 0 }, random: () => 0.5 });
  assert.ok(near(waits(semi).at(-1)!, 60 + 60 * 1.5 * 0.5));
  const letter = run('', 'a', { settings: { jitter: 0 }, random: () => 0.5 });
  assert.ok(near(waits(letter).at(-1)!, 60));
});

test('waits are divided by the speed read at the moment each is decided', () => {
  const r = run('', 'abcdef', { settings: { jitter: 0 }, speed: (n) => (n < 6 ? 1 : 3) });
  const w = waits(r).slice(1);
  assert.ok(near(w[0]!, 60));
  assert.ok(near(w.at(-1)!, 20));
});

test('more than maxAnimatedChars is replaced at once and marked added', () => {
  const after = 'x'.repeat(50);
  const r = run('', after, { settings: { maxAnimatedChars: 10 } });
  assert.deepEqual(r.steps, [{ kind: 'show' }, { kind: 'replace', text: after }, { kind: 'added', from: 0, to: 50 }]);
});

test('a deleted file is selected and marked whole, held, then deleted', () => {
  const r = run('abc\ndef\n', '', { kind: 'delete', settings: { jitter: 0 } });
  assert.deepEqual(r.steps, [
    { kind: 'show' },
    { kind: 'select', from: 0, to: 8, reveal: false },
    { kind: 'mark', from: 0, to: 8, oneStep: true },
    { kind: 'wait', ms: DELETE_FILE_MS },
    { kind: 'delete', from: 0, to: 8 },
    { kind: 'mark', from: 0, to: 0, oneStep: true },
  ]);
});

test('a file switch reads first, shows, then waits the file-switch delay, capped at 15 s', () => {
  const r = run('', 'a', { start: { switching: true, jump: true }, settings: { jitter: 0 } });
  assert.deepEqual(r.steps.slice(0, 3), [{ kind: 'readPause' }, { kind: 'show' }, { kind: 'wait', ms: 1000 }]);
  const slow = run('', 'a', { start: { switching: true, jump: true }, settings: { fileSwitchDelayMs: 15000 }, speed: 0.5 });
  assert.deepEqual(slow.steps[2], { kind: 'wait', ms: MAX_WAIT_MS });
  const same = run('', 'a', { start: { switching: false, jump: false } });
  assert.deepEqual(same.steps[0], { kind: 'show' });
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

test('an off-screen edit waits for the read pause, then may scroll; an in-view one does not', () => {
  const before = lines(400);
  const after = before.replace('line 3\n', 'line 3!\n').replace('line 350\n', 'line 350!\n');
  // Rows 0-39 are in view until the caret goes past them.
  const view = (first: number, last: number) => first >= 0 && last < 40;
  const r = run(before, after, { inView: view, settings: { naturalOrder: false } });
  const i = r.steps.findIndex((s) => s.kind === 'readPause');
  assert.ok(i > 0);
  assert.equal(r.steps[i + 1]!.kind, 'reveal');
  assert.equal((r.steps[i + 1] as { scroll: boolean }).scroll, true);
  assert.equal(r.steps.filter((s) => s.kind === 'readPause').length, 1, 'line 3 is in view: no read pause for it' + JSON.stringify(r.steps.filter((s) => s.kind !== 'wait')));
});

test('no read pause for the first edit after a jump, without a viewport, or for a move within a block typed outside in', () => {
  const before = lines(400);
  const after = before.replace('line 350\n', 'line 350!\n');
  assert.ok(!kinds(run(before, after, { start: { switching: false, jump: true }, inView: () => false })).includes('readPause'));
  assert.ok(!kinds(run(before, after, { inView: () => undefined })).includes('readPause'));
  // A whole block: its closing line is typed, then the body, a move that continues the typing.
  const block = run('x\n', 'x\nf() {\n' + '  a;\n'.repeat(80) + '}\n', { inView: (f, l) => l - f < 5 && l < 10 });
  assert.ok(!kinds(block).includes('readPause'));
});

test('the caret walks with arrow keys only when both ends are in view and within 24 presses', () => {
  const before = lines(40);
  const after = before.replace('line 8\n', 'line 8!\n');
  const near = run(before, after, { caret: before.indexOf('line 2') + 6, settings: { jitter: 0 } });
  const keys = near.steps.filter((s) => s.kind === 'caret');
  assert.ok(keys.length >= 6, 'a press per line, then the edit');
  assert.ok(waits(near).includes(1000 / 15));
  const out = run(before, after, { caret: before.indexOf('line 2'), inView: () => false });
  assert.equal(out.steps.filter((s) => s.kind === 'caret').length, 1, 'clicked');
  const off = run(before, after, { caret: before.indexOf('line 2'), settings: { arrowNavigation: false } });
  assert.equal(off.steps.filter((s) => s.kind === 'caret').length, 1, 'arrow navigation off');
  const far = lines(100);
  const farAfter = far.replace('line 90\n', 'line 90!\n');
  assert.equal(run(far, farAfter, { caret: 0 }).steps.filter((s) => s.kind === 'caret').length, 1, 'more than 24 presses: clicked');
});

test('finish now before an edit brings it into view, clicks there, and replaces the rest', () => {
  const before = lines(20);
  const after = before.replace('line 2\n', 'line 2!\n').replace('line 15\n', 'line 15!\n');
  const r = run(before, after, { finishAt: 1, settings: { naturalOrder: false } });
  assert.deepEqual(kinds(r).slice(1), ['reveal', 'caret', 'reveal', 'replace']);
  assert.equal(r.text, after);
});

test('finish now mid-typing inserts the rest at once, with no added mark', () => {
  const r = run('', 'abcdefghijklmnop', { finishAt: 8 });
  assert.equal(r.text, 'abcdefghijklmnop');
  const last = edits(r).at(-1) as { kind: string; text: string };
  assert.equal(last.kind, 'insert');
  assert.ok(last.text.length > 1);
  assert.ok(!kinds(r).includes('added'));
});

test('finish now mid-backspace deletes the rest selected, without the select beat', () => {
  const r = run('let total = 1;\n', 'let s = 1;\n', { finishAt: 10, settings: { jitter: 0 } });
  const i = r.steps.findIndex((s) => s.kind === 'select');
  assert.ok(i > 0);
  assert.equal(r.steps[i + 1]!.kind, 'delete');
  assert.equal(r.text, 'let s = 1;\n');
});

test('finish now pressed as the long deletion is selected skips the select beat', () => {
  const before = 'a\n' + 'x'.repeat(60) + '\nb\n';
  const probe = run(before, 'a\nb\n');
  const at = probe.steps.findIndex((s) => s.kind === 'select');
  const r = run(before, 'a\nb\n', { finishAt: at + 1 });
  assert.equal(r.text, 'a\nb\n');
  assert.equal(r.steps.filter((s) => s.kind === 'select').length, 1);
  assert.equal(r.steps[at + 1]!.kind, 'delete');
});

test('a settings change takes effect from the next step', () => {
  const settings: TypingSettings = { ...defaults, charsPerMinute: 1000, jitter: 0 };
  let caret = 0;
  let text = '';
  const gen = typingSteps(
    { before: '', after: 'abcd', kind: 'modify' },
    { switching: false, jump: false },
    { settings: () => settings, speed: () => 1, finishing: () => false, caret: () => lfOffsetToLineCol(text, caret), inView: () => true, languageId: () => '' },
    () => 0.5,
  );
  const w: number[] = [];
  for (const s of gen) {
    if (s.kind === 'insert') {
      text = text.slice(0, s.at) + s.text + text.slice(s.at);
      caret = s.at + s.text.length;
      settings.charsPerMinute = 2000;
    }
    if (s.kind === 'wait') w.push(s.ms);
  }
  assert.ok(near(w.at(-1)!, 30));
});
