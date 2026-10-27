import { isFiniteNumber } from './numberSetting';

/** Read pause when no settings layer sets one, in seconds. */
export const DEFAULT_READ_PAUSE_SECONDS = 1.5;
/** The longest read pause, in seconds; longer values are clamped to it. */
export const MAX_READ_PAUSE_SECONDS = 15;

/** One settings layer's read-pause keys, raw. `scrollPauseMs` is the deprecated one. */
export interface ReadPauseLayer {
  readPauseSeconds?: unknown;
  scrollPauseMs?: unknown;
}

/**
 * The read pause from the first layer (highest priority first) that sets a
 * finite number in either key, clamped to 0 to 15 s. Within a layer
 * readPauseSeconds wins; a scrollPauseMs value counts divided by 1000 and
 * marks the result deprecated.
 */
export function resolveReadPauseSeconds(layers: readonly ReadPauseLayer[]): { readPauseSeconds: number; fromDeprecated: boolean } {
  const clamp = (s: number) => Math.min(MAX_READ_PAUSE_SECONDS, Math.max(0, s));
  for (const layer of layers) {
    if (isFiniteNumber(layer.readPauseSeconds)) return { readPauseSeconds: clamp(layer.readPauseSeconds), fromDeprecated: false };
    if (isFiniteNumber(layer.scrollPauseMs)) return { readPauseSeconds: clamp(layer.scrollPauseMs / 1000), fromDeprecated: true };
  }
  return { readPauseSeconds: DEFAULT_READ_PAUSE_SECONDS, fromDeprecated: false };
}

/**
 * Milliseconds still to wait before the view may leave what was typed at
 * `lastEditAt`: the read pause divided by the speed multiplier, less the time
 * already passed. 0 once it has passed.
 */
export function readPauseLeft(lastEditAt: number, now: number, seconds: number, speed: number): number {
  return Math.max(0, (seconds * 1000) / speed - (now - lastEditAt));
}
