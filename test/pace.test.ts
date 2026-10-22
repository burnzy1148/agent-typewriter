import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseCharsPerMinute, resolveCharsPerMinute } from '../src/pace';

test('no per-language speeds uses charsPerMinute', () => {
  assert.equal(baseCharsPerMinute('typescript', 350, {}), 350);
});

test('unlisted language uses charsPerMinute', () => {
  assert.equal(baseCharsPerMinute('typescript', 350, { markdown: 600 }), 350);
});

test('listed language uses its own speed', () => {
  assert.equal(baseCharsPerMinute('markdown', 350, { markdown: 600 }), 600);
});

test('switching languages picks each one independently', () => {
  const speeds = { json: 1200 };
  assert.equal(baseCharsPerMinute('json', 350, speeds), 1200);
  assert.equal(baseCharsPerMinute('typescript', 350, speeds), 350);
});

test('per-language values are per minute, whatever unit they were written for', () => {
  assert.equal(baseCharsPerMinute('markdown', 350, { markdown: 60 }), 60);
});

test('zero, negative, non-numeric and non-finite values are ignored', () => {
  const speeds = { markdown: 0, json: -5, yaml: 'fast', css: Infinity, html: NaN };
  for (const id of Object.keys(speeds)) {
    assert.equal(baseCharsPerMinute(id, 350, speeds), 350, id);
  }
});

test('language ids match exactly', () => {
  assert.equal(baseCharsPerMinute('markdown', 350, { Markdown: 600 }), 350);
});

test('inherited object keys are not treated as entries', () => {
  assert.equal(baseCharsPerMinute('constructor', 350, {}), 350);
});

// Layers are workspace, repository file, user settings: highest priority first.

test('nothing set gives the 350 default', () => {
  assert.deepEqual(resolveCharsPerMinute([{}, {}, {}]), { charsPerMinute: 350, fromDeprecated: false });
});

test('charsPerMinute alone is used as is', () => {
  assert.deepEqual(resolveCharsPerMinute([{}, {}, { charsPerMinute: 400 }]), { charsPerMinute: 400, fromDeprecated: false });
});

test('only the old key counts times 60 and is marked deprecated', () => {
  assert.deepEqual(resolveCharsPerMinute([{}, {}, { charsPerSecond: 10 }]), { charsPerMinute: 600, fromDeprecated: true });
});

test('both keys in one layer: charsPerMinute wins', () => {
  assert.deepEqual(resolveCharsPerMinute([{}, {}, { charsPerSecond: 10, charsPerMinute: 400 }]), {
    charsPerMinute: 400,
    fromDeprecated: false,
  });
});

test('old key in a higher layer beats new key in a lower one', () => {
  assert.deepEqual(resolveCharsPerMinute([{}, { charsPerSecond: 10 }, { charsPerMinute: 400 }]), {
    charsPerMinute: 600,
    fromDeprecated: true,
  });
});

test('new key in a higher layer beats old key in a lower one', () => {
  assert.deepEqual(resolveCharsPerMinute([{ charsPerMinute: 400 }, {}, { charsPerSecond: 10 }]), {
    charsPerMinute: 400,
    fromDeprecated: false,
  });
});

test('a value that is not a finite number falls through to the next layer', () => {
  assert.deepEqual(resolveCharsPerMinute([{ charsPerMinute: 'fast' }, { charsPerSecond: NaN }, { charsPerMinute: 400 }]), {
    charsPerMinute: 400,
    fromDeprecated: false,
  });
});

test('the result is at least 1', () => {
  assert.equal(resolveCharsPerMinute([{ charsPerMinute: 0 }]).charsPerMinute, 1);
  assert.equal(resolveCharsPerMinute([{ charsPerSecond: -2 }]).charsPerMinute, 1);
});
