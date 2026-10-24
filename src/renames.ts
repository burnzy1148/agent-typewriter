import { countChanges } from './planner';

/**
 * Pairs the delete and create halves of a rename. Watchers report a rename
 * as a delete of the old path and a create of the new one; the recorder asks
 * here which held change, if any, is the other half.
 */

/** Share of unchanged lines a near match needs: git's default rename threshold. */
export const RENAME_SIMILARITY = 0.5;

/** At most this many candidates are diffed for a near match, nearest in write time first. */
export const NEAR_MATCH_CANDIDATES = 16;

export interface RenameCandidate {
  /** The candidate's text: a delete's before, or a create's after. */
  text: string;
  /** Workspace-relative path, forward slashes. */
  relPath: string;
  /** Write time used to order it. */
  key: number;
}

/**
 * How alike two texts are, from 0 to 1: 1 for identical text, else the
 * unchanged lines over the larger line count. Two empty texts are identical;
 * empty against non-empty is 0.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a === '' || b === '') return 0;
  const la = lineCount(a);
  const lb = lineCount(b);
  const { removed } = countChanges(a, b);
  return Math.max(0, la - removed) / Math.max(la, lb);
}

/**
 * The candidate that is the other half of a rename of `text` at `relPath`,
 * written at `key`: identical text first, then the most similar at
 * RENAME_SIMILARITY or above; ties go to the same file name, then the
 * nearest write time. Undefined when none is alike enough.
 */
export function pickRenamePartner<T extends RenameCandidate>(
  text: string,
  relPath: string,
  key: number,
  candidates: readonly T[],
): T | undefined {
  const name = baseName(relPath);
  const better = (a: { c: T; score: number }, b: { c: T; score: number } | undefined) => {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    const an = baseName(a.c.relPath) === name;
    if (an !== (baseName(b.c.relPath) === name)) return an;
    return Math.abs(a.c.key - key) < Math.abs(b.c.key - key);
  };
  let best: { c: T; score: number } | undefined;
  for (const c of candidates) {
    if (c.text === text && c.relPath !== relPath) {
      const found = { c, score: 1 };
      if (better(found, best)) best = found;
    }
  }
  if (best || text === '') return best?.c;

  const lines = lineCount(text);
  const near = candidates
    .filter((c) => c.text !== '' && c.relPath !== relPath)
    // The line-count ratio bounds the similarity, so these cannot reach the threshold.
    .filter((c) => {
      const n = lineCount(c.text);
      return Math.min(n, lines) / Math.max(n, lines) >= RENAME_SIMILARITY;
    })
    .sort((a, b) => Math.abs(a.key - key) - Math.abs(b.key - key))
    .slice(0, NEAR_MATCH_CANDIDATES);
  for (const c of near) {
    const score = similarity(c.text, text);
    const found = { c, score };
    if (score >= RENAME_SIMILARITY && better(found, best)) best = found;
  }
  return best?.c;
}

/** Lines as countChanges counts them: a final line without a newline counts too. */
function lineCount(text: string): number {
  if (text === '') return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n : n + 1;
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}
