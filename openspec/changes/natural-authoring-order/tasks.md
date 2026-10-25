# Tasks

## 1. Planner

- [x] 1.1 Add `continues?: boolean` to `Hunk` and `authoringOrder(hunks, after)` to `src/planner.ts` per design.md (indentation-matched blocks, pieces, merged opener and closer, O(1) offsets); verify with unit tests in `test/planner.test.ts` for each `authoring-order` scenario: new function, closing line keeps the rest of its line, empty block, mismatched closer, same-indentation line before a closer, block only partly in the edit, nested if, two blocks in a row, else branch, multi-line parameters, Python, single-line call, a hunk with a deletion, and an edit whose first line starts mid-line
- [x] 1.2 Extend the fuzz test: random block-structured before/after text, and the existing random edits, both round trip through `applyHunks(before, authoringOrder(planHunks(before, after), after))`; the block fuzz asserts that some plans are actually reordered, that hunks other than each original's first carry `continues`, and that the caret never moves across text the same original hunk did not type; verify with `npm test`

## 2. Settings

- [x] 2.1 Add `naturalOrder` (boolean, default `true`) to `Settings`, `readSettings`, `REPO_SETTING_KINDS`, `package.json`, `schemas/agent-typewriter.schema.json`, and the test `Settings` objects; verify `npm run typecheck` and the key-parity tests in `npm test`

## 3. Player

- [x] 3.1 In `Player.play`, apply `authoringOrder` when `naturalOrder` is on; in `navigate`, pass `smooth && !h.continues` to `scrollTo` while keeping `smooth` for the walk; verify by reading that a continuation piece never reaches `readPause` from `scrollTo`, and with `npm run typecheck`

## 4. Docs

- [x] 4.1 Add a line under `## Unreleased` in CHANGELOG.md naming `naturalOrder`; verify the site's generated settings page picks up the new setting from `package.json` (`npm run build` in `site/` if it can run here)

## 5. Integration

- [x] 5.1 Set `naturalOrder: false` in the `it/runTest.ts` workspaces; in `it/suite.ts` PLAY, a change adding a function shows its `}` before its body is typed, the mirror ends equal to the after text, and with `naturalOrder` off the `}` is typed last; verify `npm run it` passes (or note it could not run here)

## Workflow follow-up

- Open a PR to `develop` titled "Type changes in a natural authoring order (at-mfk.3)".
- Once CI is green on Ubuntu and Windows, archive the change on the PR branch and push.
