import { diffWordsWithSpace } from 'diff';
import { planHunks, type Hunk } from './planner';
import type { ChangeEvent } from './timeline';

/** How a mirror's text differs from its file's baseline, as LF offsets into the mirror's text. */
export interface Marks {
  /** Added text, one [start, end) range per hunk, ascending. */
  added: Array<{ start: number; end: number }>;
  /** Where baseline text is missing, ascending; removals at the same offset are merged. */
  removed: Array<{ offset: number; text: string }>;
}

/** Marks that turn `current` back into `baseline`: a net diff, so text added and later removed leaves none. */
export function diffMarks(baseline: string, current: string): Marks {
  const marks: Marks = { added: [], removed: [] };
  // Hunk offsets are in the text after earlier hunks, and later hunks come after
  // earlier ones, so each offset is also a position in `current`.
  for (const h of netHunks(baseline, current).flatMap(exactHunks)) {
    if (h.deleteText.length > 0) {
      const last = marks.removed[marks.removed.length - 1];
      if (last?.offset === h.offset) last.text += h.deleteText;
      else marks.removed.push({ offset: h.offset, text: h.deleteText });
    }
    if (h.insertText.length > 0) marks.added.push({ start: h.offset, end: h.offset + h.insertText.length });
  }
  return marks;
}

/** Longest replaced text, on one line, that exactHunks splits further. */
const EXACT_MAX_CHARS = 2000;

/**
 * A hunk split so unchanged text inside it is left out. To read naturally the
 * planner retypes short unchanged gaps along with the words around them, as in
 * "foo(bar)" -> "baz(qux)"; marking the "(" as added and removed would be wrong.
 * Hunks spanning lines are left whole.
 */
function exactHunks(h: Hunk): Hunk[] {
  const { deleteText: del, insertText: ins } = h;
  if (!del || !ins || del.includes('\n') || ins.includes('\n') || del.length > EXACT_MAX_CHARS || ins.length > EXACT_MAX_CHARS) return [h];
  const parts = diffWordsWithSpace(del, ins, { maxEditLength: 200 });
  if (!parts) return [h];
  const out: Hunk[] = [];
  let offset = h.offset;
  for (const p of parts) {
    if (!p.added && !p.removed) {
      offset += p.value.length;
      continue;
    }
    const last = out[out.length - 1];
    const open = last && last.offset + last.insertText.length === offset ? last : undefined;
    const hunk = open ?? { offset, deleteText: '', insertText: '' };
    if (p.removed) hunk.deleteText += p.value;
    else {
      hunk.insertText += p.value;
      offset += p.value.length;
    }
    if (!open) out.push(hunk);
  }
  return out;
}

/**
 * Hunks that turn `baseline` into `current`, in planHunks' form, anchored on
 * lines both texts share and hold only once (as a patience diff does). Each
 * stretch between anchors is diffed on its own, so a net diff that built up
 * over many changes stays exact where one planHunks call would pass its edit
 * limit and mark a single region from the first difference to the last.
 */
export function netHunks(baseline: string, current: string): Hunk[] {
  if (baseline === current) return [];
  const a = splitLines(baseline);
  const b = splitLines(current);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const seen = new Map<string, { inA: number; inB: number; ai: number; bi: number }>();
  for (let i = head; i < a.length - tail; i++) {
    const c = seen.get(a[i]) ?? { inA: 0, inB: 0, ai: i, bi: -1 };
    c.inA++;
    seen.set(a[i], c);
  }
  for (let j = head; j < b.length - tail; j++) {
    const c = seen.get(b[j]);
    if (c) {
      c.inB++;
      c.bi = j;
    }
  }
  const unique = [...seen.values()].filter((c) => c.inA === 1 && c.inB === 1).sort((x, y) => x.ai - y.ai);
  const hunks: Hunk[] = [];
  let ai = head;
  let bi = head;
  let offset = b.slice(0, head).reduce((n, l) => n + l.length, 0);
  // Diffs a[ai, aEnd) against b[bi, bEnd); its hunk offsets are relative to where that stretch starts in `current`.
  const stretch = (aEnd: number, bEnd: number) => {
    const bText = b.slice(bi, bEnd).join('');
    for (const h of planHunks(a.slice(ai, aEnd).join(''), bText)) hunks.push({ ...h, offset: h.offset + offset });
    offset += bText.length;
  };
  for (const anchor of increasingRun(unique)) {
    stretch(anchor.ai, anchor.bi);
    offset += b[anchor.bi].length;
    ai = anchor.ai + 1;
    bi = anchor.bi + 1;
  }
  stretch(a.length - tail, b.length - tail);
  return hunks;
}

/** Lines with their line breaks; a last line without one is kept as is. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Of anchors sorted by `ai`, the longest run whose `bi` also increases. */
function increasingRun<T extends { bi: number }>(sorted: readonly T[]): T[] {
  const tails: number[] = [];
  const prev: number[] = [];
  for (let k = 0; k < sorted.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[tails[mid]].bi < sorted[k].bi) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const out: T[] = [];
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) out.push(sorted[k]);
  return out.reverse();
}

/** Marks by line: what the editor decorates. Lines and columns are the same in LF and CRLF documents. */
export interface LineMarks {
  /** Lines holding added text, ascending. */
  lines: number[];
  /** Added characters on lines that also keep baseline text, as columns. */
  chars: Array<{ line: number; start: number; end: number }>;
  /** Removals by the line they are marked on, ascending; each removed text in order. */
  removals: Array<{ line: number; texts: string[] }>;
}

export function lineMarks(text: string, marks: Marks): LineMarks {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Per touched line: added columns (newline excluded) and whether its newline was added.
  const touched = new Map<number, { cols: Array<[number, number]>; newline: boolean }>();
  for (const r of marks.added) {
    for (let line = lineOf(r.start); line < starts.length && starts[line] < r.end; line++) {
      const start = starts[line];
      const hasNewline = line + 1 < starts.length;
      const end = hasNewline ? starts[line + 1] - 1 : text.length;
      const t = touched.get(line) ?? { cols: [], newline: false };
      const from = Math.max(r.start, start);
      const to = Math.min(r.end, end);
      if (to > from) t.cols.push([from - start, to - start]);
      if (hasNewline && r.start <= end && end < r.end) t.newline = true;
      touched.set(line, t);
    }
  }
  const out: LineMarks = { lines: [], chars: [], removals: [] };
  for (const line of [...touched.keys()].sort((a, b) => a - b)) {
    const t = touched.get(line)!;
    const length = (line + 1 < starts.length ? starts[line + 1] - 1 : text.length) - starts[line];
    const covered = t.cols.reduce((n, [a, b]) => n + b - a, 0);
    // A line whose only added character is its line break holds no new text.
    if (covered === 0 && !(length === 0 && t.newline)) continue;
    out.lines.push(line);
    if (covered < length) for (const [start, end] of t.cols) out.chars.push({ line, start, end });
  }
  for (const r of marks.removed) {
    const line = lineOf(r.offset);
    const last = out.removals[out.removals.length - 1];
    if (last?.line === line) last.texts.push(r.text);
    else out.removals.push({ line, texts: [r.text] });
  }
  return out;
}

/** The removed text a removal marker's hover shows: at most `maxLines` lines of at most `maxLineChars` characters. */
export function removedPreview(texts: readonly string[], maxLines = 20, maxLineChars = 500): { code: string; more: number } {
  // Removals marked on the same line are separated by a "…" row, which is not a removed line.
  const rows = texts.flatMap((t, i) => [...(i > 0 ? [undefined] : []), ...t.replace(/\n$/, '').split('\n')]);
  const shown = rows.slice(0, maxLines);
  const removed = rows.filter((r) => r !== undefined).length;
  const code = shown.map((l) => (l === undefined ? '…' : l.length > maxLineChars ? l.slice(0, maxLineChars) + '…' : l)).join('\n');
  return { code, more: removed - shown.filter((r) => r !== undefined).length };
}

/**
 * One Clear Highlights: for every file, or for `relPath`. `seq` is cursor
 * style, the next change at the time of the clear.
 */
export interface HighlightClear {
  seq: number;
  relPath?: string;
}

/** Every clear still in effect, oldest first. */
export type HighlightClears = readonly HighlightClear[];

/** The seq of the latest clear that applies to `relPath`, or 0. */
export function clearedAt(clears: HighlightClears, relPath: string): number {
  return clears.reduce((at, c) => (c.relPath === undefined || c.relPath === relPath ? Math.max(at, c.seq) : at), 0);
}

/**
 * How long to wait before redrawing: at least `intervalMs` after the last
 * run, and longer after an expensive one, so a slow diff on a big file takes
 * at most about a fifth of the time; but never more than `maxMs`, so one slow
 * run does not hold back the next for long.
 */
export function renderWait(now: number, lastRun: number, lastCostMs: number, intervalMs = 100, maxMs = 2000): number {
  return Math.max(0, lastRun + Math.min(maxMs, Math.max(intervalMs, lastCostMs * 4)) - now);
}

/** What files' highlights are worked out from, read once for each pass over them. */
export interface HighlightState {
  /** Baselines for the played changes and the one being typed. */
  bases: ReadonlyMap<string, string>;
  /** While a rename is typed and has not moved its mirror yet: its old path, and the baselines from before it. */
  movingFrom?: string;
  basesBefore?: ReadonlyMap<string, string>;
  /** What each mirror shows at the cursor. */
  texts: ReadonlyMap<string, { text: string }>;
  clears: HighlightClears;
  /** The change being typed. */
  playing?: { seq: number; relPath: string; fromRelPath?: string };
  /** With nothing typed, the next change to play. */
  next?: { seq: number; relPath: string; fromRelPath?: string };
}

/** A file's baseline and the text its mirror should show, with `live` set when that text is the player's, mid-change. */
export interface HighlightPair {
  baseline: string;
  text: string;
  live: boolean;
}

/**
 * The baseline and text to compare for `relPath`, or undefined when it shows
 * no highlights. `live` is the player's text while it types into that mirror.
 */
export function highlightPair(st: HighlightState, relPath: string, live?: string): HighlightPair | undefined {
  const baseline = (relPath === st.movingFrom ? st.basesBefore : st.bases)?.get(relPath);
  if (baseline === undefined) return undefined;
  // A clear made while this file's change is typed takes effect when it
  // finishes; until then the file shows nothing. The same holds when that
  // change is next after a reload. A clear on a renamed file is kept under its
  // new path, so check both.
  const p = st.playing ?? st.next;
  if (p && (relPath === p.relPath || relPath === p.fromRelPath) && Math.max(clearedAt(st.clears, relPath), clearedAt(st.clears, p.relPath)) > p.seq) {
    return undefined;
  }
  if (live !== undefined) return { baseline, text: live, live: true };
  const text = st.texts.get(relPath)?.text;
  return text === undefined ? undefined : { baseline, text, live: false };
}

/**
 * Whether to draw a mirror's marks, keep the ones already drawn, or clear
 * them. Marks are drawn only on the text they describe. Mid-change, the
 * document can be a step ahead of the player's text; marks drawn during that
 * same change (same `liveToken`) are kept and move with the edit, while marks
 * from before a seek are cleared.
 */
export function renderAction(pair: HighlightPair | undefined, docText: string | undefined, drawnToken: number | undefined, liveToken: number | undefined): 'draw' | 'keep' | 'clear' {
  if (!pair) return 'clear';
  if (docText === pair.text) return 'draw';
  return pair.live && drawnToken !== undefined && drawnToken === liveToken ? 'keep' : 'clear';
}

/**
 * Each file's baseline for the changes with seq below `through`: its text at
 * its latest clear, else the before text of its earliest such change. A
 * rename carries its old path's baseline to the new path. Files without such
 * a change have no entry.
 *
 * `heldBack` names the change at `through` when it has not played, and the
 * paths it touches. A clear made right after it (while it was typed, before a
 * reload) already holds for every other file, whose text it does not change.
 */
export function baselines(
  events: readonly ChangeEvent[],
  through: number,
  clears: HighlightClears,
  heldBack?: { seq: number; paths: readonly string[] },
): Map<string, string> {
  const base = new Map<string, string>();
  const text = new Map<string, string>();
  // Clears in the order they take effect: before the first change at or after their seq.
  const early = heldBack && heldBack.seq === through ? heldBack.seq + 1 : undefined;
  const pending = clears.filter((c) => c.seq <= through || c.seq === early).sort((a, b) => a.seq - b.seq);
  let next = 0;
  const applyClears = (upTo: number) => {
    for (; next < pending.length && pending[next].seq <= upTo; next++) {
      const { relPath, seq } = pending[next];
      const skip = seq === early ? heldBack!.paths : [];
      if (relPath === undefined) {
        for (const [p, t] of text) if (!skip.includes(p)) base.set(p, t);
      } else if (text.has(relPath) && !skip.includes(relPath)) base.set(relPath, text.get(relPath)!);
    }
  };
  for (const e of events) {
    if (e.seq >= through) break;
    applyClears(e.seq);
    if (e.fromRelPath !== undefined) {
      const carried = base.get(e.fromRelPath) ?? e.before;
      base.delete(e.fromRelPath);
      text.delete(e.fromRelPath);
      base.set(e.relPath, carried);
    } else if (!base.has(e.relPath)) {
      base.set(e.relPath, e.before);
    }
    text.set(e.relPath, e.after);
  }
  applyClears(Infinity);
  return base;
}
