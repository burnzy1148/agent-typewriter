import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFiniteNumber, numberSetting } from '../src/numberSetting';

test('values that are not finite numbers give the default', () => {
  for (const bad of ['fast', 'auto', '40', {}, [], null, undefined, true, NaN, Infinity, -Infinity]) {
    assert.equal(numberSetting(bad, 35, 1), 35, `${String(bad)} did not fall back`);
    assert.equal(isFiniteNumber(bad), false);
  }
});

test('valid numbers pass through, clamped', () => {
  assert.equal(numberSetting(50, 35, 1), 50);
  assert.equal(numberSetting(0, 35, 1), 1);
  assert.equal(numberSetting(-5, 0.5, 0), 0);
  assert.equal(numberSetting(1.5, 0.6, 0, 1), 1);
  assert.equal(numberSetting(-0.2, 0.6, 0, 1), 0);
  assert.equal(numberSetting(0.3, 0.6, 0, 1), 0.3);
  assert.equal(numberSetting(3, 500, 10), 10);
  assert.equal(numberSetting(-100, 6000), -100, 'no bounds means no clamp');
});

test('the default is clamped too', () => {
  assert.equal(numberSetting('x', 0, 1), 1);
});
