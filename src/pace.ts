import { isFiniteNumber } from './numberSetting';

/** Base speed when no settings layer sets one. */
export const DEFAULT_CHARS_PER_MINUTE = 350;

/** One settings layer's speed keys, raw. `charsPerSecond` is the deprecated one. */
export interface SpeedLayer {
  charsPerMinute?: unknown;
  charsPerSecond?: unknown;
}

/**
 * The base speed from the first layer (highest priority first) that sets a
 * finite number in either key. Within a layer charsPerMinute wins; a
 * charsPerSecond value counts times 60 and marks the result deprecated.
 */
export function resolveCharsPerMinute(
  layers: readonly SpeedLayer[],
  fallback: number = DEFAULT_CHARS_PER_MINUTE,
): { charsPerMinute: number; fromDeprecated: boolean } {
  for (const layer of layers) {
    if (isFiniteNumber(layer.charsPerMinute)) return { charsPerMinute: Math.max(1, layer.charsPerMinute), fromDeprecated: false };
    if (isFiniteNumber(layer.charsPerSecond)) return { charsPerMinute: Math.max(1, layer.charsPerSecond * 60), fromDeprecated: true };
  }
  return { charsPerMinute: Math.max(1, fallback), fromDeprecated: false };
}

/**
 * Base typing speed for a document, in characters per minute: its language's
 * entry in languageSpeeds when that is a positive number, otherwise
 * charsPerMinute. Catch-up and manual speed multiply on top of this.
 */
export function baseCharsPerMinute(
  languageId: string,
  charsPerMinute: number,
  languageSpeeds: Record<string, unknown>,
): number {
  const v = Object.prototype.hasOwnProperty.call(languageSpeeds, languageId) ? languageSpeeds[languageId] : undefined;
  return isFiniteNumber(v) && v > 0 ? v : charsPerMinute;
}
