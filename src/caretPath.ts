// How the player walks the caret to the next edit with arrow keys: up or
// down a line at a time keeping its column, then along the line by words
// and characters, or Home and End.

import { splitsPair } from './typingChunks';

export interface Caret {
  line: number;
  character: number;
}

/** Word characters for word-wise moves, like the editor's default word separators. */
const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Caret positions after each key press that walk from `from` to `to`, ending
 * at `to`. Empty when they are the same. Undefined when it takes more than
 * `maxKeys` presses: a person clicks there instead.
 */
export function caretPath(lineText: (line: number) => string, from: Caret, to: Caret, maxKeys: number): Caret[] | undefined {
  const keys: Caret[] = [];
  const dir = Math.sign(to.line - from.line);
  let at = { ...from };
  // Up or down keeps the column the caret started in, clamped to each line.
  for (let line = from.line + dir; dir !== 0 && (line - to.line) * dir <= 0; line += dir) {
    const text = lineText(line);
    let character = Math.min(from.character, text.length);
    if (splitsPair(text, character)) character--;
    at = { line, character };
    keys.push(at);
    if (keys.length > maxKeys) return undefined;
  }
  const text = lineText(to.line);
  for (const character of alongLine(text, at.character, to.character)) {
    keys.push({ line: to.line, character });
    if (keys.length > maxKeys) return undefined;
  }
  return keys;
}

/** Columns after each press that move from `from` to `to` on one line. */
function alongLine(text: string, from: number, to: number): number[] {
  if (from === to) return [];
  // Home or End when the target is that end of the line and more than a couple of presses away.
  if (Math.abs(to - from) > 2 && (to === 0 || to === text.length)) return [to];
  const out: number[] = [];
  let at = from;
  const dir = Math.sign(to - from);
  for (;;) {
    const word = dir > 0 ? wordRight(text, at) : wordLeft(text, at);
    if ((to - word) * dir < 0 || word === at) break;
    out.push((at = word));
  }
  while ((to - at) * dir > 0) {
    at += dir;
    // Never stop inside a surrogate pair.
    if (at !== to && splitsPair(text, at)) at += dir;
    out.push(at);
  }
  return out;
}

/** Where a word-right press lands: the end of the next word. */
function wordRight(text: string, at: number): number {
  let i = at;
  while (i < text.length && !WORD.test(text[i])) i++;
  while (i < text.length && WORD.test(text[i])) i++;
  return i;
}

/** Where a word-left press lands: the start of the previous word. */
function wordLeft(text: string, at: number): number {
  let i = at;
  while (i > 0 && !WORD.test(text[i - 1])) i--;
  while (i > 0 && WORD.test(text[i - 1])) i--;
  return i;
}
