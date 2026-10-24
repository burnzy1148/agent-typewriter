# Tasks

## 1. Model and session format

- [x] 1.1 Add `rename` to `ChangeKind`, optional `fromUri`/`fromRelPath` to `ChangeEvent`, rename handling in `latestStates` and `mirrorStates`, and session version 2 in `src/timeline.ts` (version 1 still parses, `rename` only from version 2 with its old path); verify `npm run typecheck` passes
- [x] 1.2 Update `test/session.test.ts` (the unknown-kind case, version 1 file, rename round trip, rename in a version 1 file and rename without its old path refused) and `test/timeline.test.ts` (states after a rename); verify `npm test` passes

## 2. Pairing

- [x] 2.1 Add `src/renames.ts` (similarity with the line-ratio bound, partner choice: exact, then similarity, then same name, then nearest key, candidate cap) and `test/renames.test.ts`; verify `npm test` passes
- [x] 2.2 Add `ReorderBuffer.take` in `src/reorder.ts` with tests in `test/reorder.test.ts`; verify `npm test` passes
- [x] 2.3 Pair creates and deletes in `Recorder.record`, including deletes held in a chosen worktree, and add recorder tests on real files: plain rename, rename with an edit, unrelated delete and create, directory move with identical files, moves across the filters, and a rename in a chosen worktree; verify `npm test` passes

## 3. Playback and labels

- [x] 3.1 Add the rename step to `Player.play` and retire renamed-away mirrors in `snap` (small and additive; the typing loop is untouched); verify `npm run typecheck` passes
- [x] 3.2 Rename labels in `src/timelineView.ts`, `src/scrubberState.ts`, `src/scrubberHtml.ts`, and Show Diff in `src/extension.ts`, with tests in `test/scrubberState.test.ts`; verify `npm test` passes

## 4. Git replay

- [x] 4.1 Read renames from `diff-tree -M` in `src/gitReplay.ts` (filtered sides become a create or delete, pure renames kept) and add cases to `test/gitReplay.test.ts`; verify `npm test` passes

## 5. Integration checks and docs

- [x] 5.1 In `it/suite.ts`: a live rename while watching becomes one rename and the new mirror matches disk with no old mirror left; a pushed rename with an edit plays by moving the mirror and typing the edit; verify `npm run it` passes locally and on CI (Ubuntu and Windows)
- [x] 5.2 README and CHANGELOG (`## Unreleased`): renames replay as moves

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge into `develop`, then close at-kbn.2.
