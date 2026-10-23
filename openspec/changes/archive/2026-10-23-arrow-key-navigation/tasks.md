# Tasks

## 1. Caret path

- [x] 1.1 Add `src/caretPath.ts` with `caretPath(lineText, from, to, maxKeys)` per design.md; add `test/caretPath.test.ts` covering: no keys when there, vertical keeps the column clamped to each line, up and down, word jumps then characters without passing the target both ways, Home and End, too many keys returns undefined, every from/to pair on lines with emoji ends at the target and never stops mid-pair; verify with `npm test`

## 2. Settings

- [x] 2.1 Add `arrowNavigation` and `arrowKeysPerSecond` to `Settings`, `readSettings`, `REPO_SETTING_KINDS`, `package.json`, `schemas/agent-typewriter.schema.json`, and the recorder tests' `Settings` objects; verify `npm run typecheck` and the key-parity test

## 3. Player

- [x] 3.1 Add `Player.navigate` per design.md and call it from `typeHunk`; `scrollTo` and `navigate` share an `inView` helper; verify by reading that every key goes through `ready()` and that the caret always ends at the edit offset

## 4. Docs

- [x] 4.1 Add both settings to the README settings table and a line under `## Unreleased` in CHANGELOG.md

## 5. Integration

- [x] 5.1 Set `arrowNavigation: false` in the `it/runTest.ts` workspaces; in `it/suite.ts` PLAY, a 24-line mirror where a change edits lines 1 and 9 visits every line between; pause mid-walk holds the caret and keeps the change playing; finish current mid-walk ends with the caret on the edit; skip to latest mid-walk snaps the mirror and stops the caret; with `arrowNavigation` off the caret skips the lines between; verify `npm run it` passes
