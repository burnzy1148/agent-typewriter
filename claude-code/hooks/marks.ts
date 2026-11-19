// The code view's marks and the file tabs, as pure functions: whole-line diff
// rows of a file's baseline and its shown text, and how the tabs' labels are
// named and laid into rows. replay.ts decides what each file's baseline and
// text are; nothing here touches the deck or the engine.

import { netHunks } from './core.mjs';

/** A row of the unified diff the code view draws: context, added or removed. */
export type RowKind = ' ' | '+' | '-';

/** A diff row: its kind, its line's text, and its 0-based line in the baseline (`old`) and in the shown text (`cur`), each where it has one. */
export type DiffRow = { kind: RowKind; text: string; old?: number; cur?: number };

/** Offsets where each line of `text` starts; as many as `text.split('\n')` has lines. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The 0-based line holding offset `at`, by its lines' starts. */
export function lineAt(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Marks the lines a hunk touches on one side: every line that holds a
 * character of [from, to), or, for an empty range, the line holding `from`,
 * unless whole lines went in or out there (`from` starts a line and the other
 * side's text ends with a line break), which leaves this side's lines whole.
 */
function markRange(mark: Uint8Array, starts: readonly number[], from: number, to: number, other: string): void {
  if (to > from) {
    for (let l = lineAt(starts, from), last = lineAt(starts, to - 1); l <= last; l++) mark[l] = 1;
    return;
  }
  const l = lineAt(starts, from);
  if (starts[l] !== from || !other.endsWith('\n')) mark[l] = 1;
}

let memo: { baseline: string; text: string; rows: DiffRow[] } | undefined;

/**
 * The unified diff of `baseline` and `text` in whole lines, in file order: a
 * line any change touches shows as its baseline version removed, then its
 * new version added, and every other line as context. Within each run of
 * changed lines, lines equal at its start or end are context. The context and
 * added rows give back `text`, and the context and removed rows `baseline`.
 */
export function diffRows(baseline: string, text: string): DiffRow[] {
  if (memo && memo.baseline === baseline && memo.text === text) return memo.rows;
  const a = baseline.split('\n');
  const b = text.split('\n');
  const rows: DiffRow[] = [];
  if (baseline === text) {
    for (let i = 0; i < b.length; i++) rows.push({ kind: ' ', text: b[i]!, old: i, cur: i });
  } else {
    const aStarts = lineStarts(baseline);
    const bStarts = lineStarts(text);
    const aMark = new Uint8Array(a.length);
    const bMark = new Uint8Array(b.length);
    // A hunk's offset is in the text after the hunks before it, so in `text`; in `baseline` it is that less their net growth.
    let growth = 0;
    for (const h of [...netHunks(baseline, text)].sort((x, y) => x.offset - y.offset)) {
      const from = h.offset;
      const at = from - growth;
      markRange(bMark, bStarts, from, from + h.insertText.length, h.deleteText);
      markRange(aMark, aStarts, at, at + h.deleteText.length, h.insertText);
      growth += h.insertText.length - h.deleteText.length;
    }
    let minus: number[] = [];
    let plus: number[] = [];
    const flush = () => {
      let head = 0;
      while (head < minus.length && head < plus.length && a[minus[head]!] === b[plus[head]!]) head++;
      let tail = 0;
      while (tail < minus.length - head && tail < plus.length - head && a[minus[minus.length - 1 - tail]!] === b[plus[plus.length - 1 - tail]!]) tail++;
      for (let k = 0; k < head; k++) rows.push({ kind: ' ', text: b[plus[k]!]!, old: minus[k]!, cur: plus[k]! });
      for (let k = head; k < minus.length - tail; k++) rows.push({ kind: '-', text: a[minus[k]!]!, old: minus[k]! });
      for (let k = head; k < plus.length - tail; k++) rows.push({ kind: '+', text: b[plus[k]!]!, cur: plus[k]! });
      for (let k = tail; k > 0; k--) rows.push({ kind: ' ', text: b[plus[plus.length - k]!]!, old: minus[minus.length - k]!, cur: plus[plus.length - k]! });
      minus = [];
      plus = [];
    };
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      while (i < a.length && aMark[i]) minus.push(i++);
      while (j < b.length && bMark[j]) plus.push(j++);
      if (i < a.length && j < b.length && !aMark[i] && !bMark[j]) {
        if (a[i] === b[j]) {
          flush();
          rows.push({ kind: ' ', text: b[j]!, old: i++, cur: j++ });
        } else {
          // Lines outside every hunk are the same on both sides; should they not be, they count as changed.
          minus.push(i++);
          plus.push(j++);
        }
      } else if (i >= a.length !== j >= b.length) {
        if (i < a.length && !aMark[i]) minus.push(i++);
        if (j < b.length && !bMark[j]) plus.push(j++);
      }
    }
    flush();
  }
  memo = { baseline, text, rows };
  return rows;
}

/**
 * Each tab's label for `names`, paths as the pane names them: the file name,
 * with as many of its folders before it as tell it apart from the others.
 */
export function tabLabels(names: readonly string[]): string[] {
  // Where each name's segments start, the last first.
  const cuts = names.map((n) => {
    const at = [0];
    for (let i = 0; i < n.length; i++) if (n[i] === '/' || n[i] === '\\') at.push(i + 1);
    return at.reverse();
  });
  const depth = names.map(() => 1);
  const label = (k: number) => names[k]!.slice(cuts[k]![Math.min(depth[k]!, cuts[k]!.length) - 1]);
  for (let changed = true; changed; ) {
    changed = false;
    const seen = new Map<string, number[]>();
    names.forEach((_, k) => seen.set(label(k), [...(seen.get(label(k)) ?? []), k]));
    for (const ks of seen.values()) {
      if (ks.length < 2) continue;
      for (const k of ks) {
        if (depth[k]! < cuts[k]!.length) {
          depth[k]!++;
          changed = true;
        }
      }
    }
  }
  return names.map((_, k) => label(k));
}

/** Most rows the tabs take. */
export const TAB_ROWS = 2;

/**
 * The tabs laid into at most TAB_ROWS rows `columns` wide, each tab `widths[k]`
 * wide with a column between tabs. Tabs are taken in `priority` order (the
 * shown tab first, then the most recently typed) for as long as they fit, a
 * note of how many are left out included, and drawn in their own order.
 * Returns each row's tabs and how many were left out.
 */
export function tabRows(widths: readonly number[], priority: readonly number[], columns: number, noteWidth: (left: number) => number): { rows: number[][]; left: number } {
  const layout = (chosen: ReadonlySet<number>) => {
    const left = widths.length - chosen.size;
    const items = [...chosen].sort((x, y) => x - y).map((k) => ({ k, w: widths[k]! }));
    if (left > 0) items.push({ k: -1, w: noteWidth(left) });
    const rows: number[][] = [];
    let used = 0;
    for (const { k, w } of items) {
      if (rows.length === 0 || (used > 0 && used + 1 + w > columns)) {
        rows.push([]);
        used = 0;
      }
      rows[rows.length - 1]!.push(k);
      used += (used > 0 ? 1 : 0) + w;
    }
    return { rows: rows.map((r) => r.filter((k) => k !== -1)).filter((r) => r.length > 0), count: rows.length, left };
  };
  const chosen = new Set<number>();
  let best = layout(chosen);
  for (const k of priority) {
    chosen.add(k);
    const next = layout(chosen);
    if (next.count > TAB_ROWS && chosen.size > 1) {
      chosen.delete(k);
      break;
    }
    best = next;
  }
  return { rows: best.rows, left: best.left };
}
