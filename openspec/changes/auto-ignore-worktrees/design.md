# Design

## Context

Auto-record lives in `Recorder.autoRecord()` (`src/recorder.ts`). It runs after each worktree listing. It treats a listed worktree as new when it wasn't in `knownWorktrees` for its folder and isn't already a scope, and it waits out `git worktree add`'s lock. It then adds lanes, rotating if needed, by saving the folder's choice set through `saveChoiceSet`. The listing gives each worktree's `path`, `head` and `branch` (`Worktree` in `src/worktrees.ts`).

Auto-follow is `AutoFollow` (`src/autoFollow.ts`). It feeds `laneList()` into the pure `autoFollowDecision` / `autoFollowTarget` in `src/lanes.ts`. `LaneInfo.root` is the checkout's absolute path for every lane, including stopped lanes and lanes restored from a saved session.

The common-dir watcher (`watchCommonDirs`) watches `worktrees/*` and `worktrees/*/locked` while auto-record is on. A branch switch inside a worktree rewrites only `worktrees/<name>/HEAD`, which nothing watches today.

A headless reproduction (review-style worktrees, `fill`, auto-follow on) showed:
- `git apply` and plain file copies into a new worktree each recorded 2 changes, and auto-follow moved to that lane.
- A `git checkout` inside the worktree was skipped as a git operation.
- A worktree with no writes still got a lane.

## Goals / Non-Goals

**Goals:**
- Matching is a pure function of the patterns, a checkout's path and its branch, so it can be unit tested without VS Code.
- Auto-follow and auto-record use the same matcher.
- Settings changes take effect at the next listing, with no restart.

**Non-Goals:**
- Filtering files inside a recorded worktree. That is what `include`, `exclude` and `extensions` do.
- Hiding lanes until they record a change (at-kbn.6).
- Dropping changes an ignored lane already recorded.

## Decisions

### Globs with a `branch:` prefix, in one setting

One `string[]` setting, `autoIgnoreWorktrees`. Entries starting with `branch:` match the branch and all others match the path.
- Considered: two settings (paths and branches). Rejected because users would have to look in two places, and the Checkouts action would have to choose which one to write.
- Considered: regex. Rejected because `include` and `exclude` already use globs, and JSON escaping plus compile errors would add a failure mode.

Matching uses `minimatch` the way `src/filter.ts` does: `dot: true`, `matchBase` when the pattern has no `/`, and backslashes turned into `/`.
- Paths are matched case-sensitively except on Windows. `filter.ts` compares paths with `nocase: false`, but Windows paths are case-insensitive and git reports them in varying case.
- Branch patterns match the short branch name (`refs/heads/` already stripped by `parseWorktreeList`).
- Empty and whitespace-only entries are dropped, as `clean()` does in `filter.ts`.

The matcher goes in a new pure module, `src/worktreeIgnore.ts`, with a `suggestIgnorePattern(path)` helper. That keeps `worktrees.ts`, which is about git access, free of settings logic.

### Auto-record checks the pattern where it decides a worktree is new

In `autoRecord()`, a worktree that is new and settled but matches is logged and skipped. It isn't added to `fresh`, so it can never count toward the cap or trigger a rotation. Because it is still added to `knownWorktrees`, removing the pattern later does not auto-record it. It is no longer new, and the user can tick it.

### Auto-added lanes are remembered, so only those stop on a match

`Recorder` keeps `autoAdded: Set<laneKey>` for the session, filled when `autoRecord()` adds a lane. It is keyed by lane, not checkout, because one worktree gets a lane in each folder whose repository lists it, and each is stopped or picked on its own.
- On each pass, any recorded checkout in `autoAdded` that now matches is removed from its folder's choice set, the same way rotation stops a lane, and the reason is logged.
- Hand-picked checkouts are never in `autoAdded`, so a pattern never stops a lane the user chose. That matches "recording by hand is unaffected".
- `setCheckouts` (behind the boxes and Choose Checkout) removes from `autoAdded` only the folder's checkouts it adds or removes, after its checks pass, so a refused change leaves it as it was. `setCheckout`, which picks one checkout for the folder, makes all of the folder's lanes the user's. Choose Checkout lists every recorded checkout already ticked, so leaving an auto-added one ticked keeps it auto-record's. Clearing and ticking it again makes it the user's.
- `autoRecord` marks a checkout auto-added only when the folder's choice did not already hold it when the pass saved, so a box ticked while git was listing stays the user's.
- Considered: persisting `autoAdded` across reloads. Rejected because after a reload every recorded checkout is the user's standing choice.

### Watching HEAD for branch switches

While some pattern starts with `branch:`, `watchCommonDirs` adds `worktrees/*/HEAD` to its glob and also handles change events for HEAD files, since git rewrites HEAD in place. A change event on a `worktrees/<name>` directory only means a write inside it, so it is ignored. A branch switch then schedules a worktree refresh like any other worktree event.
- Only with a branch pattern: commits in a detached worktree, rebase steps and bisect also rewrite HEAD, and each would cost a full refresh for nothing.
- With a branch pattern the common directory is watched even when auto-record is off, so a hand-recorded lane's branch stays current for auto-follow.
- The watcher remembers its glob and is replaced when the patterns change whether HEAD is needed.

### Auto-follow gets a predicate, not settings

`autoFollowTarget` gains an `ignored` flag per lane (`LaneActivity.ignored?: boolean`) and skips flagged lanes. `AutoFollow` takes an `ignored(lane: LaneInfo) => boolean` callback, which `extension.ts` points at `Recorder.autoIgnored(lane)`. The recorder already reads settings and knows each lane's branch. A lane id without a worktree path (a folder's own checkout) never matches:
- **Path patterns** match the lane's checkout: the live scope's, or else the checkout `pathKey` the lane id carries. `LaneInfo.root` would not do, since in a nested workspace folder it sits below the checkout.
- **Branch patterns** use the branch the recorder last listed for that lane, recorded before auto-record runs so a lane stopped for its new branch keeps that branch. Restored lanes from an earlier session have no listed branch, so only path patterns apply to them.

A followed ignored lane is left by the normal rule, since only the target choice changes. `extension.ts` calls `autoFollow.check()` when the setting changes.

### The Checkouts action

A new command `agentTypewriter.ignoreWorktree` is shown in `view/item/context` on checkout and lane rows that are not the folder's own checkout. Own rows get a `.own` suffix on their context value (`checkout.own`, `lane.own`, `lane.followed.own`), and the follow action's `when` clause becomes a regex. The handler is `ignoreWorktreesLike` in `src/checkoutsView.ts`, tested with stubbed input and settings.
- It opens `showInputBox` prefilled with `suggestIgnorePattern(row.checkoutPath)`.
- On accept, it appends the pattern to the patterns that apply now (so ones from the repository file or user settings carry over) and writes the list with `updateSetting`, skipping duplicates.
- Rows in the "Not recording" group (`LaneRow`) get the action too when they have a root.

### Settings plumbing

`autoIgnoreWorktrees` is added to:
- `Settings` / `readSettings` in `src/config.ts`.
- `REPO_SETTING_KINDS` as `stringArray`.
- The repo settings JSON schema in `schemas/`.
- `package.json` configuration.

`extension.ts` treats a change to it like `autoRecordWorktrees` (`refreshFilter('autoIgnoreWorktrees changed')`) and also calls `autoFollow.check()`.

## Risks / Trade-offs

- **Patterns only catch tools the user knows about.** A new tool's checkouts still leak until a pattern is added. The Checkouts action makes adding one a few clicks, and at-kbn.6 is the general safety net.
- **Writes before the stop are kept.** A worktree that switches onto an ignored branch may have recorded changes first, and they stay. Auto-follow won't move to that lane, so they aren't typed unless the user follows it.
- **A path-only pattern can be broad.** `**` matches every worktree. The folder's own checkout is excluded by rule, so a broad pattern can at worst turn auto-record off, never stop the main recording.
- **Lane rows that are the folder's own checkout need a distinct context value.** Existing `when` clauses that compare `viewItem == lane` must keep working. They are switched to regex matches such as `viewItem =~ /^lane/`, and integration tests cover the follow action.

## Migration Plan

Additive. The default is an empty list, so behavior is unchanged until the user sets a pattern. There is nothing to migrate and no session format change.
