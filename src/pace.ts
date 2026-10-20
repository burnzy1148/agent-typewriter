/**
 * Base typing speed for a document: its language's entry in languageSpeeds
 * when that is a positive number, otherwise charsPerSecond. Catch-up and
 * manual speed multiply on top of this.
 */
export function baseCharsPerSecond(
  languageId: string,
  charsPerSecond: number,
  languageSpeeds: Record<string, unknown>,
): number {
  const v = Object.prototype.hasOwnProperty.call(languageSpeeds, languageId) ? languageSpeeds[languageId] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : charsPerSecond;
}
