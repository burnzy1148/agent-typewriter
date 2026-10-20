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
}

/** Blocks bigger than this are not refined word-by-word; they are deleted and retyped. */
const REFINE_MAX_CHARS = 8000;
/** Word-level refinement only when the old and new block are mostly the same text. */
const REFINE_MIN_SIMILARITY = 0.4;
/** Unchanged runs this short (and without a newline) get folded into the surrounding edit. */
const FOLD_MAX_COMMON = 3;

export function normalizeEol(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

/**
 * Turns a before/after pair into an ordered list of hunks that read like a
 * person editing top to bottom: whole new lines are typed as lines, and a
 * modified line only retypes the tokens that actually changed.
 */
export function planHunks(before: string, after: string): Hunk[] {
  if (before === after) return [];
  if (before.length === 0) return [{ offset: 0, deleteText: '', insertText: after }];
  if (after.length === 0) return [{ offset: 0, deleteText: before, insertText: '' }];

  const hunks: Hunk[] = [];
  let pos = 0;
  const parts = diffLines(before, after);

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

    if (removed && added && shouldRefine(removed, added)) {
      hunks.push(...refineBlock(removed, added, pos));
    } else {
      hunks.push({ offset: pos, deleteText: removed, insertText: added });
    }
    pos += added.length;
  }
  return hunks;
}

function shouldRefine(removed: string, added: string): boolean {
  if (removed.length > REFINE_MAX_CHARS || added.length > REFINE_MAX_CHARS) return false;
  const parts = diffWordsWithSpace(removed, added);
  let common = 0;
  for (const p of parts) if (!p.added && !p.removed) common += p.value.length;
  return common / Math.max(removed.length, added.length) >= REFINE_MIN_SIMILARITY;
}

type Segment =
  | { kind: 'common'; text: string }
  | { kind: 'change'; removed: string; added: string };

function refineBlock(removed: string, added: string, start: number): Hunk[] {
  const parts: Change[] = diffWordsWithSpace(removed, added);

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

export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of diffLines(before, after)) {
    if (p.added) added += p.count ?? 0;
    else if (p.removed) removed += p.count ?? 0;
  }
  return { added, removed };
}
