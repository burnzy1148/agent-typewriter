import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPauseLeft, resolveReadPauseSeconds } from '../src/readPause';

// Layers are workspace, repository file, user settings: highest priority first.

test('nothing set gives the 1.5 s default', () => {
  assert.deepEqual(resolveReadPauseSeconds([{}, {}, {}]), { readPauseSeconds: 1.5, fromDeprecated: false });
});

test('readPauseSeconds alone is used as is', () => {
  assert.deepEqual(resolveReadPauseSeconds([{}, {}, { readPauseSeconds: 4 }]), { readPauseSeconds: 4, fromDeprecated: false });
});

test('scrollPauseMs alone counts divided by 1000 and is marked deprecated', () => {
  assert.deepEqual(resolveReadPauseSeconds([{}, {}, { scrollPauseMs: 800 }]), { readPauseSeconds: 0.8, fromDeprecated: true });
});

test('readPauseSeconds beats scrollPauseMs in the same layer', () => {
  assert.deepEqual(resolveReadPauseSeconds([{ scrollPauseMs: 800, readPauseSeconds: 5 }]), { readPauseSeconds: 5, fromDeprecated: false });
});

test("a higher layer's readPauseSeconds beats a lower layer's scrollPauseMs", () => {
  assert.deepEqual(resolveReadPauseSeconds([{ readPauseSeconds: 2 }, {}, { scrollPauseMs: 800 }]), { readPauseSeconds: 2, fromDeprecated: false });
});

test("a higher layer's scrollPauseMs beats a lower layer's readPauseSeconds", () => {
  assert.deepEqual(resolveReadPauseSeconds([{ scrollPauseMs: 800 }, {}, { readPauseSeconds: 2 }]), { readPauseSeconds: 0.8, fromDeprecated: true });
});

test('wrong-typed values count as unset', () => {
  assert.deepEqual(resolveReadPauseSeconds([{ readPauseSeconds: 'long', scrollPauseMs: null }, { readPauseSeconds: NaN }, { readPauseSeconds: 2 }]), {
    readPauseSeconds: 2,
    fromDeprecated: false,
  });
});

test('values are clamped to 0 to 15 s', () => {
  assert.equal(resolveReadPauseSeconds([{ readPauseSeconds: 40 }]).readPauseSeconds, 15);
  assert.equal(resolveReadPauseSeconds([{ readPauseSeconds: -1 }]).readPauseSeconds, 0);
  assert.equal(resolveReadPauseSeconds([{ scrollPauseMs: 60000 }]).readPauseSeconds, 15);
});

test('readPauseLeft is the remainder of the pause', () => {
  assert.equal(readPauseLeft(1000, 1500, 1.5, 1), 1000);
});

test('readPauseLeft is 0 once the pause has passed', () => {
  assert.equal(readPauseLeft(1000, 2500, 1.5, 1), 0);
  assert.equal(readPauseLeft(1000, 11000, 1.5, 1), 0);
});

test('readPauseLeft is half as long at 2x', () => {
  assert.equal(readPauseLeft(1000, 1000, 3, 2), 1500);
});

test('readPauseLeft is 0 when the pause is off', () => {
  assert.equal(readPauseLeft(1000, 1000, 0, 1), 0);
});
