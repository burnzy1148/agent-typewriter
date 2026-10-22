import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReorderBuffer, clampOrderKey, resolveReorderWindow, type Scheduler } from '../src/reorder';

/**
 * Manual clock: timers fire only when advance() passes them. `offset` moves
 * the wall clock alone, the way a clock step leaves Node's timers untouched.
 */
class FakeClock implements Scheduler {
  t = 0;
  offset = 0;
  readonly requested: number[] = [];
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now() {
    return this.t + this.offset;
  }
  setTimeout(fn: () => void, ms: number) {
    this.requested.push(ms);
    this.timers.set(++this.id, { at: this.t + ms, fn });
    return this.id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

function setup(window = 100) {
  const clock = new FakeClock();
  const out: string[] = [];
  const buf = new ReorderBuffer<string>((items) => out.push(...items), () => window, clock);
  return { clock, out, buf };
}

test('reorder: holds items until key + window', () => {
  const { clock, out, buf } = setup();
  clock.t = 1000;
  buf.add('a', 1000, 'a');
  clock.advance(99);
  assert.deepEqual(out, []);
  clock.advance(1);
  assert.deepEqual(out, ['a']);
});

test('reorder: releases in key order, not arrival order', () => {
  const { clock, out, buf } = setup();
  clock.t = 1050;
  buf.add('b', 1040, 'b');
  buf.add('a', 1010, 'a');
  buf.add('c', 1045, 'c');
  clock.advance(200);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('reorder: equal keys keep insertion order', () => {
  const { clock, out, buf } = setup();
  clock.t = 500;
  buf.add('x', 500, 'x');
  buf.add('y', 500, 'y');
  buf.add('z', 500, 'z');
  clock.advance(100);
  assert.deepEqual(out, ['x', 'y', 'z']);
});

test('reorder: a zero window releases synchronously', () => {
  const { clock, out, buf } = setup(0);
  clock.t = 10;
  buf.add('a', 10, 'a');
  assert.deepEqual(out, ['a']);
  assert.equal(buf.size, 0);
});

test('reorder: a zero window ignores pending bursts', () => {
  const { clock, out, buf } = setup(0);
  clock.t = 10;
  buf.pending(5);
  buf.add('a', 10, 'a');
  assert.deepEqual(out, ['a']);
});

test('reorder: a due item waits for an earlier pending burst', () => {
  const { clock, out, buf } = setup();
  clock.t = 1000;
  const done = buf.pending(1020);
  buf.add('later', 1010, 'later');
  clock.advance(150);
  assert.deepEqual(out, [], 'released while an earlier burst was pending');
  buf.add('earlier', 1005, 'earlier');
  done();
  clock.advance(0);
  assert.deepEqual(out, ['earlier', 'later']);
});

test('reorder: a pending burst that arrived after the window does not block', () => {
  const { clock, out, buf } = setup();
  clock.t = 1000;
  buf.pending(1200);
  buf.add('a', 1000, 'a');
  clock.advance(100);
  assert.deepEqual(out, ['a']);
});

test('reorder: a burst that never finishes blocks only until key + 2 × window', () => {
  const { clock, out, buf } = setup();
  clock.t = 1000;
  buf.pending(1000);
  buf.add('a', 1000, 'a');
  clock.advance(199);
  assert.deepEqual(out, []);
  clock.advance(1);
  assert.deepEqual(out, ['a']);
});

test('reorder: a later same-file item with an earlier key is still released second', () => {
  const { clock, out, buf } = setup();
  clock.t = 1000;
  buf.add('f#1', 1000, 'f');
  buf.add('g', 990, 'g');
  buf.add('f#2', 900, 'f');
  clock.advance(500);
  assert.deepEqual(out, ['g', 'f#1', 'f#2']);
});

test('reorder: an item added a debounce after its write still waits for an earlier burst', () => {
  const { clock, out, buf } = setup(100);
  clock.t = 1005;
  const doneB = buf.pending(1005);
  clock.t = 1010;
  const doneA = buf.pending(1010);
  clock.t = 1205;
  buf.add('b', 1000, 'b');
  clock.advance(5);
  buf.add('a', 950, 'a');
  doneA();
  doneB();
  clock.advance(500);
  assert.deepEqual(out, ['a', 'b']);
});

test('reorder: with the default window, a burst read 300 ms later still lands first', () => {
  const { clock, out, buf } = setup(250);
  clock.t = 1005;
  const doneB = buf.pending(1005);
  clock.t = 1205;
  buf.add('b', 1000, 'b');
  doneB();
  clock.advance(35);
  const doneA = buf.pending(1240);
  clock.advance(270);
  assert.deepEqual(out, [], 'released while an earlier burst was pending');
  buf.add('a', 990, 'a');
  doneA();
  clock.advance(500);
  assert.deepEqual(out, ['a', 'b']);
});

test('reorder: a burst that never finishes blocks at most 2 × window after the add', () => {
  const { clock, out, buf } = setup(100);
  clock.t = 1000;
  buf.pending(1000);
  clock.t = 1300;
  buf.add('a', 1000, 'a');
  clock.advance(199);
  assert.deepEqual(out, []);
  clock.advance(1);
  assert.deepEqual(out, ['a']);
});

for (const window of [100, 0]) {
  test(`reorder: a backward clock step after a drain does not hold a file (window ${window})`, () => {
    const { clock, out, buf } = setup(window);
    clock.t = 1000;
    buf.add('A1', 1000, 'A');
    clock.advance(window);
    buf.drain();
    clock.t -= 3_600_000;
    buf.add('A2', clock.t + 100, 'A');
    buf.add('B1', clock.t + 200, 'B');
    if (window === 0) assert.deepEqual(out, ['A1', 'A2', 'B1'], 'zero window released late');
    clock.advance(window + 1);
    assert.deepEqual(out, ['A1', 'A2', 'B1']);
    assert.equal(buf.size, 0);
  });
}

test('reorder: a backward clock step while an item is held does not hold it for the step', () => {
  const { clock, out, buf } = setup(100);
  clock.t = 1000;
  buf.add('A2', 1000, 'A');
  clock.advance(50);
  clock.offset -= 3_600_000;
  buf.add('B1', clock.now(), 'B');
  clock.advance(200);
  assert.deepEqual(out, ['A2', 'B1']);
  assert.ok(clock.requested.every((ms) => ms <= 2 ** 31 - 1), `delays ${clock.requested.join(', ')}`);
});

test('reorder: a backward step of more than 24.8 days asks for no oversized timer', () => {
  const { clock, out, buf } = setup(100);
  clock.t = 1000;
  buf.add('A', 1000, 'A');
  clock.offset -= 30 * 86_400_000;
  clock.advance(300);
  assert.deepEqual(out, ['A']);
  assert.ok(clock.requested.every((ms) => ms <= 2 ** 31 - 1), `delays ${clock.requested.join(', ')}`);
});

test('reorder: a window longer than 24.8 days asks for no oversized timer', () => {
  const { clock, out, buf } = setup(3_000_000_000);
  clock.t = 1000;
  buf.add('A', 1000, 'A');
  assert.deepEqual(out, []);
  assert.deepEqual(clock.requested, [2 ** 31 - 1]);
});

test('reorder: drain releases everything held, in order', () => {
  const { clock, out, buf } = setup(10_000);
  clock.t = 100;
  buf.add('b', 90, 'b');
  buf.add('a', 80, 'a');
  buf.drain();
  assert.deepEqual(out, ['a', 'b']);
  assert.equal(buf.size, 0);
  clock.advance(20_000);
  assert.deepEqual(out, ['a', 'b'], 'drained items released twice');
});

test('clampOrderKey: in-range mtime is kept', () => {
  assert.equal(clampOrderKey(950, 1000, 1100, 250), 950);
});

test('clampOrderKey: mtime after the last watcher event is capped', () => {
  assert.equal(clampOrderKey(5000, 1000, 1100, 250), 1100);
});

test('clampOrderKey: a very old mtime is floored at firstArrival - window', () => {
  assert.equal(clampOrderKey(1, 1000, 1100, 250), 750);
});

test('clampOrderKey: a non-finite mtime uses first arrival', () => {
  assert.equal(clampOrderKey(Number.NaN, 1000, 1100, 250), 1000);
});

test('resolveReorderWindow: auto by platform', () => {
  assert.equal(resolveReorderWindow('auto', 'win32'), 2500);
  assert.equal(resolveReorderWindow('auto', 'darwin'), 250);
  assert.equal(resolveReorderWindow('auto', 'linux'), 250);
});

test('resolveReorderWindow: fixed numbers, including zero', () => {
  assert.equal(resolveReorderWindow(1000, 'win32'), 1000);
  assert.equal(resolveReorderWindow(0, 'darwin'), 0);
});

test('resolveReorderWindow: invalid values fall back to auto', () => {
  for (const v of [-5, 'fast', Number.NaN, Infinity, null, undefined, {}]) {
    assert.equal(resolveReorderWindow(v, 'linux'), 250, String(v));
    assert.equal(resolveReorderWindow(v, 'win32'), 2500, String(v));
  }
});
