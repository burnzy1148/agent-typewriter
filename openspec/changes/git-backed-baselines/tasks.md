# Tasks

## 1. Pure logic

- [x] 1.1 Add `src/gitBaseline.ts` with `parseLsFiles`, `parsePathList` (for `ls-files -m -z`), and `classifyClean` and verify unit tests in `test/gitBaseline.test.ts` cover `-z` parsing, non-zero stages, non-regular modes (symlink, gitlink), worktree-modified files, and paths with spaces
- [x] 1.2 Add pure `selectWithinBudget` and verify unit tests cover newest-first order, exact fit, a single file over budget being skipped, and a zero budget

## 2. Git access

- [x] 2.1 Add the process layer (`execFile` with `--no-optional-locks`, `GIT_TERMINAL_PROMPT=0`, timeout) with `listCleanTracked(folder)` and `readBlob(root, path, sha)` that return `undefined` on any failure, and a git-unavailable signal (ENOENT, EACCES, timeout) distinct from not-a-repo; verify unit tests with an injected runner cover not-a-repo, git-missing, and success

## 3. Recorder and settings

- [x] 3.1 Add `gitBaselines` and `baselineBudgetMB` to `package.json` and `config.ts`, add both to the README settings table, and replace the README's 5000-file limitation line; verify `npm run typecheck` passes and the README matches the defaults
- [x] 3.2 Rework `captureBaseline` to classify git-clean files when enabled, then budget-select the rest by mtime, turn git baselines off for the session with one log line when git is unavailable, and log uncovered counts; verify existing integration sections still pass
- [x] 3.3 Load and consume a git baseline in `flush` when no snapshot exists, including deletes, and log load failures; verify unit and integration tests pass
- [x] 3.4 Add `recorder.refreshBaselines()` for toggling `gitBaselines` and changing the budget, and call it from `onDidChangeConfiguration`; verify through the integration sections in group 4

## 4. Integration checks

- [x] 4.1 Make the `it/runTest.ts` workspace a git repo with an initial commit (including new `src/committed*.ts` files), and verify all existing sections still pass
- [x] 4.2 Add a section that sets budget 0 and `gitBaselines` on, restarts watching, edits a committed file, and asserts one change with the committed text as before and the mirror matching disk; also assert `.git/index` and `HEAD` are byte-identical before and after; verify it fails with `gitBaselines` off
- [ ] 4.3 Add a section that toggles `gitBaselines` off (budget restored) and on (budget 0) while watching and asserts the first edit to a committed file is recorded in each case; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-net.5 after the merge.
