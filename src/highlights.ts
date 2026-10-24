import { planHunks } from './planner';
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
  for (const h of planHunks(baseline, current)) {
    if (h.deleteText.length > 0) {
      const last = marks.removed[marks.removed.length - 1];
      if (last?.offset === h.offset) last.text += h.deleteText;
      else marks.removed.push({ offset: h.offset, text: h.deleteText });
    }
    if (h.insertText.length > 0) marks.added.push({ start: h.offset, end: h.offset + h.insertText.length });
  }
  return marks;
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
  const lines = texts.flatMap((t, i) => [...(i > 0 ? ['…'] : []), ...t.replace(/\n$/, '').split('\n')]);
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxLineChars ? l.slice(0, maxLineChars) + '…' : l));
  return { code: shown.join('\n'), more: lines.length - shown.length };
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
 * run, and longer after an expensive one, so a slow diff on a big file never
 * takes more than about a fifth of the time.
 */
export function renderWait(now: number, lastRun: number, lastCostMs: number, intervalMs = 100): number {
  return Math.max(0, lastRun + Math.max(intervalMs, lastCostMs * 4) - now);
}

/**
 * Each file's baseline for the changes with seq below `through`: its text at
 * its latest clear, else the before text of its earliest such change. A
 * rename carries its old path's baseline to the new path. Files without such
 * a change have no entry.
 */
export function baselines(events: readonly ChangeEvent[], through: number, clears: HighlightClears): Map<string, string> {
  const base = new Map<string, string>();
  const text = new Map<string, string>();
  // Clears in the order they take effect: before the first change at or after their seq.
  const pending = clears.filter((c) => c.seq <= through).sort((a, b) => a.seq - b.seq);
  let next = 0;
  const applyClears = (upTo: number) => {
    for (; next < pending.length && pending[next].seq <= upTo; next++) {
      const { relPath } = pending[next];
      if (relPath === undefined) for (const [p, t] of text) base.set(p, t);
      else if (text.has(relPath)) base.set(relPath, text.get(relPath)!);
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
