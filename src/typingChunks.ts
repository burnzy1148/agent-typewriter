// Where the player cuts text into typed chunks and backspace steps. Offsets are
// UTF-16 code units, like the editor's, but a cut never lands inside a
// surrogate pair: VS Code moves or widens an edit that would split one, which
// would put the rest of the change at the wrong offsets.

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when `i` falls between the two halves of a surrogate pair in `text`. */
export function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/**
 * End (exclusive) of the next chunk of `text` to type from `i`: about `perTick`
 * code units, stopping after a line break, and never splitting a pair.
 */
export function typingChunkEnd(text: string, i: number, perTick: number): number {
  let j = i;
  while (j < text.length && j - i < Math.max(1, perTick)) {
    j++;
    if (text[j - 1] === '\n') break;
  }
  if (splitsPair(text, j)) j++;
  return j;
}

/**
 * How many code units the next backspace removes from the end of
 * `deleted.slice(0, remaining)`: `step`, at most `remaining`, plus one when
 * the cut would leave a lone high surrogate behind.
 */
export function backspaceStep(deleted: string, remaining: number, step: number): number {
  let n = Math.min(remaining, Math.max(1, step));
  if (splitsPair(deleted, remaining - n)) n++;
  return Math.min(n, remaining);
}
