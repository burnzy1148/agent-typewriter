# Tasks

## 1. Matching

- [x] 1.1 Add `src/worktreeIgnore.ts` with `ignoringPattern(patterns, checkoutPath, branch)` (path globs with `matchBase` when slash-free, `branch:` entries against the short branch, nothing for detached, empty entries dropped, case-insensitive paths only on Windows) and `suggestIgnorePattern(path)`. Verify with `test/worktreeIgnore.test.ts` covering every scenario in the "Worktree ignore patterns" requirement plus suggestions for `review-mr-203` → `review-mr-*`, `tmp.L3Sq3tW6o2` → `tmp.*` and `repo-feature` → `repo-feature`; `npm test` passes.

## 2. Setting

- [x] 2.1 Add `agentTypewriter.autoIgnoreWorktrees` (string array, default `[]`, markdown description with `review-*`, `**/T/tmp.*` and `branch:review/*` examples) to `package.json`, `Settings`/`readSettings` in `src/config.ts`, `REPO_SETTING_KINDS` as `stringArray`, and the repo settings JSON schema in `schemas/`. Verify with config and repo-settings unit tests that read the value from VS Code settings and from `.agent-typewriter.json`.
- [x] 2.2 Document the setting and the Checkouts action in the docs site's Lanes page (`site/src/content/docs/docs/lanes.md`, which the README links to) next to `autoRecordWorktrees`; the Settings page is generated from `package.json`, so verify the new entry is there.

## 3. Auto-record

- [x] 3.1 In `Recorder.autoRecord()`, skip and log (worktree and matching pattern) a new settled worktree that matches. Keep it in `knownWorktrees` so it never counts toward the cap or rotation. Verify with recorder lane tests for "Review worktree not recorded", "Ignored worktree with room" and "Ignored worktree never evicts".
- [x] 3.2 Track checkouts auto-record added this session (`autoAdded`), cleared when the user ticks that checkout by hand. On each pass, stop any `autoAdded` lane that now matches by removing it from its folder's choice set, keeping its changes, and log why. Verify with recorder tests for "Branch switch to an ignored branch", "Add a pattern mid-run", and "Recorded by hand" (a hand-picked match keeps recording).
- [x] 3.3 Add `worktrees/*/HEAD` to the common-dir watcher glob so a branch switch schedules a worktree refresh. Verify with a recorder test where a HEAD change under the common dir triggers a listing.
- [x] 3.4 Wire `autoIgnoreWorktrees` changes in `src/extension.ts` to `refreshFilter('autoIgnoreWorktrees changed')`, and verify with the "Add a pattern mid-run" test driving a configuration change.

## 4. Auto-follow

- [x] 4.1 Add `ignored?: boolean` to `LaneActivity` and make `autoFollowTarget` skip ignored lanes. Verify with `test/lanes.test.ts` cases for an ignored lane with the oldest pending change.
- [x] 4.2 Give `AutoFollow` an `ignored(lane)` callback built in `extension.ts`: path patterns against `LaneInfo.root`, and branch patterns against the branch the recorder last listed for that lane. Call `autoFollow.check()` on setting changes. Verify with `test/autoFollow.test.ts` for "Hand-recorded review lane queues" and "Leaving an ignored lane".

## 5. Checkouts view action

- [x] 5.1 Give rows that are a folder's own checkout distinct context values (`checkout.own`, `lane.own`, `lane.followed.own`), and switch the follow action's `when` clause to a regex so it still shows on own lanes. Verify with `test/checkoutsView.test.ts` context-value assertions.
- [x] 5.2 Add the command `agentTypewriter.ignoreWorktree` ("Don't Auto-Record Worktrees Like This") on non-own checkout and lane rows. It opens an input box prefilled with `suggestIgnorePattern`, and on accept appends a non-duplicate pattern to the workspace setting; cancel changes nothing. Verify with a unit test of the command handler using the vscode mock for both scenarios of "Ignore a worktree from the Checkouts view".

## 6. Integration

- [ ] 6.1 Add an integration launch built from the review-worktree reproduction: `fill`, auto-follow on, and `autoIgnoreWorktrees` set to `["review-*", "**/T/tmp.*"]`. A `git worktree add --detach` followed by `git apply`, and a temp-dir worktree with copied files, add no lane and record nothing, and auto-follow stays on the main lane. A non-matching worktree still gets a lane. Verify with `IT_GROUP=workspaces npm run it` locally and green CI on Ubuntu and Windows.

## Workflow follow-up

- Open a PR to `develop`. Archive this change on the PR branch once tasks are done and CI is green, then close at-kbn.5 after the merge.
