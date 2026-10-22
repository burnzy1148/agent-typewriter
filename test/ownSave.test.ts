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

test('decideOwnSave: a save that never finished still matches as own', () => {
  assert.deepEqual(decideOwnSave('U user edits\n', 'U user edits\n', false), { kind: 'own' });
});

test('decideOwnSave: a save that never finished and differs from disk is external, not after-own', () => {
  // The save may have written nothing, so its text is not the before text.
  assert.deepEqual(decideOwnSave('U user edits\n', 'A2\n', false), { kind: 'external' });
});
