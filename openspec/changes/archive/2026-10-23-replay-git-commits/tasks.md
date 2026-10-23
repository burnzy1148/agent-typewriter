# Tasks

## 1. Git history reader

- [x] 1.1 Add `src/gitReplay.ts` (`resolveRange`, `listCommits`, `commitChanges`, `buildReplay`, `defaultBase`, `listBranches`, `GitReplayError`) on top of the runner and `readBlob` in `src/gitBaseline.ts`; verify `npm run typecheck` passes
- [x] 1.2 Add `test/gitReplay.test.ts` on real temporary repositories: a branch range in commit order with create, modify and delete; before text from history when the working tree differs; a single commit; a root commit; merges skipped; a workspace folder below the repository top; filtered, binary, oversized, symlink and mode-only changes skipped and counted; invalid and option-like ranges refused; default base detection; and the repository's HEAD, index and status unchanged; verify `npm test` passes

## 2. Command

- [x] 2.1 Add `agentTypewriter.replayGit` to `package.json` (Command Palette and the panel's `...` menu) and `src/extension.ts`: folder pick, range quick pick, cancellable progress, confirmation that names the replaced changes and the stop of watching, the history limit choice shared with Load Session, playback starting at the first change, and the `{ range, folder, play }` argument that skips the dialogs and starts paused unless `play` is set; verify `npm run typecheck` and `npm test` pass
- [x] 2.2 Document Replay Git Commits in the README (choices, what is skipped, that watching stops, that the repository is only read); verify the README matches the command title in `package.json`

## 3. Integration checks

- [x] 3.1 Add `it/gitReplay.ts` and its launch in `it/runTest.ts` on a repository with a `feature` branch: while watching, replay `main..feature` through the command argument, assert watching stopped, the events and their order, playback paused at the first; resume and assert each mirror ends at the branch's text; replay again with `play` and assert it plays to the end without a resume; assert HEAD, the index and the working tree are unchanged and nothing was recorded from disk; replay an invalid range and assert the buffer is unchanged; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Follow-up beads filed: at-dqb.4 (GitHub pull request lookup by number) and at-dqb.5 (showing each change's commit in the panel).
- Archive on the PR branch once tasks are done and CI is green, then merge, then close at-dqb.3.
