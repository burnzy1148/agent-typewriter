import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backspaceStep, splitsPair, typingChunkEnd } from '../src/typingChunks';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Chunks `text` the way typeText does, with a fixed perTick. */
function chunks(text: string, perTick: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const j = typingChunkEnd(text, i, perTick);
    assert.ok(j > i && j <= text.length, `no progress at ${i}`);
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/** Backspaces all of `deleted` the way deleteText does, returning each removed piece, last first. */
function backspaces(deleted: string, step: number): string[] {
  const out: string[] = [];
  for (let remaining = deleted.length; remaining > 0; ) {
    const n = backspaceStep(deleted, remaining, step);
    assert.ok(n > 0 && n <= remaining, `bad step ${n} at ${remaining}`);
    out.push(deleted.slice(remaining - n, remaining));
    remaining -= n;
  }
  return out;
}

test('typed chunks never split a surrogate pair', () => {
  for (const text of ['Ship it 🚀 now\n', 'x🚀🚀y', '🚀a', 'ab𝐀c\n𝐀', 'ok 👍🏿 done\n']) {
    for (const perTick of [1, 2, 3, 4]) {
      const parts = chunks(text, perTick);
      assert.equal(parts.join(''), text);
      for (const p of parts) assert.doesNotMatch(p, LONE, `perTick ${perTick} split ${JSON.stringify(text)}: ${JSON.stringify(parts)}`);
    }
  }
});

test('a chunk still ends after a line break', () => {
  assert.deepEqual(chunks('a\nbc', 4), ['a\n', 'bc']);
});

test('backspaces remove whole code points and account for every unit', () => {
  for (const text of ['ok 🏻', ' 🚀 b c', '🚀🚀', 'a 𝐀 b', '👍🏻']) {
    for (const step of [1, 2, 3, 4]) {
      const parts = backspaces(text, step);
      assert.equal(parts.slice().reverse().join(''), text);
      for (const p of parts) assert.doesNotMatch(p, LONE, `step ${step} split ${JSON.stringify(text)}: ${JSON.stringify(parts)}`);
    }
  }
});

test('a skin-tone modifier is backspaced as one character', () => {
  assert.equal(backspaceStep('🏻', 2, 1), 2);
  assert.deepEqual(backspaces('👍🏻', 1), ['🏻', '👍']);
});

test('lone surrogates already in the text neither loop nor overrun', () => {
  for (const text of ['a\uD83D', '\uDE80b', '\uD83D\uD83D', '\uDE80\uDE80', 'x\uD83D']) {
    for (const n of [1, 2, 3]) {
      assert.equal(chunks(text, n).join(''), text);
      assert.equal(backspaces(text, n).reverse().join(''), text);
    }
  }
});

test('splitsPair only between a high and a low surrogate', () => {
  assert.equal(splitsPair('🚀', 1), true);
  assert.equal(splitsPair('🚀', 0), false);
  assert.equal(splitsPair('🚀', 2), false);
  assert.equal(splitsPair('\uDE80\uD83D', 1), false);
});
