# Tasks

## 1. Speed resolution in characters per minute

- [x] 1.1 In `src/pace.ts`, rename `baseCharsPerSecond` to `baseCharsPerMinute` (same rules, per-minute values) and add `resolveCharsPerMinute(layers, fallback)` returning `{ charsPerMinute, fromDeprecated }` per design.md; update `test/pace.test.ts` to per-minute values and add cases for every typing-pace fallback scenario (old key only, both in one layer, old key above new, new key above old, nothing set → 350, non-number value falls through, result clamped to ≥ 1); verify with `npm test`
- [x] 1.2 In `src/config.ts`, replace `Settings.charsPerSecond` with `charsPerMinute` and add `speedFromDeprecatedSetting`, built by `resolveCharsPerMinute` from the workspace value, the repository file value, and the user value (`cfg.inspect`); verify `npm run typecheck` reports no remaining `charsPerSecond` uses outside the fallback
- [x] 1.3 In `src/player.ts`, compute `cps()` as `baseCharsPerMinute(...) / 60 * speedMultiplier`; verify by reading that every other pacing call still receives characters per second, and with `npm test`

## 2. Settings declarations and repository file

- [x] 2.1 In `package.json`, add `agentTypewriter.charsPerMinute` (number, default 350, minimum 1, "Base typing speed in characters per minute."), give `charsPerSecond` a `markdownDeprecationMessage` pointing to `#agentTypewriter.charsPerMinute#` and drop its default, and rewrite the `languageSpeeds` description to per minute with the `{ "markdown": 600, "json": 1200 }` example and a link to `#agentTypewriter.charsPerMinute#`; verify the Settings UI shows the new setting and the old one as deprecated in a dev host
- [x] 2.2 Mirror 2.1 in `schemas/agent-typewriter.schema.json` (`charsPerSecond` gets `"deprecated": true`) and add `charsPerMinute: 'number'` to `REPO_SETTING_KINDS` in `src/repoSettings.ts`, keeping `charsPerSecond`; update `test/repoSettings.test.ts` examples to `charsPerMinute` and add a case that `{ "charsPerSecond": 10 }` parses with no problems; verify with `npm test`, including the existing key-parity checks against `package.json` and the schema

## 3. User-facing commands and messages

- [x] 3.1 In `src/extension.ts`, change the **Set Playback Speed...** "Base speed..." entry to `<n> chars/min setting`, the input box title to "Base typing speed (characters per minute)", its value to `charsPerMinute`, and the write to `updateSetting('charsPerMinute', ...)`; verify in a dev host that entering 600 writes `agentTypewriter.charsPerMinute: 600` to workspace settings
- [x] 3.2 Add `noteDeprecatedSpeed()` beside `noteUnknownProfile` in `src/extension.ts`, called at the same points (startup, settings change, repository file load), logging once each time `speedFromDeprecatedSetting` turns true that `charsPerSecond` is deprecated and `charsPerMinute` replaces it; verify in a dev host that setting only `charsPerSecond` logs one note and setting `charsPerMinute` logs none

## 4. Docs

- [x] 4.1 In README, change the repository-file example to `"charsPerMinute": 350`, replace the settings-table row with `charsPerMinute` | 350, change the `languageSpeeds` row's example to `{ "markdown": 600 }` with "chars per minute; multiply values set before 0.3.0 by 60", and mention that `charsPerSecond` still works but is deprecated; verify `grep -n charsPerSecond README.md` shows only the deprecation mention
- [x] 4.2 Add an Unreleased section to `CHANGELOG.md`: `charsPerMinute` replaces `charsPerSecond` (still honored, ×60, deprecated), new default 350 per minute (was 35 per second), and a **BREAKING** line that `languageSpeeds` values are now per minute; verify the entry renders in the Markdown preview

## 5. Integration

- [x] 5.1 Move `it/runTest.ts` (600 → `charsPerMinute` 36000) and `it/suite.ts` (20 → 1200, 4000 → 240000, and the "20 cps" comment) to `charsPerMinute`; verify `npm run it` passes
- [x] 5.2 Run `grep -rn -i "charsPerSecond\|per second\|chars/sec" src package.json schemas README.md it test` and confirm every remaining hit is the deprecated fallback, its declaration, its deprecation text, or a test of it; verify `npm test` and `npm run it` both pass

## Workflow follow-up

- Open a PR to `main`; once tasks are done and CI is green on Ubuntu and Windows, archive this change on the PR branch before merging.
