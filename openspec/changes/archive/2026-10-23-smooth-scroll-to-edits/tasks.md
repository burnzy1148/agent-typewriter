# Tasks

## 1. Scroll path

- [x] 1.1 Add `src/scroll.ts` with `SCROLL_FRAME_MS`, `SCROLL_MAX_MS`, `centeredTop(line, height, lineCount)` and `scrollSteps(from, to, height, linesPerSecond, speed)` per design.md; add `test/scroll.test.ts` covering: no steps when already there, last step is the target, steps move monotonically both ways, a jump to within `2 * height` for long distances, frame count capped at one second (and halved at 2x), `centeredTop` clamping at both ends; verify with `npm test`

## 2. Settings

- [x] 2.1 Add `smoothScroll`, `scrollPauseMs`, `scrollLinesPerSecond` to `Settings` and `readSettings` in `src/config.ts`, to `REPO_SETTING_KINDS`, `package.json`, and `schemas/agent-typewriter.schema.json`, and to the `Settings` objects in the recorder tests; verify `npm run typecheck` and the key-parity test in `npm test`

## 3. Player

- [x] 3.1 Add `Player.scrollTo` and the `smooth` flag on `typeHunk` per design.md; `play()` passes `false` for the first hunk after a file switch or the first change played; verify by reading that every frame goes through `ready()` and that the caret is set after the scroll

## 4. Docs

- [x] 4.1 Add the three settings to the README settings table and a line under `## Unreleased` in CHANGELOG.md

## 5. Integration

- [x] 5.1 In `it/suite.ts` PLAY: a 400-line mirror where a change edits lines 3 and 350 scrolls through several increasing top lines and ends with line 350 in view and the after text; pause mid-scroll holds the top line and keeps the change playing; finish current and skip to latest mid-scroll leave the edit in view and the after text; with `smoothScroll` off the view takes at most two top lines; verify `npm run it` passes
