import { diffLines, diffWordsWithSpace, type Change } from 'diff';

/**
 * One edit to type out. Hunks are applied strictly in order, and each offset
 * refers to the document as it stands after every earlier hunk has been
 * applied. That keeps playback simple: the editor's live text always matches
 * the planner's model, so offset -> position is a direct lookup.
 */
export interface Hunk {
  offset: number;
  deleteText: string;
  insertText: string;
  /**
   * Set by authoringOrder on every piece of an edit after its first: it is
   * typed within the text the edit is still typing, so the view does not
   * leave what was just typed to reach it.
   */
  continues?: boolean;
}

/** Blocks bigger than this are not refined word-by-word; they are deleted and retyped. */
const REFINE_MAX_CHARS = 8000;
/** Word-level refinement only when the old and new block are mostly the same text. */
const REFINE_MIN_SIMILARITY = 0.4;
/** Unchanged runs this short (and without a newline) get folded into the surrounding edit. */
const FOLD_MAX_COMMON = 3;
/**
 * Most added plus removed lines a line diff may search for. Diff time grows
 * with the square of this (about 100 ms at this bound), so past it the
 * changed region is retyped whole.
 */
export const LINE_DIFF_MAX_EDITS = 1500;
/** Most added plus removed tokens a block's word diff may search for before it is retyped instead. */
const WORD_DIFF_MAX_EDITS = 1000;

export function normalizeEol(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export type Eol = '\n' | '\r\n';

/** A file's line ending: CRLF only when CRLF breaks outnumber LF-only breaks. */
export function detectEol(raw: string): Eol {
  if (raw.indexOf('\r\n') === -1) return '\n';
  let crlf = 0;
  let lf = 0;
  for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
    if (i > 0 && raw[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Line and column of an offset into LF-normalized text. */
export function lfOffsetToLineCol(lfText: string, offset: number): { line: number; character: number } {
  const at = Math.max(0, Math.min(offset, lfText.length));
  let line = 0;
  let lineStart = 0;
  for (let i = lfText.indexOf('\n'); i !== -1 && i < at; i = lfText.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, character: at - lineStart };
}

/**
 * Turns a before/after pair into an ordered list of hunks that read like a
 * person editing top to bottom: whole new lines are typed as lines, and a
 * modified line only retypes the tokens that actually changed.
 * `maxLineEdits` raises or lowers the line diff's search limit.
 */
export function planHunks(before: string, after: string, maxLineEdits = LINE_DIFF_MAX_EDITS): Hunk[] {
  if (before === after) return [];
  if (before.length === 0) return [{ offset: 0, deleteText: '', insertText: after }];
  if (after.length === 0) return [{ offset: 0, deleteText: before, insertText: '' }];

  const parts = diffLines(before, after, { maxEditLength: maxLineEdits });
  if (!parts) {
    const r = changedRegion(before, after);
    return [{ offset: r.start, deleteText: r.removed, insertText: r.added }];
  }

  const hunks: Hunk[] = [];
  let pos = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      pos += part.value.length;
      continue;
    }
    let removed = '';
    let added = '';
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) removed += parts[i].value;
      else added += parts[i].value;
      i++;
    }
    i--;

    const words = removed && added ? refinableWords(removed, added) : undefined;
    if (words) {
      hunks.push(...refineBlock(words, pos));
    } else {
      hunks.push({ offset: pos, deleteText: removed, insertText: added });
    }
    pos += added.length;
  }
  return hunks;
}

/** The block's word diff when it is worth retyping word by word, else undefined. */
function refinableWords(removed: string, added: string): Change[] | undefined {
  if (removed.length > REFINE_MAX_CHARS || added.length > REFINE_MAX_CHARS) return undefined;
  const parts = diffWordsWithSpace(removed, added, { maxEditLength: WORD_DIFF_MAX_EDITS });
  if (!parts) return undefined;
  let common = 0;
  for (const p of parts) if (!p.added && !p.removed) common += p.value.length;
  return common / Math.max(removed.length, added.length) >= REFINE_MIN_SIMILARITY ? parts : undefined;
}

type Segment =
  | { kind: 'common'; text: string }
  | { kind: 'change'; removed: string; added: string };

function refineBlock(parts: Change[], start: number): Hunk[] {
  // 1. Collapse runs of added/removed parts into single change segments.
  const segments: Segment[] = [];
  for (const p of parts) {
    if (!p.added && !p.removed) {
      segments.push({ kind: 'common', text: p.value });
      continue;
    }
    const last = segments[segments.length - 1];
    const change = last && last.kind === 'change' ? last : undefined;
    const target = change ?? { kind: 'change' as const, removed: '', added: '' };
    if (p.removed) target.removed += p.value;
    else target.added += p.value;
    if (!change) segments.push(target);
  }

  // 2. Fold tiny unchanged gaps between two changes into one change, so
  //    "a(b)" -> "x(y)" is a single natural retype, not several micro-edits.
  const folded: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = folded[folded.length - 1];
    const next = segments[i + 1];
    if (
      seg.kind === 'common' &&
      prev?.kind === 'change' &&
      next?.kind === 'change' &&
      seg.text.length <= FOLD_MAX_COMMON &&
      !seg.text.includes('\n')
    ) {
      prev.removed += seg.text + next.removed;
      prev.added += seg.text + next.added;
      i++;
      continue;
    }
    folded.push(seg.kind === 'change' ? { ...seg } : seg);
  }

  // 3. Walk segments, tracking the offset in the evolving document.
  const out: Hunk[] = [];
  let pos = start;
  for (const seg of folded) {
    if (seg.kind === 'common') {
      pos += seg.text.length;
    } else {
      out.push({ offset: pos, deleteText: seg.removed, insertText: seg.added });
      pos += seg.added.length;
    }
  }
  return out;
}

/** Brackets that open a block when they end a line, and the bracket that closes each. */
const BLOCK_CLOSERS: Readonly<Record<string, string>> = { '{': '}', '[': ']', '(': ')' };

/**
 * Re-cuts planHunks' hunks so each edit is typed the way a person writes it:
 * a block (a bracket that ends a line, closed by its match at the start of a
 * later line with the same indentation) gets its opening line, then its
 * closing line, then the lines between. Blocks inside are typed the same way
 * when reached, so a block's header is done before its body. Edits stay in
 * document order and each one still leaves exactly its own text, so offsets
 * stay relative to the text after earlier hunks. `after` is the text the
 * hunks lead to; it supplies the indentation of a line an edit starts in.
 */
export function authoringOrder(hunks: Hunk[], after: string): Hunk[] {
  return hunks.flatMap((h) => {
    if (!h.insertText.includes('\n')) return [h];
    const lineStart = h.offset === 0 ? 0 : after.lastIndexOf('\n', h.offset - 1) + 1;
    const blocks = findBlocks(h.insertText, after.slice(lineStart, h.offset));
    return blocks.length === 0 ? [h] : cutInPieces(h, blocks);
  });
}

/** A block in an edit's inserted text, by index into that text. */
interface Block {
  /** The opening bracket. */
  open: number;
  /** The line break before the closing line. */
  close: number;
  /** End of the closing piece: the closer and the rest of its line, unless that rest opens a block. */
  end: number;
}

/**
 * The blocks in `text`, ordered by opening bracket; they nest properly.
 * `prefix` is what precedes `text` on its first line.
 */
function findBlocks(text: string, prefix: string): Block[] {
  const found: Array<{ open: number; close: number; closer: number }> = [];
  const open: Array<{ at: number; indent: string; closer: string }> = [];
  const prefixHasText = /[^ \t]/.test(prefix);
  for (let start = 0; start <= text.length; ) {
    const nl = text.indexOf('\n', start);
    const lineEnd = nl === -1 ? text.length : nl;
    let content = start;
    while (content < lineEnd && (text[content] === ' ' || text[content] === '\t')) content++;
    const first = start === 0;
    const indent = first ? (prefixHasText ? /^[ \t]*/.exec(prefix)![0] : prefix + text.slice(0, content)) : text.slice(start, content);
    if (content < lineEnd || (first && prefixHasText)) {
      // Blocks this line is not indented deeper than end here: closed by it, or not blocks at all.
      while (open.length > 0) {
        const top = open[open.length - 1];
        if (indent.length > top.indent.length && indent.startsWith(top.indent)) break;
        open.pop();
        // A closer must start its own line inside the text, after a body.
        if (!first && indent === top.indent && text[content] === top.closer && start - 1 > top.at + 1) {
          found.push({ open: top.at, close: start - 1, closer: content });
        }
      }
      const last = text[lineEnd - 1];
      if (nl !== -1 && lineEnd > start && last in BLOCK_CLOSERS) open.push({ at: lineEnd - 1, indent, closer: BLOCK_CLOSERS[last] });
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  const opens = new Set(found.map((b) => b.open));
  return found
    .map(({ open, close, closer }) => {
      const nl = text.indexOf('\n', closer);
      const lineEnd = nl === -1 ? text.length : nl;
      // `} else {` keeps its new block for later; anything else on the line is typed with the closer.
      const end = opens.has(lineEnd - 1) ? closer + 1 : nl === -1 ? text.length : nl + 1;
      return { open, close, end };
    })
    .sort((a, b) => a.open - b.open);
}

/** `h` as pieces in authoring order, each offset relative to the text after the pieces before it. */
function cutInPieces(h: Hunk, blocks: Block[]): Hunk[] {
  const text = h.insertText;
  const out: Hunk[] = [];
  // Characters of `text` typed so far, and how many of them come after the caret: open blocks' closing pieces.
  let typed = 0;
  let after = 0;
  const piece = (from: number, to: number) => {
    if (from >= to) return;
    const offset = h.offset + typed - after;
    const last = out[out.length - 1];
    if (last && last.offset + last.insertText.length === offset) last.insertText += text.slice(from, to);
    else out.push(out.length === 0 ? { offset, deleteText: h.deleteText, insertText: text.slice(from, to) } : { offset, deleteText: '', insertText: text.slice(from, to), continues: true });
    typed += to - from;
  };
  let next = 0;
  const typeRange = (from: number, to: number) => {
    let at = from;
    while (next < blocks.length && blocks[next].open < to) {
      const b = blocks[next++];
      const end = Math.min(b.end, to);
      piece(at, b.open + 1);
      piece(b.close, end);
      after += end - b.close;
      typeRange(b.open + 1, b.close);
      after -= end - b.close;
      at = end;
    }
    piece(at, to);
  };
  typeRange(0, text.length);
  return out;
}

/** Applies hunks to a string exactly the way the player applies them to an editor. */
export function applyHunks(before: string, hunks: Hunk[]): string {
  let doc = before;
  for (const h of hunks) {
    const actual = doc.slice(h.offset, h.offset + h.deleteText.length);
    if (actual !== h.deleteText) {
      throw new Error(`hunk at ${h.offset} expected to delete ${JSON.stringify(h.deleteText)} but found ${JSON.stringify(actual)}`);
    }
    doc = doc.slice(0, h.offset) + h.insertText + doc.slice(h.offset + h.deleteText.length);
  }
  return doc;
}

/**
 * The span between the lines both texts start and end with. It begins at the
 * same offset in both, and `removed` -> `added` there turns before into after.
 */
function changedRegion(before: string, after: string): { start: number; removed: string; added: string } {
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  // lastIndexOf clamps a negative start to 0, so a head of 0 must stay put.
  if (head > 0) head = before.lastIndexOf('\n', head - 1) + 1;
  let tail = 0;
  while (
    tail < max - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  // Start the shared tail at a line start in both texts, else after its first newline.
  const tailStart = before.length - tail;
  if (!atLineStart(before, tailStart) || !atLineStart(after, after.length - tail)) {
    const nl = before.indexOf('\n', tailStart);
    tail = nl === -1 ? 0 : before.length - nl - 1;
  }
  return {
    start: head,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
  };
}

function atLineStart(text: string, offset: number): boolean {
  return offset === 0 || text.charCodeAt(offset - 1) === 10;
}

function lineCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.length > 0 && !text.endsWith('\n') ? n + 1 : n;
}

export function countChanges(before: string, after: string): { added: number; removed: number } {
  const parts = diffLines(before, after, { maxEditLength: LINE_DIFF_MAX_EDITS });
  if (!parts) {
    const r = changedRegion(before, after);
    return { added: lineCount(r.added), removed: lineCount(r.removed) };
  }
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.added) added += p.count ?? 0;
    else if (p.removed) removed += p.count ?? 0;
  }
  return { added, removed };
}
