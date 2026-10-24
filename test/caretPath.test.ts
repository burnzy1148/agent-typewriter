import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretPath, type Caret } from '../src/caretPath';
import { splitsPair } from '../src/typingChunks';

const doc = (text: string) => {
  const lines = text.split('\n');
  return (n: number) => lines[n];
};
const at = (line: number, character: number): Caret => ({ line, character });

test('no keys when the caret is already there', () => {
  assert.deepEqual(caretPath(doc('abc'), at(0, 1), at(0, 1), 24), []);
});

test('down a line at a time, keeping the column, then along the line', () => {
  const lines = doc('const a = 1;\nx\nconst bb = 2;\nconst c = 3;');
  const keys = caretPath(lines, at(0, 6), at(3, 8), 24)!;
  assert.deepEqual(keys.slice(0, 3), [at(1, 1), at(2, 6), at(3, 6)]);
  assert.deepEqual(keys[keys.length - 1], at(3, 8));
  assert.ok(keys.slice(3).every((k) => k.line === 3));
});

test('up works the same way', () => {
  const keys = caretPath(doc('aaaa\nbbbb\ncccc'), at(2, 2), at(0, 2), 24)!;
  assert.deepEqual(keys, [at(1, 2), at(0, 2)]);
});

test('word jumps first, then characters, without passing the target', () => {
  const line = 'const value = compute(first, second);';
  const to = line.indexOf('second') + 2;
  const keys = caretPath(doc(line), at(0, 0), at(0, to), 24)!.map((k) => k.character);
  assert.equal(keys[keys.length - 1], to);
  assert.ok(keys.every((c, i) => c > (i === 0 ? 0 : keys[i - 1]) && c <= to), `not moving right: ${keys}`);
  assert.ok(keys.length < to, 'word jumps should take fewer keys than characters');
  const back = caretPath(doc(line), at(0, line.length - 1), at(0, 3), 24)!.map((k) => k.character);
  assert.equal(back[back.length - 1], 3);
  assert.ok(back.every((c, i) => c < (i === 0 ? line.length - 1 : back[i - 1]) && c >= 3), `not moving left: ${back}`);
});

test('Home and End for the ends of the line', () => {
  const line = '    return compute(a, b);';
  assert.deepEqual(caretPath(doc(line), at(0, 10), at(0, line.length), 24), [at(0, line.length)]);
  assert.deepEqual(caretPath(doc(line), at(0, 10), at(0, 0), 24), [at(0, 0)]);
});

test('too many keys means a click', () => {
  const lines = doc(Array.from({ length: 40 }, () => 'x').join('\n'));
  assert.equal(caretPath(lines, at(0, 0), at(30, 0), 24), undefined);
  assert.ok(caretPath(lines, at(0, 0), at(20, 0), 24));
});

test('never stops inside a surrogate pair', () => {
  const text = 'a 👍🏻 b 𝐀𝐀 c\n😀😀😀😀\nplain line';
  const lines = doc(text);
  const all = text.split('\n');
  for (let fl = 0; fl < all.length; fl++) {
    for (let fc = 0; fc <= all[fl].length; fc++) {
      if (splitsPair(all[fl], fc)) continue;
      for (let tl = 0; tl < all.length; tl++) {
        for (let tc = 0; tc <= all[tl].length; tc++) {
          if (splitsPair(all[tl], tc)) continue;
          const keys = caretPath(lines, at(fl, fc), at(tl, tc), 1000)!;
          const end = keys.length ? keys[keys.length - 1] : at(fl, fc);
          assert.deepEqual(end, at(tl, tc));
          for (const k of keys) assert.ok(!splitsPair(all[k.line], k.character), `stopped mid-pair at ${k.line}:${k.character}`);
        }
      }
    }
  }
});
