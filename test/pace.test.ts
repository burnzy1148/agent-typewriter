import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseCharsPerSecond } from '../src/pace';

test('no per-language speeds uses charsPerSecond', () => {
  assert.equal(baseCharsPerSecond('typescript', 35, {}), 35);
});

test('unlisted language uses charsPerSecond', () => {
  assert.equal(baseCharsPerSecond('typescript', 35, { markdown: 60 }), 35);
});

test('listed language uses its own speed', () => {
  assert.equal(baseCharsPerSecond('markdown', 35, { markdown: 60 }), 60);
});

test('switching languages picks each one independently', () => {
  const speeds = { json: 120 };
  assert.equal(baseCharsPerSecond('json', 35, speeds), 120);
  assert.equal(baseCharsPerSecond('typescript', 35, speeds), 35);
});

test('zero, negative, non-numeric and non-finite values are ignored', () => {
  const speeds = { markdown: 0, json: -5, yaml: 'fast', css: Infinity, html: NaN };
  for (const id of Object.keys(speeds)) {
    assert.equal(baseCharsPerSecond(id, 35, speeds), 35, id);
  }
});

test('language ids match exactly', () => {
  assert.equal(baseCharsPerSecond('markdown', 35, { Markdown: 60 }), 35);
});

test('inherited object keys are not treated as entries', () => {
  assert.equal(baseCharsPerSecond('constructor', 35, {}), 35);
});
