// The net diff of a baseline and a text, shared by the extension's highlights
// (src/highlights.ts) and the Claude Code plugin's diff marks through
// claude-code/hooks/core.mjs, so it imports neither vscode nor a Node built-in.

import { LINE_DIFF_MAX_EDITS, planHunks, type Hunk } from './planner';

/**
 * Most added plus removed lines a leaf may search for: twice the planner's own
 * limit, about four times its time (~450 ms for each leaf that needs it all).
 * Past it the leaf is marked as one region.
 */
const LEAF_MAX_EDITS = 3000;

/** How many times over its lines a diff may scan for anchors, so deeply nested input stays linear. */
const ANCHOR_SCANS = 10;

/**
 * Hunks that turn `baseline` into `current`, in planHunks' form, from a
 * patience diff. The texts are anchored on lines both hold only once; a
 * stretch between anchors too big for the planner to be sure of finishing is
 * split the same way, on lines held once within it, until none has such a
 * line. So a net diff that built up over many changes stays exact where one
 * planHunks call would pass its edit limit and mark a single region from the
 * first difference to the last, while a stretch the planner can finish gets
 * its minimal diff: a line moved past repeated braces is marked, not the braces.
 */
export function netHunks(baseline: string, current: string): Hunk[] {
  if (baseline === current) return [];
  const a = splitLines(baseline);
  const b = splitLines(current);
  // Where each line of `current` starts. Hunks before a leaf end before it, so this is also its offset for them.
  const bStart = [0];
  for (const line of b) bStart.push(bStart[bStart.length - 1] + line.length);
  const hunks: Hunk[] = [];
  let scans = ANCHOR_SCANS * (a.length + b.length);
  // Stretches a[a0, a1) and b[b0, b1) still to diff, the first one last.
  const todo: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  for (let top = true; todo.length > 0; top = false) {
    let [a0, a1, b0, b1] = todo.pop()!;
    for (; a0 < a1 && b0 < b1 && a[a0] === b[b0]; a0++) b0++;
    for (; a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]; a1--) b1--;
    if (a0 === a1 && b0 === b1) continue;
    const size = a1 - a0 + (b1 - b0);
    const split = (top || size > LINE_DIFF_MAX_EDITS) && scans >= size;
    const anchors = split ? increasingRun(uniqueShared(a, a0, a1, b, b0, b1)) : [];
    if (split) scans -= size;
    if (anchors.length === 0) {
      const leaf = planHunks(a.slice(a0, a1).join(''), b.slice(b0, b1).join(''), LEAF_MAX_EDITS);
      for (const h of leaf) hunks.push({ ...h, offset: h.offset + bStart[b0] });
      continue;
    }
    for (let k = anchors.length - 1; k >= 0; k--) {
      todo.push([anchors[k].ai + 1, a1, anchors[k].bi + 1, b1]);
      a1 = anchors[k].ai;
      b1 = anchors[k].bi;
    }
    todo.push([a0, a1, b0, b1]);
  }
  return hunks;
}

/** Lines held once in a[a0, a1) and once in b[b0, b1), by where they are in `a`. */
function uniqueShared(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number): Array<{ ai: number; bi: number }> {
  const seen = new Map<string, { inA: number; inB: number; ai: number; bi: number }>();
  for (let i = a0; i < a1; i++) {
    const c = seen.get(a[i]) ?? { inA: 0, inB: 0, ai: i, bi: -1 };
    c.inA++;
    seen.set(a[i], c);
  }
  for (let j = b0; j < b1; j++) {
    const c = seen.get(b[j]);
    if (c) {
      c.inB++;
      c.bi = j;
    }
  }
  // In `a` order already: a line held once was added to the map where it is.
  return [...seen.values()].filter((c) => c.inA === 1 && c.inB === 1);
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
