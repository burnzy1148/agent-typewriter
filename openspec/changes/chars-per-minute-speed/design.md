# Design

## Context

The base speed flows from `readSettings()` (`src/config.ts`) as `Settings.charsPerSecond`, through `baseCharsPerSecond()` (`src/pace.ts`), into `Player.cps()` (`src/player.ts`), where all pacing math (ticks per second, per-character delay, backspace steps) works in characters per second. Settings resolve through `layered()`: the workspace value, then the active profile or repository file value, then `cfg.get()` (user setting or default). Profiles only carry filter keys, so the speed settings never come from a profile.

The fallback in the specs is per layer: a layer's `charsPerSecond` counts only when the same layer has no `charsPerMinute`. `layered()` resolves one key at a time, so it cannot express this on its own.

## Goals / Non-Goals

**Goals:**
- One place that decides the base speed in characters per minute, including the deprecated fallback, testable without VS Code.
- Pacing behavior identical to today for the same effective speed (e.g. 2100 per minute types exactly like 35 per second did).

**Non-Goals:**
- Converting or rewriting anyone's stored `charsPerSecond` or `languageSpeeds` values.
- A fallback for `languageSpeeds`: there is no old key to tell old-unit values from new ones.
- Changing manual speed multipliers, catch-up, or the Playback panel, which show multipliers, not base speeds.

## Decisions

**Settings carry characters per minute; the player converts once.** `Settings.charsPerMinute` replaces `charsPerSecond`, `pace.ts` exposes `baseCharsPerMinute(languageId, charsPerMinute, languageSpeeds)`, and `Player.cps()` divides by 60 before applying the multiplier. Alternative: convert per-minute values to per-second in `readSettings()` and leave the player alone. Rejected because `Settings` would then hold a unit no setting uses, and the quick pick shows `readSettings()` values to the user.

**A pure resolver for the per-layer fallback.** `pace.ts` gains `resolveCharsPerMinute(layers, fallback)`: it takes the layers highest first, each as `{ charsPerMinute?: unknown; charsPerSecond?: unknown }`, and returns `{ charsPerMinute, fromDeprecated }` from the first layer that has a finite number in either key, preferring `charsPerMinute` within a layer and multiplying `charsPerSecond` by 60. No layer gives the default, 350. The result is clamped to at least 1, as today. `config.ts` builds the three layers from `cfg.inspect()` (`workspaceValue`, `globalValue`) and the repository values, and puts `fromDeprecated` on `Settings` as `speedFromDeprecatedSetting`. Alternative: register a `charsPerMinute` default of `undefined` and chain two `layered().get()` calls. Rejected because it lets a lower layer's `charsPerMinute` beat a higher layer's `charsPerSecond`, which the spec forbids.

A layer value that is not a finite number is treated as unset at that layer, so a bad workspace value falls through instead of producing `NaN`. Today such a value would break pacing; this is a small robustness gain, not a spec change.

**Keep `charsPerSecond` declared, marked deprecated.** In `package.json` it keeps its `number` type and gets a `markdownDeprecationMessage` pointing to `#agentTypewriter.charsPerMinute#`, and no default (so the Settings UI does not suggest it). The JSON schema keeps the property with `"deprecated": true`. `REPO_SETTING_KINDS` keeps `charsPerSecond: 'number'` so the repository file does not report it as unknown. Alternative: remove it from `package.json`. Rejected: VS Code then greys it out as an unknown setting with no hint of what replaced it.

**Deprecation note follows the `activeProfile` pattern.** `extension.ts` already logs an unknown `activeProfile` once, remembering the last logged value and re-checking on settings and repository-file changes. A `noteDeprecatedSpeed()` does the same with `speedFromDeprecatedSetting`, logging once each time it turns true.

**User-facing text.** The quick pick entry reads `<n> chars/min setting`, the input box title reads "Base typing speed (characters per minute)", and it writes `charsPerMinute`. Setting descriptions become per minute, and the `languageSpeeds` example becomes `{ "markdown": 600, "json": 1200 }`: round per-minute numbers above the new default, rather than the old values times 60, which would be far faster than the default.

## Risks / Trade-offs

- [Existing `languageSpeeds` values become 60x slower] → **BREAKING** entry in the changelog and a note in the README settings table telling users to multiply old values by 60.
- [Users on the default see playback 6x slower] → Intended by the request; 350 per minute is about 70 words per minute, a quick professional typist; catch-up acceleration still caps backlog growth, and the changelog states the new default.
- [Integration tests that set `charsPerSecond` would pass through the fallback and still go green, hiding a broken new setting] → They switch to `charsPerMinute` with the old values times 60 (36000, 1200, 240000), so timing is unchanged and the new key is what they exercise.

## Migration Plan

No data migration. Old `charsPerSecond` values keep working through the fallback; removing the key entirely can be a later change once users have moved. Rollback is reverting the release: the old version ignores `charsPerMinute` and reads `charsPerSecond` as before.
