export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A numeric setting's value: anything that is not a finite number (a string,
 * an object, null, NaN, Infinity) gives `fallback`, then the result is clamped.
 */
export function numberSetting(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return Math.min(max, Math.max(min, isFiniteNumber(value) ? value : fallback));
}
