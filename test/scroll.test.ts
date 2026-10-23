import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCROLL_FRAME_MS, SCROLL_MAX_MS, centeredTop, scrollSteps } from '../src/scroll';

const maxFrames = (speed: number) => Math.ceil(SCROLL_MAX_MS / speed / SCROLL_FRAME_MS);

test('no steps when the view is already there', () => {
  assert.deepEqual(scrollSteps(40, 40, 30, 60, 1), []);
});

test('steps end at the target and move one way, down or up', () => {
  for (const [from, to] of [[0, 45], [45, 0], [10, 11], [100, 99]]) {
    const steps = scrollSteps(from, to, 30, 60, 1);
    assert.equal(steps[steps.length - 1], to);
    const dir = Math.sign(to - from);
    let prev = from;
    for (const top of steps) {
      assert.ok((top - prev) * dir >= 0, `step ${prev} -> ${top} goes the wrong way`);
      prev = top;
    }
  }
});

test('a short scroll takes several frames at the configured speed', () => {
  // 45 lines at 60 lines per second is 750 ms, 45 frames.
  const steps = scrollSteps(0, 45, 30, 60, 1);
  assert.equal(steps.length, 45);
  assert.ok(new Set(steps).size > 10, 'scroll should pass through many positions');
});

test('far targets jump to two viewports short, then scroll the rest', () => {
  const steps = scrollSteps(0, 5000, 30, 60, 1);
  assert.equal(steps[0], 4940);
  assert.ok(steps.slice(1).every((t) => t >= 4940 && t <= 5000));
  assert.ok(steps.length - 1 <= maxFrames(1));
  const up = scrollSteps(5000, 0, 30, 60, 1);
  assert.equal(up[0], 60);
});

test('a scroll lasts at most one second at 1x, and half as long at 2x', () => {
  assert.ok(scrollSteps(0, 59, 30, 1, 1).length <= maxFrames(1));
  const slow = scrollSteps(0, 50, 30, 30, 1).length;
  const fast = scrollSteps(0, 50, 30, 30, 2).length;
  assert.equal(slow, maxFrames(1));
  assert.equal(fast, maxFrames(2));
});

test('centeredTop centers the line and stays inside the document', () => {
  assert.equal(centeredTop(100, 30, 400), 85);
  assert.equal(centeredTop(3, 30, 400), 0);
  assert.equal(centeredTop(395, 30, 400), 370);
  assert.equal(centeredTop(5, 30, 10), 0);
});
