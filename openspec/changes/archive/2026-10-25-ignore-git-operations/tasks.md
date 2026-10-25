# Tasks

## 1. Git operation detection

- [x] 1.1 Add `src/gitOperations.ts` with the pure parts: the marker list for a checkout's own and common git directories (design 2, 9), a fingerprint of marker stats, the index-entry diff over parsed `ls-files -s` entries (added, removed, blob, mode or stage changed) stored as compact digests, and the classification of one write against recent operation records (path in `changed` or `stashPaths`, write time inside the widened span, agreement from `dirty`/`unmerged`/removed); verify unit tests in `test/gitOperations.test.ts` cover each diff case, span edges with `CAPTURE_SKEW_MS`, a dirty path, an unmerged path, a removal, and an index-only change producing no operation, and `npm test` passes
- [x] 1.2 Add the per-checkout state and refresh on top of `runGit` (`--no-optional-locks`): initial `ls-files -s`, marker stat with a short cache, single-flight refresh per checkout producing an operation record with `git diff --name-only --relative -z` agreement, stash push/pop detection from `refs/stash` with paths from `git diff-tree` including the untracked parent, records kept for one minute, and turning off for the session on `isGitUnavailable`; verify tests on real repositories from `test/gitFixture.ts` for fast-forward merge, branch switch with adds and removes, conflicted merge (unmerged paths), `merge --abort`, rebase, cherry-pick, stash push and pop with `-u`, `git restore` and `stash apply` (no operation or no path), a linked worktree's own git directory, and the repository's status unchanged after every refresh; `npm test` passes

## 2. Recorder integration

- [x] 2.1 Add `agentTypewriter.ignoreGitOperations` (boolean, default true) to `package.json` and `src/config.ts`, applied while recording (state built on turn-on, dropped on turn-off or stop); verify `npm run typecheck` passes and a recorder test toggles it while recording
- [x] 2.2 Classify in `Recorder.flush()` after the own-save decision and before `record()`, `holdDelete()` and rename pairing (design 8): the `index.lock` wait with a `ReorderBuffer.hold()` (100 ms poll, 10 s cap), the 250 ms grace when only `index` changed, skipped writes keeping the new snapshot, re-pointing a git baseline at the new blob when it agrees with stage 0, skipped deletes dropping snapshot and baseline, a trace note per write and one output-channel line per operation; verify `test/recorder.test.ts` cases with real git: merge skipped then the agent's next edit recorded from merged text, an agent write during a merge to an untouched path recorded, an agent write to a merged path with different text recorded, conflict markers skipped and the resolution recorded with marker text as before text, `checkout --theirs` recorded, a moved file recording no rename or held delete, stash/pull/pop recording nothing, `git restore` and `stash apply` recorded, a stale `index.lock` released after the cap, setting off recording everything, and a folder outside git recording everything; `npm test` passes
- [x] 2.3 Cover chosen worktrees: a merge in a recorded sibling worktree records nothing in its lane while an agent edit in the folder's own checkout still records, and a stash push in one worktree is not attributed to another; verify in `test/recorderScope.test.ts` and `npm test` passes
- [x] 2.4 Document `ignoreGitOperations` in the README settings table and a short note on what still records (conflict resolutions, discards, `stash apply`); verify the README entry matches the `package.json` setting name, default and description

## 3. Integration checks

- [x] 3.1 Add an integration test in `it/` (and its launch in `it/runTest.ts` and the `it` script) on a repository with a `feature` branch: while recording, merge with a fast-forward and assert no changes were recorded; write a file as an agent and assert it records from the merged text; merge a conflicting branch, assert nothing recorded, resolve the file on disk and assert one modify from marker text to resolved text; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive the change on the PR branch once tasks are done and CI is green, then squash-merge to `develop` and close at-yd9.
- File anything discovered during implementation as beads with `--deps discovered-from:at-yd9`.
