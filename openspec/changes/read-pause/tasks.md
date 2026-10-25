# Tasks

## 1. Read-pause logic

- [x] 1.1 Add vscode-free `src/readPause.ts` with `resolveReadPauseSeconds(layers)` and `readPauseLeft(lastEditAt, now, seconds, speed)` per design.md; add `test/readPause.test.ts` covering: default 1.5 when nothing is set, `readPauseSeconds` beats `scrollPauseMs` in the same layer, a higher layer's `readPauseSeconds` beats a lower layer's `scrollPauseMs`, `scrollPauseMs` alone gives value / 1000 and `fromDeprecated`, wrong-typed values count as unset, clamping to 0–15, and `readPauseLeft` returning the remainder, 0 once passed, and half as long at 2x; verify with `npm test`

## 2. Settings

- [x] 2.1 In `src/config.ts`, replace `scrollPauseMs` in `Settings` with `readPauseSeconds` and `readPauseFromDeprecatedSetting`, resolved through `resolveReadPauseSeconds` from the workspace, repository file and user layers; change `fileSwitchDelayMs` to default 1000, clamped 0–15000; update the `Settings` objects in the recorder tests; verify `npm run typecheck` and `npm test`
- [x] 2.2 Add `readPauseSeconds` (number, default 1.5, 0–15) to `REPO_SETTING_KINDS`, `package.json` and `schemas/agent-typewriter.schema.json`; mark `scrollPauseMs` deprecated there with a `markdownDeprecationMessage` pointing to `readPauseSeconds`; set `fileSwitchDelayMs` to default 1000, maximum 15000, and reword its description as the beat on the new tab before typing; verify the key-parity test in `npm test`
- [x] 2.3 Add `noteDeprecatedReadPause` in `src/extension.ts`, modeled on `noteDeprecatedSpeed`: at activation and when `readPauseSeconds` or `scrollPauseMs` changes, it writes one output-channel line while `scrollPauseMs` stands in; verify by reading that it runs from both places and logs once per time the deprecation starts to apply

## 3. Player

- [x] 3.1 In `src/player.ts`, record `lastEditAt` and `lastEditEpoch` in `edit()`. Add `readPause(epoch)`, which does nothing when `lastEditEpoch !== epoch` and otherwise sleeps `readPauseLeft(...)` and then `whilePaused(epoch)`. Raise the `sleep()` cap from 5 s to 15 s and update its doc comment. Verify by reading that every edit path in `play()`, `typeText` and `deleteText` goes through `edit()`
- [x] 3.2 Call `readPause(epoch)` in `play()` before `setPlaybackPath`/`showMirror` when switching from a previous file, and in `moveMirror()` before showing the old path, returning when the change is no longer live; keep the `fileSwitchDelayMs` sleep after `showMirror`; verify `npm test` and `npm run typecheck`
- [x] 3.3 Restructure `scrollTo` per design.md: jump with no wait when `!smooth`, with no viewport, or after finish current; return when in view; otherwise `readPause`, then `ready()`, then jump if `smoothScroll` is off or scroll as today; drop the `humanize(scrollPauseMs)` sleep; update the `scrollTo` doc comment; verify `npm test` and `npm run typecheck`

## 4. Integration

- [x] 4.1 Set `agentTypewriter.readPauseSeconds` to 0 in the integration workspace settings in `it/runTest.ts`, and replace `scrollPauseMs` with `readPauseSeconds` in `it/suite.ts`'s scroll section; verify `npm run it` passes at about its previous duration
- [x] 4.2 Add a read-pause section to `it/suite.ts`: with `readPauseSeconds` 1, an off-screen edit in the same file waits about 1 s after the last edit before the top line changes; a queued change to another file keeps the old mirror active for about 1 s before the new one is shown; a change recorded 2 s after the last one switches with no added wait; with `smoothScroll` off the off-screen edit still waits, then jumps; a seek to a change in another file shows it with no read pause; finish current during the read pause brings the edit into view at once; at the end the mirror text equals the after text; verify `npm run it` passes

## 5. Docs

- [x] 5.1 In the README settings table, add `readPauseSeconds` (1.5), mark `scrollPauseMs` deprecated, and change `fileSwitchDelayMs` to 1000 with its new description; under `## Unreleased` in CHANGELOG.md (add the heading if missing) describe the read pause, the new `fileSwitchDelayMs` default, the deprecation, and **BREAKING**: with `smoothScroll` off, off-screen edits now wait for the read pause (set `readPauseSeconds` to 0 for the old behavior); verify by reading both against the spec

## Workflow follow-up

- Open a PR to `develop` for bead `at-2i9.9` and turn on Auto-fix.
- Archive this change on the PR branch once its tasks are done and CI is green, before merging.
- Close `at-2i9.9` after the merge.
