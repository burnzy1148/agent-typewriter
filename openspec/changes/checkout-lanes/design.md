# Design

## Context

`Recorder` (`src/recorder.ts`) keeps one `Scope` per workspace folder, keyed by folder URI. A scope records either the folder's own checkout or one chosen worktree. Several pieces of state are keyed by folder URI: watchers, gone checks (`goneChecks`, `goneRefreshed`), held deletes (`heldDeletes`, `deleteSettles`), provisional directories and labels. `scopeOf(uri)` already picks the innermost root among chosen scopes and the folder's own scope, and `displayOf` prefixes a chosen worktree's label onto mirror paths, so two checkouts never share a mirror.

`Timeline` (`src/timeline.ts`) is one ordered buffer with one cursor (`cursorSeq`), one `playingSeq`, a `generation` bumped on jumps, and highlight clears. Seqs are contiguous within the buffer (`indexOfSeq` is O(1)). Its consumers are:
- `Player`: `peek`, `begin`, `complete`, `jumps`
- `scrubberState`: `all`, `cursor`, `stateOf`, `pendingCount`
- `HighlightView`: `all`, `cursor`, `playing`, `highlightClears`, `mirrorStates`
- `TimelineView`: `all`, `stateOf`
- `TimelineStore` and the session commands
- `extension.ts`: seek and skip

`CheckoutChoiceFile` (`src/worktrees.ts`) stores one worktree path per folder key, plus labels.

`TimelineStore` caches the JSON of the saved event list keyed by its first and last seq, so any new event re-encodes the whole list on the next save.

## Goals / Non-Goals

**Goals:**
- With one lane in the buffer, behavior and UI are exactly as today. Existing tests pass unchanged except where a spec delta says otherwise.
- Lanes stay a property of recorded data: the recorder tags each change with its lane, and playback reads lanes from the `Timeline`. Neither calls the other.
- "Before" text is captured per lane at record time, as today.

**Non-Goals:**
- Typing more than one lane at a time, or more than one editor group.
- Lanes for two agents in the same checkout. The lane id is opaque, so the hook bead (`at-3hc.1`) can add its own ids later.
- A size-bounded buffer or an on-disk event log (filed as a follow-up bead).
- Pinning lanes against rotation.

## Decisions

### One Timeline, a lane id per change, a cursor per lane

`ChangeEvent` gains `lane: string`. `Timeline` gains:
- `lanes: Map<string, LaneInfo>`, where `LaneInfo` is `{ id, label, root, color, recording }` and is registered by the recorder with `defineLane` / `setLaneRecording`.
- `cursors: Map<string, number>`.
- `followed: string`.

Seqs stay global and contiguous. The existing single-cursor API keeps its signatures and acts on the followed lane:
- `peek` returns the followed lane's next event at or after its cursor.
- `seek`, `seekToStart` and `seekToEnd` move the followed lane's cursor.
- `cursor` and `pendingCount()` report the followed lane.
- `begin` and `complete` advance the event's own lane cursor.

Lane-aware internals:
- `stateOf(seq)`, `mirrorStates()` and `droppedUnplayed` use each event's lane cursor.
- `latestStates()` takes an optional lane.
- `follow(lane)` bumps `generation` and clears `playingSeq`, exactly like a seek, so an in-flight change is overtaken and stays pending.
- New `laneEvents(lane)` and `pendingCount(lane)` serve the scrubber, views and auto-follow.

A lane's cursor is "the seq of the next change to play in this lane". Changes of the lane below it are played. A new lane's cursor starts at the first seq it records. Trimming drops the oldest changes across all lanes, which gives the total `historyLimit` for free. A lane left with no changes and not recording is removed from `lanes`.

Clears gain `lane`. A global clear records one entry per lane at that lane's position (or `playingSeq + 1` in the playing lane). `seek` drops later clears of the followed lane only.

Alternative considered: one `Timeline` per lane, with the player re-pointed at the followed one (proposed during exploration). Rejected for these reasons:
- A total history limit would need a coordinator trimming across timelines.
- Seqs would no longer be unique, so `showDiff` snapshot URIs and the scrubber would need lane-qualified seqs.
- Every consumer would need to be re-bound when the followed lane changes.

Keeping one buffer confines the change to `Timeline`, where the unit tests already are.

### Highlights per lane

`baselines(events, through, clears, heldBack)` is unchanged. `HighlightView` calls it once per lane with that lane's events, that lane's `through` (its cursor, or `playingSeq + 1` for the playing lane) and that lane's clears, then merges the maps. That merge is safe because lanes never share a mirror path.

### Recorder: a scope per recorded checkout

`scopes` becomes keyed by `laneId = folderUri + '\0' + pathKey(checkout root)`. A folder outside git uses its folder URI. `resolveScopes(folder)` returns one scope per chosen checkout. These folder-keyed maps become scope-keyed: `goneChecks`, `goneRefreshed`, `heldDeletes`, `deleteSettles`, `provisional`.

What stays the same:
- `scopeOf` already picks the innermost root, so a nested worktree recorded in its own lane wins over the folder's own scope.
- The own scope's `nested` set still lists every worktree, so a nested worktree with no lane stays unrecorded.

Watchers:
- The folder's own scope watches `folder/**`, as today, and every other scope watches its own root, nested or not.
- Every watcher handler drops an event whose `scopeOf(uri)` is another scope, so a nested lane's files, seen by both the folder's watcher and its own, are read once, by their own scope. (The first draft gave a nested lane no watcher of its own while the folder's own checkout records; dropping foreign events in every handler turned out simpler and also covers nested workspace folders.)

The reorder buffer stays shared across lanes. Each pushed event carries `lane`. Before pushing the first event of a lane, the recorder calls `timeline.defineLane`.

Removed worktree: today's gone check falls back to the folder's own checkout. It now stops that lane (`setLaneRecording(id, false)`) and removes the checkout from the choice. If the folder has no lane left, it records its own checkout, as today.

### Choices file holds a set

`CheckoutChoiceFile` keeps `folderKey -> string | string[]`:
- A string, the old format, means exactly that one checkout.
- A missing entry means the own checkout.
- An array is the chosen set. Paths are compared with `pathKey`, and the own checkout is listed by its path.

New top-level keys, safe because folder keys are URIs:
- `followed`: a lane id.
- `colors`: `pathKey -> slot 1..5`.

The `CheckoutChoices` interface gains `getSet`/`setSet`, plus `followed` and color accessors, with `get`/`set` kept as single-path shims for tests. `Recorder.setCheckout` becomes `setCheckouts(folder, paths[])`. `addCheckout` and `removeCheckout` are used by the view.

### Lane policy is pure: `src/lanes.ts`

Pure functions, so they are unit tested without VS Code:
- `MAX_LANES = 5`, `ROTATE_IDLE_MS = 120_000`, `AUTO_FOLLOW_IDLE_MS = 3000`.
- `colorSlot(remembered, taken)`: the remembered slot if free, else the lowest free one. With more than 5 lanes in the buffer, slots repeat.
- `rotationVictim(lanes, followed, now)`: the recording, non-followed lane with the oldest last change, idle at least `ROTATE_IDLE_MS`, or undefined.
- `autoFollowTarget(lanes, followed)`: the lane whose first pending change has the lowest seq, excluding `followed`, or undefined.
- `laneLabel(checkoutName, folderName, multiRoot)`.
- `defaultLanes(folders)`: the first five folders' own checkouts, plus the names left out.

A lane's last activity is its newest change's `time` in the timeline. With no changes, it is the time it started recording. Rotation never stops a folder's last lane, since a folder always records something.

### Which lane is followed

- The first lane registered is followed when the followed lane does not exist.
- On the first scope refresh after start, the recorder follows the remembered lane if it records, else keeps the followed lane if it records, else the first recorded lane; unless the followed lane still has changes queued (a restored timeline), which keeps it.
- When the followed lane is not recording and has nothing queued, a new change in any other lane makes that lane followed (`Timeline.push`). Without this, a timeline restored from before lanes (lane `''`, all played) would leave new recordings unplayed, and so would changes added after recording stops.
- `extension.ts` saves the followed lane in the choices file whenever it changes.

### Auto-follow controller

A small controller in `extension.ts` listens to `timeline.onDidChange`. When `autoFollow` is on, nothing is playing, and the followed lane has nothing pending, it arms a 3 s timer, disarmed by any timeline change that makes the followed lane busy. On fire, it re-checks and calls `timeline.follow(autoFollowTarget(...))`. The player then picks the new lane up through `peek`, so `Player` needs no changes beyond reacting to `jumps`, which it already does.

### Detecting new worktrees for auto-record

Two detectors exist today:
- The recorder notices a new linked worktree under a recorded root through its `.git` file (`noteWorktreeEvent` → `hideNewWorktree`) and refreshes scopes.
- Sibling worktrees outside the folder are noticed only on a later refresh.

To catch both, each recorded repository's `<common dir>/worktrees/` directory gets a non-recursive watcher. `git worktree add` creates `<name>/` there, which triggers `scheduleWorktreeRefresh()`. On refresh, a worktree listed now that wasn't in the previous listing for that repository is offered to the auto-record policy. A listing that fails changes nothing.

Baselines for an auto-recorded worktree come from the usual capture, which uses git blobs for clean tracked files. An agent write that lands before the capture finishes is captured as a baseline only, as today for files with no baseline.

### Checkouts view

The new `CheckoutsView` (`src/checkoutsView.ts`) is a `TreeDataProvider`. It shows folder nodes only in multi-root, with checkout rows under them:
- `checkboxState` is the recorded state. `onDidChangeCheckboxState` calls `addCheckout`/`removeCheckout`, and a refusal resets the box.
- The icon is `circle-filled` in the lane's theme color. The followed lane gets an `eye` description and the other lanes an inline Follow action. Rows also show the queued count, and "stopped" for stopped lanes.

When not recording, rows come from `checkoutsOf` and the remembered choices. Title bar actions: auto-follow on/off (two commands toggled by a context key) and refresh.

Lanes in the buffer that no current checkout lists, such as a removed worktree or a loaded session, appear under a "Not recording" node, so they can still be followed.

### Container, views and tabs

`package.json`:
- `viewsContainers.activitybar`: `{ id: "agentTypewriter", title: "Agent Typewriter", icon: "images/activity.svg" }`.
- The views `agentTypewriter.checkouts`, `agentTypewriter.timeline` (renamed "Changes") and `agentTypewriter.scrubber` move under it, keeping their ids, so commands and `when` clauses keep working.
- Five colors `agentTypewriter.lane1`…`lane5`, defaulting to `charts.blue`, `charts.green`, `charts.orange`, `charts.purple` and `charts.red`.

A `FileDecorationProvider` for `agent-typewriter:` URIs gives each mirror its lane's `ThemeColor` and a two-character badge (initials of the label). It applies only when the buffer holds more than one lane. It maps a URI to a lane through the newest change at that path.

### Persistence

`SESSION_VERSION = 3`. A session gains:
- `lanes: LaneInfo[]` (`recording` is not saved).
- `cursors: Record<laneId, seq>`.
- `followed: laneId`.
- `lane` on each event.
- `lane` on each `highlightsFrom` entry.

The `cursor` field remains, holding the followed lane's cursor. `parseSession` reads versions 1 and 2 into one lane with id `''` and an empty label, and validates in v3 that every event's lane is declared. `restore` maps every lane cursor by position, like today's cursor.

Load Session restores lanes with `recording: false`, sets every lane cursor to the lane's first change, and follows the saved followed lane. Git replay creates one lane, labeled with the range.

`TimelineStore` replaces the first/last-seq JSON cache with a per-seq JSON string cache. Events are immutable, so a save encodes only new events and joins cached strings. Entries are pruned when their seq is trimmed. The 64M-char cap still counts across every lane.

### Seeking and skipping by lane

`replayFrom` on a change in another lane follows that lane first. `skipToNext` skips the followed lane's playing or next change, not `cursor + 1`, since the next seq may belong to another lane. `seekTo` treats "past the followed lane's newest change" as skip to latest.

### Commands and status bar

- `chooseCheckout` uses `canPickMany` with the recorded checkouts pre-selected. An empty pick is refused. Over five is refused with the cap message. A test-only argument still accepts a path (`string | null`, meaning that one checkout), plus a new `string[]`.
- New `agentTypewriter.followLane` (quick pick, or a lane id argument), `agentTypewriter.autoFollowOn` and `agentTypewriter.autoFollowOff`.
- `statusPresentation` shows the followed lane's name when more than one lane records or the recorded one isn't the folder's own.

## Risks / Trade-offs

- [Recorder refactor from per-folder to per-scope keys touches subtle removal and held-delete logic] → Change keys mechanically first, with the existing `recorderScope`/`recorder` tests green, before adding multi-scope behavior. The integration tests for worktree removal stay as they are.
- [Double recording of a nested lane through two watchers] → Handlers check `scopeOf(uri)` against their own scope, plus a unit test with both watchers firing.
- [Global seqs with per-lane cursors make `seek` and trim edge cases harder] → Keep cursor rules in `Timeline` only, extend `test/timeline.test.ts` with two-lane cases, and add a fuzz case interleaving pushes, follows, seeks and trims, checking the invariant that each lane's played set is a prefix of its events.
- [Moving views out of Explorer surprises existing users] → Container titles match the old names, and VS Code lets users drag views back. Mentioned in the README and release notes.
- [More than five lanes in the buffer (stopped plus recording) repeat colors] → Labels and badges still differ, and the Checkouts view lists them.
- [A rotated-out worktree whose agent resumes is not noticed] → It is listed in the Checkouts view as unticked, and the output channel logs the rotation.
- [Older extension versions refuse a v3 saved timeline] → Same as the v1→v2 bump: the file is moved aside as unreadable on downgrade, and the README notes it.

## Migration Plan

No user action is needed. On first activation:
- An old choices file with a single path reads as that one checkout, so what records is unchanged.
- The followed lane defaults to it.
- A v2 saved timeline restores as one lane.

Rollback means installing the previous version, which ignores the new keys in the choices file. A string entry is kept as a string until the user changes the set, and refuses the v3 timeline as described above.
