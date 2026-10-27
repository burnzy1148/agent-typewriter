# Tasks

## 1. Waiting scopes

- [x] 1.1 Add `waiting` to `Scope`, the in-memory `waiting` map, and MAX_WAITING in `src/lanes.ts`. Make `resolveScopes()` add waiting scopes after the chosen ones, skipping entries git no longer lists, prunable ones, ones whose root is gone and ones the folder records, without logging or saving. Make the lane-facing readers (`scopesOf`, `recordedLanes`, `followFirstLane`, the MAX_LANES slice, `defineLane`, the gone-lane stop and the "Recording ... from checkout" line) skip waiting scopes, and clear the map on `stop()`. Verify with `npm run typecheck` and the existing `npm test` lane tests that don't use auto-record.

## 2. Auto-record decides at the first change

- [x] 2.1 Rework `autoRecord()` in the order the design gives: find new worktrees, prune waiting entries (off, gone or ticked, matching a pattern), stop auto-added lanes that match, run the cap and rotation for waiting entries in `firstChanges`, then start new worktrees waiting up to MAX_WAITING, once per recorded root across folders. Verify with recorder lane tests for "Agent creates a worktree", "Review worktree re-created" (no lane, at most one log line each time), "Comes to match a pattern while waiting", "Auto-record turned off while waiting", "Ticked while waiting", "Sixth waiting worktree" and "Room after one records".
- [x] 2.2 Add `enqueue()` and `laneFor()`: a change in a waiting scope holds its write-order place, asks for a lane through `refreshScopes()`, and goes to the reorder buffer only once the scope records as a lane; otherwise it is dropped. Forget baselines that no longer pass after such a refresh. Count waiting changes in `describeActivity()` and make the recorder test fixtures' settle wait for them. Verify with tests for "First write gives a lane" (before text is the checked-out text), "Full with fill", "Room made before the first change", "Idle lane makes room", "Every lane busy", "A worktree that writes nothing never evicts", "A git operation is not a first change" and "Recording restarted while waiting".
- [x] 2.3 Forget the baselines under a dropped worktree scope's root when no remaining scope records it, so a worktree removed with only its directory reported and made again at the same path starts from its new text. Verify with a recorder test that re-creates a review worktree from another commit and checks the first change's before text, failing without the fix.
- [x] 2.4 Update the existing auto-record tests in `test/recorderScopeLanes.test.ts` and `test/recorderScopeIgnore.test.ts` that expect a lane as soon as a worktree is added, so they write a change first. Verify `npm test` passes.
- [x] 2.5 From review: a waiting worktree made again at the same path before the next listing waits afresh (its `.git` file identity changed); `captureBaseline()` stores only baselines of files still recorded; waiting worktrees' labels are saved only once they get a lane; `enqueue()` waits on a lane decision still being handed out; a failed decision refresh forgets its ask. Verify with recorder tests for each that fail without the fix.
- [x] 2.6 From a second review: a worktree made again drops the old checkout's held deletes and watcher, and changes from before it waited again are baselines, not first changes; a new worktree of a repository whose subdirectories are separate folders waits in each; forgetting a dropped root keeps the baselines of a checkout recorded inside it; git's skipped writes and baselines captured in a waiting worktree are not logged. Verify with recorder tests for each that fail without the fix.
- [x] 2.7 From a third review, after merging folder watches (at-net.15): a worktree git lists as prunable is not known, so one made again after a listing caught it mid-removal waits afresh; a waiting worktree a lane in another folder records stops waiting; `flush()` checks for a change from before the wait after the git verdict too; the watch share is sized for lanes plus waiting worktrees, and a dropped or remade waiting worktree releases its folder watches. Verify with recorder tests for each that fail without the fix.

## 3. Docs and settings text

- [x] 3.1 Update the `autoRecordWorktrees` descriptions in `package.json` and `schemas/agent-typewriter.schema.json`, the Auto-record bullet in `site/src/content/docs/docs/lanes.md`, the tour's add-worktrees step text in `scripts/tour-scenarios.mjs`, and add a CHANGELOG line. Verify the site builds (`npm run build` in `site/`) and the settings page shows the new text.

## 4. Integration

- [x] 4.1 Add an integration launch, `it/waitingWorktrees.ts` started from `it/runTest.ts`, with `fill` and auto-follow on: a review worktree re-created three times and read from gets no lane and leaves the status count at one; a `git checkout` inside a waiting worktree gives it no lane; a worktree written to gets a lane whose first change has the checked-out before text, and auto-follow moves to it. Update `it/lanes.ts` and `it/ignoreWorktrees.ts` steps that expect a lane at once. Verify with `IT_GROUP=workspaces npm run it` locally and green CI on Ubuntu and Windows.

## Workflow follow-up

- Open a PR to `develop` with "(at-kbn.6)" in the title. Archive this change on the PR branch once tasks are done and CI is green, then close at-kbn.6 after the merge.
