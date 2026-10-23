import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEAR_MATCH_CANDIDATES, pickRenamePartner, similarity } from '../src/renames';

const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');
const c = (relPath: string, text: string, key = 1000) => ({ relPath, text, key });

test('similarity: identical, empty, and unchanged lines over the larger file', () => {
  assert.equal(similarity('a\n', 'a\n'), 1);
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('', 'a\n'), 0);
  assert.equal(similarity('a\nb\nc\nd\n', 'a\nb\nc\nX\n'), 0.75);
  assert.equal(similarity('a\nb\n', 'a\nb\nc\nd\n'), 0.5);
  assert.equal(similarity('a\nb\n', 'x\ny\n'), 0);
});

test('pick: an identical text pairs, an unrelated one does not', () => {
  const text = lines(10);
  assert.equal(pickRenamePartner(text, 'src/b.ts', 1000, [c('src/a.ts', text)])?.relPath, 'src/a.ts');
  assert.equal(pickRenamePartner(text, 'src/b.ts', 1000, [c('src/a.ts', lines(10, 'other'))]), undefined);
});

test('pick: a rename with an edit pairs at half the lines unchanged, not below', () => {
  const before = lines(10);
  const edited = before.replace('line 3\n', 'changed\n');
  assert.equal(pickRenamePartner(edited, 'lib/a.ts', 1000, [c('src/a.ts', before)])?.relPath, 'src/a.ts');
  const mostlyNew = lines(4) + lines(6, 'new');
  assert.equal(pickRenamePartner(mostlyNew, 'lib/a.ts', 1000, [c('src/a.ts', before)]), undefined);
});

test('pick: identical beats similar, then same name, then nearest key', () => {
  const text = lines(10);
  const near = text.replace('line 0\n', 'x\n');
  assert.equal(pickRenamePartner(text, 'new/a.ts', 1000, [c('old/z.ts', near, 1000), c('old/y.ts', text, 5000)])?.relPath, 'old/y.ts');
  assert.equal(pickRenamePartner(text, 'new/a.ts', 1000, [c('old/y.ts', text, 1000), c('old/a.ts', text, 5000)])?.relPath, 'old/a.ts');
  assert.equal(pickRenamePartner(text, 'new/a.ts', 1000, [c('old/y.ts', text, 3000), c('old/z.ts', text, 1100)])?.relPath, 'old/z.ts');
});

test('pick: empty files pair only with empty files, by name', () => {
  const held = [c('src/util/index.ts', ''), c('src/util/x.ts', 'export const x = 1;\n')];
  assert.equal(pickRenamePartner('', 'src/lib/index.ts', 1000, held)?.relPath, 'src/util/index.ts');
  assert.equal(pickRenamePartner('export const x = 1;\n', 'src/lib/x.ts', 1000, held)?.relPath, 'src/util/x.ts');
  assert.equal(pickRenamePartner('', 'src/lib/y.ts', 1000, [c('src/util/x.ts', 'export const x = 1;\n')]), undefined);
});

test('pick: never pairs a path with itself', () => {
  assert.equal(pickRenamePartner('a\n', 'src/a.ts', 1000, [c('src/a.ts', 'a\n')]), undefined);
});

test('pick: near matches are looked for among the nearest candidates only', () => {
  const text = lines(10);
  const near = text.replace('line 0\n', 'x\n');
  const far = c('far/a.ts', near, 100_000);
  const close = Array.from({ length: NEAR_MATCH_CANDIDATES }, (_, i) => c(`close/${i}.ts`, lines(10, `other${i}`), 1000 + i));
  assert.equal(pickRenamePartner(text, 'new/a.ts', 1000, [...close, far]), undefined);
  assert.equal(pickRenamePartner(text, 'new/a.ts', 1000, [...close.slice(1), far])?.relPath, 'far/a.ts');
});
