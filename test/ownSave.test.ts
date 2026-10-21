import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOwnSave } from '../src/ownSave';

test('decideOwnSave: no editor save is external', () => {
  assert.deepEqual(decideOwnSave(undefined, 'a\n'), { kind: 'external' });
});

test('decideOwnSave: disk matching the saved text is own', () => {
  assert.deepEqual(decideOwnSave('// mine\nconst a = 1;\n', '// mine\nconst a = 1;\n'), { kind: 'own' });
});

test('decideOwnSave: disk differing from the saved text is after-own, from the saved text', () => {
  assert.deepEqual(decideOwnSave('// mine\nconst a = 1;\n', '// mine\nconst a = 2;\n'), {
    kind: 'after-own',
    before: '// mine\nconst a = 1;\n',
  });
});

test('decideOwnSave: line endings do not affect the match', () => {
  assert.deepEqual(decideOwnSave('a\r\nb\r\n', 'a\nb\n'), { kind: 'own' });
  assert.deepEqual(decideOwnSave('a\nb\n', 'a\r\nb\r\n'), { kind: 'own' });
});

test('decideOwnSave: after-own before text is LF-normalized', () => {
  assert.deepEqual(decideOwnSave('a\r\nb\r\n', 'a\nc\n'), { kind: 'after-own', before: 'a\nb\n' });
});

test('decideOwnSave: an empty save then an outside write is after-own', () => {
  assert.deepEqual(decideOwnSave('', 'new\n'), { kind: 'after-own', before: '' });
});
