import { normalizeEol } from './planner';

/**
 * What a settled write means given the text the latest VS Code editor save
 * wrote to that file (LF-normalized), if any.
 *
 * - `external`: no editor save to compare against; record as usual.
 * - `own`: the disk holds exactly what the editor saved; nothing to replay.
 * - `after-own`: something wrote after the save; replay only that, from the saved text.
 *
 * A save that never finished (will-save fired, did-save did not) may have
 * written nothing, so its text only counts as a match: a differing disk text
 * is `external`, recorded from the previous disk text.
 */
export type OwnSaveDecision = { kind: 'external' } | { kind: 'own' } | { kind: 'after-own'; before: string };

export function decideOwnSave(savedText: string | undefined, diskText: string, finished = true): OwnSaveDecision {
  if (savedText === undefined) return { kind: 'external' };
  const saved = normalizeEol(savedText);
  if (saved === normalizeEol(diskText)) return { kind: 'own' };
  if (!finished) return { kind: 'external' };
  return { kind: 'after-own', before: saved };
}
