# Design

## Context

Auto-record lives in `Recorder.autoRecord()` (`src/recorder.ts`), which `refreshScopes()` runs after each worktree listing. Today it treats a listed worktree as new when it wasn't in `knownWorktrees` for its folder and has no scope, waits out `git worktree add`'s lock, applies the cap and rotation, and saves the folder's choice set through `saveChoiceSet`. `resolveScopes()` turns the choice set into scopes, and `refreshScopes()` gives each scope a watcher and a timeline lane (`defineLane`). A lane therefore exists from the first listing that names the worktree.

Everything else that watches a checkout keys off `this.scopes`: the file watchers, `scopeOf` (which checkout a path belongs to, innermost root first), `passes`, baselines in `captureBaseline`, the git operation watches, the held deletes of a worktree being removed, and the gone checks. Lane-facing answers also read `this.scopes`: `recordedLanes()` (the Checkouts view's ticks), `checkoutOf()` (the status count), `recordedCountExcept()` (the cap for hand picks), and `followFirstLane()`.

A recorded change goes from `flush` through `record()` or `recordRename()` into the reorder buffer, which pushes it to the timeline in write order after `reorderWindowMs`. The change carries its lane id, the scope key.

## Goals / Non-Goals

**Goals:**
- A waiting worktree gets the same watching as a lane (baselines, git operation detection, removal handling), so its first change has the right before text and a removal or a git checkout in it is not mistaken for a change.
- The cap and rotation logic stays in one place, `autoRecord()`, and runs for a first change the way it ran for a new worktree.
- Nothing about a waiting worktree reaches the timeline, the saved choice file or the lane colors until it gets a lane.

**Non-Goals:**
- A new Checkouts view state for waiting worktrees. They show as any unrecorded worktree.
- Persisting waiting worktrees across reloads.

## Decisions

### Waiting checkouts are scopes with a flag

A waiting worktree is a `Scope` with `waiting: true`, kept in `this.scopes` next to the lanes. So watchers, `scopeOf`, baselines, git operation watches, held deletes and gone checks treat it like a lane with no new code, and its first change is recorded exactly as a lane's would be.
- The lane-facing readers skip waiting scopes: `scopesOf()` (and through it `checkoutOf`, `recordedPaths`, `recordedCountExcept`), `recordedLanes()`, `followFirstLane()`, the MAX_LANES slice in `refreshScopes()`, `defineLane`, and the "Recording ... from checkout" log line. A waiting scope that goes away is not a lane that stopped, so `setLaneRecording(false)` is not called for it.
- Considered: a separate map of waiting checkouts with their own watchers. Rejected: it would duplicate the watch, baseline and removal paths, and `scopeOf` would need to consult both maps to keep a nested waiting worktree's files out of the folder's own lane.
- Considered: a hidden lane in the `Timeline`. Rejected: lanes are the recorder's to give, the cap is decided in the recorder, and every timeline reader (views, auto-follow, persistence) would need to learn to skip hidden lanes.

### The waiting set lives in memory, keyed by lane

`Recorder.waiting` maps a lane key to its folder and checkout path. `resolveScopes()` adds a waiting scope for each entry of its folder that git still lists, is not being removed (prunable) and whose root exists, after the chosen ones, and never for a checkout the folder already records. It logs nothing and saves nothing for an entry it drops: `autoRecord()` prunes entries without a waiting scope.
- Not in the choice set, so not in `checkouts.json`, and not restored after a reload. After a reload or a stop and start the worktree is in the first listing and so not new, the same rule as for worktrees made while recording was off.
- The display label is given when the scope is resolved, so the first change's paths match the lane's later ones, but it is kept in `waitingLabels` for the session and saved only once the worktree gets a lane (ticked or promoted). A throwaway worktree so leaves no label in `checkouts.json`, and its name never pushes a later worktree onto a disambiguated label. The lane color is only picked in `defineLane`, so a waiting worktree takes no color.
- One entry per recorded root: when several folders list the same new worktree and would record the same root in it (a multi-root workspace of one repository's worktrees), it waits in the first folder that lists it. Before, it got an empty lane in each later folder too, because `scopeOf` sends a path to the first scope with that root. Folders that are different subdirectories of one repository record different roots in the worktree, so it waits in each of them, as it got a lane in each before.

### `autoRecord()` decides in this order

1. New settled worktrees are found as now. One matching an ignore pattern is logged and skipped as now.
2. Waiting entries stop waiting when auto-record is `off` (silently), when no waiting scope was resolved for them (the worktree is gone or the user ticked it, silently), or when they match a pattern (logged once).
3. Auto-added lanes that came to match a pattern stop, as now, which can free room.
4. Each waiting entry whose first change asked for a lane goes through the existing cap and rotation code that new worktrees went through. It leaves the waiting set either way. Given a lane, it is added to the folder's choice set and `autoAdded`. Refused, the log says why with the existing messages, and it stays in `knownWorktrees`, so it is decided once.
5. New worktrees start waiting while fewer than MAX_WAITING (5, in `src/lanes.ts`) wait, after step 4 so a promotion frees its slot. The log names each once: "Watching the new worktree ... until it records a change." Beyond the limit, the log says it is not recorded because five already wait, and it is decided once like a worktree refused at the cap.

It returns true when a choice set or the waiting set changed, so `refreshScopes()` resolves again.
- Considered: no waiting limit. Rejected: each waiting worktree outside the workspace costs a recursive watcher (inotify watches on Linux) and a baseline walk, and a tool that makes many worktrees at once would get them all. Five more than the lanes is the same order as before, when at most five worktrees were watched.
- Considered: under `fill` at the cap, keeping the worktree waiting and dropping only its change, to retry at its next change. Rejected: the log would repeat at every write, the first change would be lost while later ones are kept, and the lane would start mid-story. Refusing once matches what the old rule did when the worktree appeared.

### A first change waits in write order for the decision

`record()` and `recordRename()` hand changes to `enqueue()` instead of the reorder buffer directly. For a change in a waiting scope it takes a reorder hold at the change's write time, so later changes from other lanes wait behind it, and asks for a lane with `laneFor(lane)`:
- `laneFor` adds the lane to `firstChanges` and runs `refreshScopes()` on the serialized scope queue; `autoRecord()` reads `firstChanges`. The promise resolves true when the scope afterwards records as a lane. One promise per lane, so changes that arrive meanwhile wait on the same decision.
- Given a lane, the change goes into the reorder buffer at the hold's key and the hold ends. Refused, or recording stopped meanwhile, it is dropped with an activity note. A refusal or rotation can drop scopes, so `laneFor` then forgets baselines that no longer pass the filter, as `refreshFilter` does; a checkout ticked again later then gets fresh baselines.
- The hold gives up after LANE_WAIT_MAX_MS (15 s), like the other holds, so a git that hangs can't stall playback; the change then lands late but is not lost.
- `describeActivity()` counts these changes ("waiting for a lane"), so tests that wait for the recorder to settle wait for them too.
- Considered: promoting synchronously in `record()`. Rejected: the cap needs a fresh view of the choice sets, rotation has to stop another lane, and a refresh already in flight could re-apply the old state; running the decision on the scope queue avoids all three.
- Only a change that would reach the timeline asks: a baseline captured for a file it had none for, an own save, an unchanged write and a skipped git operation write do not.

### A removed worktree's baselines go with it

Watchers often report a worktree removed at once as just its directory, so its files' baselines were left behind. Once git no longer lists a worktree nested in the folder, its paths fall to the folder's own scope, where those baselines pass the filter and survive `refreshFilter`'s purge. A review worktree made again at the same path from another commit would then record its first change from the old commit's text. `refreshScopes()` now forgets the baselines under the root of any other-worktree scope it drops when no remaining scope records that root. It keeps those of a checkout still recorded inside that root, such as the folder itself when VS Code is opened on a worktree nested in the main checkout and rotation stops the main checkout's lane.
- Considered: only for waiting scopes. Rejected: a removed lane's worktree has the same problem, and the fix costs nothing extra.

### A worktree made again before the next listing is new again

Each worktree event restarts the 300 ms wait before worktrees are listed again, so `git worktree remove X && git worktree add X <ref>` can reach one listing that still shows X. Its waiting scope then keeps the old checkout's baselines, and the files git checks out for the new one arrive as creates that would count as a first change. `resolveScopes()` therefore remembers the identity (inode, mtime, birth time) of each waiting worktree's `.git` file, which `git worktree add` writes anew. When a listing finds a different one, it forgets the baselines under the root, drops the worktree from `knownWorktrees` and gives it no scope, so `autoRecord()` lets it wait afresh as a new worktree, and the next full refresh takes new baselines. A change read in between is dropped: it can't be told from git's checkout.

Changes already on their way when it waits again are the old checkout's removal or git's checkout of the new one, and `ignoreGitOperations` doesn't always catch them (it may be off). So the new scope gets a new watcher instead of the old scope's, which drops the deletes held for the old checkout. And each waiting entry records when it started waiting (`since`): `flush()` takes a change whose burst began before then as a baseline, or drops it if a delete, rather than as a first change. For a worktree made again, a change whose file (or, for a delete, its directory) was last written before then is treated the same, since git's checkout of the new copy may be reported only after the listing.
- Trade-off: that mtime test is only for worktrees made again. On filesystems with coarse timestamps, an agent's write within the same tick as the listing could read as older; for a new worktree that would cost its first change, so new ones go by event arrival alone.
- Considered: ending the wait on the `worktrees/<name>` delete event in the common git directory. Rejected: it needs a mapping from admin names to paths, and watchers coalesce or drop such events; the listing sees every case.

### Lane decisions and baseline capture

`laneFor()` runs `refreshScopes()` outside `refreshFilter()`, so a decision can drop a scope while a capture is still reading its files. `captureBaseline()` checks `passes()` again just before it stores each baseline, so it never keeps one for a checkout no longer recorded. Running decisions behind `refreshFilter()` instead was rejected: a first change, and every lane's changes held behind it, would wait for a full baseline walk.

`enqueue()` also holds a change while a lane decision for its worktree is still being handed out, not only while the scope is waiting, so a later change of the same file never overtakes the first one.

### Ticking a waiting worktree

The Checkouts view and Choose Checkout read `recordedLanes()`, so a waiting worktree shows unticked. Ticking it adds it to the choice set as any hand pick; `resolveScopes()` then makes it a chosen scope, and `autoRecord()` drops the waiting entry. It is not in `autoAdded`, so a pattern never stops it.

## Risks / Trade-offs

- [A review tool that writes into its worktree, such as `git apply` of a PR diff, still gets a lane at that write] → `autoIgnoreWorktrees` covers tools the user knows about; this change catches the ones that only check out and read.
- [A worktree created just before a reload, or before recording is stopped and started, and not yet written to is no longer auto-recorded afterwards] → It is in the first listing after start, which is the rule for any worktree that existed when recording started. The user can tick it. Persisting the waiting set would leave a trace of throwaway worktrees in workspace storage.
- [The first change in a new worktree reaches the timeline a refresh later than before, and holds other lanes' later changes back meanwhile] → A refresh is one `git worktree list` per folder, normally well under a second; the hold is capped at 15 s.
- [A sixth worktree added while five wait is never auto-recorded, even if it is the one that gets written to] → The output channel says so, and the user can tick it. Five waiting at once means a tool is making many worktrees, which is what the limit is for.
- [Under `fill` at the cap, the first change of a worktree that got no lane is lost] → The same as before, when all of its writes were. The output channel says the cap was reached.

## Migration Plan

No data migration. Lanes already in the choice file keep recording. Users with `fill` or `rotate` see new worktrees get their lane at the first write instead of at once; the changelog says so.
