import { isFiniteNumber, numberSetting } from './numberSetting';

/**
 * Reads one setting: its value, or `fallback` when it is unset. With `valid`,
 * a value that fails the check counts as unset, and a layered source tries
 * its next layer before giving `fallback`.
 */
export type SettingGetter = <T>(key: string, fallback: T, valid?: (v: unknown) => v is T) => T;

/** A numeric setting's default and the range its value is clamped to. */
export interface NumberSpec {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
}

/** Defaults and limits of the numeric playback settings, the same as package.json declares. */
export const PLAYBACK_NUMBERS = {
  jitter: { default: 0.6, min: 0, max: 1 },
  catchUpFactor: { default: 0.5, min: 0 },
  maxSpeedup: { default: 8, min: 1 },
  maxAnimatedChars: { default: 6000 },
  fileSwitchDelayMs: { default: 1000, min: 0, max: 15000 },
  scrollLinesPerSecond: { default: 60, min: 1 },
  arrowKeysPerSecond: { default: 15, min: 1 },
} as const satisfies Partial<Record<keyof PlaybackSettings, NumberSpec>>;

/** Defaults of the on/off playback settings. */
export const PLAYBACK_SWITCHES = {
  smoothScroll: true,
  arrowNavigation: true,
  naturalOrder: true,
} as const satisfies Partial<Record<keyof PlaybackSettings, boolean>>;

export interface PlaybackSettings {
  /** Language id → base chars per minute. Raw from settings; pace.ts ignores bad entries. */
  languageSpeeds: Record<string, unknown>;
  jitter: number;
  catchUpFactor: number;
  maxSpeedup: number;
  maxAnimatedChars: number;
  /** Beat on the new file's mirror before its first edit. */
  fileSwitchDelayMs: number;
  /** Scroll to the next edit in the same file instead of jumping. */
  smoothScroll: boolean;
  scrollLinesPerSecond: number;
  /** Walk the caret to nearby edits with arrow keys instead of clicking there. */
  arrowNavigation: boolean;
  arrowKeysPerSecond: number;
  /** Type blocks outside in (closing line before the body) instead of top to bottom. */
  naturalOrder: boolean;
}

/**
 * The playback settings `get` reads, with defaults for unset ones. A number
 * that is not finite counts as unset; numbers are then clamped to their
 * limits. An on/off setting is taken as `get` returns it, unchecked, as the
 * extension always has. The base speed and read pause have their own
 * resolvers, in pace.ts and readPause.ts.
 */
export function resolvePlaybackSettings(get: SettingGetter): PlaybackSettings {
  const numbers = {} as Record<keyof typeof PLAYBACK_NUMBERS, number>;
  for (const key of Object.keys(PLAYBACK_NUMBERS) as (keyof typeof PLAYBACK_NUMBERS)[]) {
    numbers[key] = resolveNumber(get, key, PLAYBACK_NUMBERS[key]);
  }
  const switches = {} as Record<keyof typeof PLAYBACK_SWITCHES, boolean>;
  for (const key of Object.keys(PLAYBACK_SWITCHES) as (keyof typeof PLAYBACK_SWITCHES)[]) {
    switches[key] = get(key, PLAYBACK_SWITCHES[key]);
  }
  return { ...numbers, ...switches, languageSpeeds: asRecord(get<unknown>('languageSpeeds', {})) };
}

/** A numeric setting: a value that is not a finite number counts as unset, then the result is clamped. */
export function resolveNumber(get: SettingGetter, key: string, spec: NumberSpec): number {
  return numberSetting(get(key, spec.default, isFiniteNumber), spec.default, spec.min, spec.max);
}

/** A getter over one flat set of values, such as a frontend's own settings object. */
export function recordGetter(values: Readonly<Record<string, unknown>>): SettingGetter {
  return <T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T => {
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    if (v === undefined) return fallback;
    return !valid || valid(v) ? (v as T) : fallback;
  };
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
