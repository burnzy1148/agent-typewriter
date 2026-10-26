# checkout-lanes Specification

## Purpose
Lets several checkouts record at once as separate lanes, each with its own queue, color and label, while the user follows one of them in replay, by hand or automatically.

## Requirements

### Requirement: A lane is one recorded checkout
Each recorded checkout of a workspace folder SHALL be its own lane: the folder's own checkout, another worktree git lists, or the folder itself outside git. Every recorded change SHALL belong to exactly one lane. Each lane SHALL keep its own playback position. All lanes SHALL share one buffer.

#### Scenario: Two checkouts record at once
- **WHEN** the main checkout and the worktree `feature` are both recorded and agents write `src/a.ts` in each
- **THEN** the buffer holds two changes, one in the main checkout's lane and one in the `feature` lane

#### Scenario: Multi-root workspace
- **WHEN** two workspace folders are open, each recording its own checkout
- **THEN** each folder's changes belong to that folder's lane

### Requirement: At most five lanes record
At most five checkouts SHALL record at once across all workspace folders. Adding a sixth SHALL be refused with a message naming the cap. When more than five checkouts would record by default, the first five workspace folders in order SHALL record and the output channel SHALL name the ones that do not.

#### Scenario: Sixth checkout refused
- **WHEN** five checkouts are recorded and the user ticks a sixth in the Checkouts view
- **THEN** the sixth is not recorded, its box stays clear, and a message says at most five checkouts record at once

### Requirement: One lane is followed
Exactly one lane SHALL be followed whenever the buffer holds a change. Only the followed lane's changes SHALL be typed. Changes in other lanes SHALL stay queued in their lanes and SHALL keep being recorded. The followed lane SHALL default to the first workspace folder's recorded lane.

#### Scenario: Other lane keeps recording
- **WHEN** the main checkout's lane is followed and an agent writes three files in the recorded worktree `feature`
- **THEN** nothing from `feature` is typed, and the `feature` lane shows three queued

#### Scenario: A played-out stopped lane gives way
- **WHEN** the followed lane is not recording and has nothing queued, and a change is added to another lane
- **THEN** that lane is followed and its change is typed

#### Scenario: A stopped lane plays out while a recording lane waits
- **WHEN** the followed lane is not recording, its last queued change finishes, and a recording lane has changes queued
- **THEN** that recording lane is followed and its changes are typed

### Requirement: Following another lane
The user SHALL be able to follow any lane in the buffer from the Checkouts view, the Changes view or a Follow Lane command. Following a lane SHALL stop the change being typed, which stays pending in its lane, and resume the newly followed lane at its own position. Following SHALL NOT change whether playback is paused.

#### Scenario: Switch and come back
- **WHEN** the user follows `feature` while the main lane has two changes queued, then follows the main lane again
- **THEN** `feature` plays from its first pending change, and the main lane later resumes with its two queued changes

#### Scenario: Switch mid-change
- **WHEN** a change in the main lane is being typed and the user follows `feature`
- **THEN** typing that change stops, it stays pending in the main lane, and the next change typed is `feature`'s

### Requirement: Auto-follow
With `agentTypewriter.autoFollow` on (default off), once the followed lane has nothing queued and nothing has been typed for 3 seconds, the extension SHALL follow the lane whose oldest pending change was recorded first. It SHALL NOT switch lanes while a change is being typed. Following a lane by hand SHALL leave auto-follow on.

#### Scenario: Tour two agents
- **WHEN** auto-follow is on, the main lane is followed and caught up, and `feature` has two changes queued
- **THEN** after 3 seconds `feature` is followed and its changes are typed

#### Scenario: Busy followed lane
- **WHEN** auto-follow is on and the followed lane keeps getting new changes less than 3 seconds apart
- **THEN** it stays followed while other lanes queue

### Requirement: Auto-record new worktrees
With `agentTypewriter.autoRecordWorktrees` set to `fill` or `rotate` (default `off`), a worktree added while recording to a repository whose checkout is recorded SHALL get its own lane at its first recorded change while fewer than five lanes record, unless it matches an ignore pattern. With `fill` and five lanes recording then, that change and the worktree SHALL NOT be recorded, and the output channel SHALL say why. With `off`, a new worktree SHALL NOT be recorded unless the user adds it.

#### Scenario: Agent creates a worktree
- **WHEN** auto-record is `fill`, the main checkout records, and an agent runs `git worktree add .claude/worktrees/fix` and writes files there
- **THEN** a `fix` lane is added with the first write and records those writes

#### Scenario: Full with fill
- **WHEN** auto-record is `fill`, five lanes record, and a worktree added meanwhile records its first change
- **THEN** that change is not recorded, the worktree gets no lane, later writes there are not recorded, and the output channel says the cap was reached

#### Scenario: Room made before the first change
- **WHEN** auto-record is `fill`, five lanes record, a worktree is added, the user clears another lane's box, and then the worktree records its first change
- **THEN** the worktree gets a lane and that change is recorded

#### Scenario: Ignored worktree with room
- **WHEN** auto-record is `fill`, two lanes record, and a worktree matching an ignore pattern is added
- **THEN** it is not recorded, and two lanes still record

### Requirement: Rotation stops the idlest lane
With `autoRecordWorktrees` set to `rotate` and five lanes recording when a new worktree records its first change, it SHALL take the place of the lane whose latest recorded change is oldest, among lanes that are not followed and have recorded nothing for at least 2 minutes. When no lane qualifies, that change and the worktree SHALL NOT be recorded, and the output channel SHALL say why. A worktree that matches an ignore pattern, or has recorded nothing yet, SHALL NOT stop any lane.

#### Scenario: Idle lane makes room
- **WHEN** rotate is on, five lanes record, `fix/hud` last changed 30 minutes ago and every other lane changed within 2 minutes, and a new worktree records its first change
- **THEN** `fix/hud` stops recording and the new worktree records that change in its own lane

#### Scenario: Every lane busy
- **WHEN** rotate is on, five lanes record, every lane but the followed one changed within the last 2 minutes, and a new worktree records its first change
- **THEN** that change is not recorded, the worktree gets no lane, and the output channel says no lane was idle

#### Scenario: Ignored worktree never evicts
- **WHEN** rotate is on, five lanes record, `fix/hud` has been idle for 30 minutes, and a worktree matching an ignore pattern is added
- **THEN** `fix/hud` keeps recording and the new worktree is not recorded

#### Scenario: A worktree that writes nothing never evicts
- **WHEN** rotate is on, five lanes record, `fix/hud` has been idle for 30 minutes, and a worktree is added and removed without anything written there
- **THEN** `fix/hud` keeps recording

### Requirement: Stopped lanes keep their changes
A lane that stops recording, because the user removed it, rotation stopped it, or its worktree was removed, SHALL keep its recorded changes and playback position in the buffer. It SHALL be shown as stopped and SHALL still be followable until the buffer is cleared or its changes are trimmed.

#### Scenario: Play a stopped lane
- **WHEN** a lane with four queued changes is stopped and the user follows it
- **THEN** its four changes are typed

### Requirement: Lanes are colored and labeled
Each lane SHALL have a label: its branch, or short commit when detached, or the folder name outside git, plus the folder name in a multi-root workspace. Each lane SHALL also have one of five colors that users and themes can override. A checkout SHALL keep its color across reloads while it records. With only one lane in the buffer, no lane label, color or badge SHALL be shown on mirror tabs, the status row or the Changes view; the Checkouts view still shows the lane and marks it as followed.

#### Scenario: Colors stay put
- **WHEN** the `feature` lane is shown in its color, the window is reloaded, and `feature` still records
- **THEN** it is shown in the same color

#### Scenario: Single lane looks as before
- **WHEN** only the folder's own checkout records
- **THEN** the Changes view lists changes without a lane node, and mirror tabs carry no lane badge

### Requirement: Lane shown on mirrors
While the buffer holds more than one lane, every mirror document's tab SHALL carry its lane's color and a short badge, and the playback mirror's status row SHALL start with the lane's label.

#### Scenario: Mirror of the feature lane
- **WHEN** a change in the `feature` lane is being typed and two lanes are in the buffer
- **THEN** its mirror tab shows the `feature` lane's color and badge, and its status row starts with `feature`

### Requirement: Checkouts view
An Agent Typewriter view SHALL list, per workspace folder, its checkout and every other worktree git lists. Each row SHALL show the branch or short commit, path, a box ticked when recorded, the lane color, whether it is followed, its queued count, and whether its lane is stopped. Ticking or clearing a box SHALL start or stop recording that checkout, and a follow action SHALL follow its lane.

#### Scenario: Tick a sibling worktree
- **WHEN** recording is on and the user ticks the worktree at `../repo-feature`
- **THEN** its files get baselines and its next change is recorded in a new lane

#### Scenario: Clear the folder's own checkout
- **WHEN** the user clears the box of the folder's own checkout while `feature` is ticked
- **THEN** writes in the main checkout are no longer recorded, and `feature` keeps recording

#### Scenario: Not recording
- **WHEN** recording is off and the user ticks a worktree
- **THEN** the choice is remembered and applies when recording starts

### Requirement: The followed checkout is marked
The followed lane's row in the Checkouts view SHALL show an eye icon in the lane's color, a tinted label with a play badge, and what it is doing: typing, caught up, or how many changes are queued. The view's header SHALL name the followed lane. This holds with a single lane too, so the view always says where playback goes.

#### Scenario: Two lanes, one typing
- **WHEN** the main checkout and `feature` record, `feature` is followed, and one of its changes is being typed
- **THEN** the `feature` row shows the eye, the tint and badge, and "typing", the main row shows its colored dot, and the header reads "Following: feature"

#### Scenario: A single lane
- **WHEN** only the folder's own checkout records
- **THEN** its row is marked as followed and the header names it

#### Scenario: Follow another lane
- **WHEN** the user follows the main checkout's lane
- **THEN** the mark and the header move to the main row

### Requirement: Changes view groups by lane
While the buffer holds more than one lane, the Changes view SHALL show one node per lane, labeled and colored as the lane, with its queued count, holding that lane's changes newest first. The followed lane's node SHALL come first and be expanded.

#### Scenario: Two lanes
- **WHEN** the main lane and `feature` both have changes and `feature` is followed
- **THEN** the view shows a `feature` node first, expanded, then a main lane node

### Requirement: Agent Typewriter Activity Bar container
Agent Typewriter's views SHALL live in their own Activity Bar container, holding the Checkouts view, the Changes view and the Playback panel.

#### Scenario: Open the container
- **WHEN** the user clicks the Agent Typewriter icon in the Activity Bar
- **THEN** the Checkouts, Changes and Playback views are shown

### Requirement: Lane settings
The settings `agentTypewriter.autoFollow` (boolean, default `false`), `agentTypewriter.autoRecordWorktrees` (`off`, `fill` or `rotate`, default `off`) and `agentTypewriter.autoIgnoreWorktrees` (glob patterns, default empty) SHALL apply while recording and playing without a restart. The Checkouts view's title bar SHALL toggle auto-follow.

#### Scenario: Turn on auto-follow mid-run
- **WHEN** playback is caught up in the followed lane, another lane has queued changes, and the user turns auto-follow on
- **THEN** within 3 seconds the other lane is followed

#### Scenario: Add a pattern mid-run
- **WHEN** auto-record added a lane for `review-1` and the user adds `review-*` to `autoIgnoreWorktrees`
- **THEN** the `review-1` lane stops recording and keeps its changes

### Requirement: Worktree ignore patterns
`agentTypewriter.autoIgnoreWorktrees` SHALL hold glob patterns, default empty. A pattern SHALL match a worktree's absolute path with `/` separators; one without a `/` SHALL match the worktree's directory name. A pattern starting with `branch:` SHALL match the worktree's branch name; a detached worktree SHALL match no `branch:` pattern. A workspace folder's own checkout SHALL never match.

#### Scenario: Directory name pattern
- **WHEN** the patterns are `["review-*"]` and a worktree is at `/repo/.claude/worktrees/review-mr-203`
- **THEN** it matches

#### Scenario: Path pattern
- **WHEN** the patterns are `["**/T/tmp.*"]` and a worktree is at `/private/var/folders/cl/x/T/tmp.L3Sq3tW6o2`
- **THEN** it matches

#### Scenario: Branch pattern
- **WHEN** the patterns are `["branch:review/*"]` and a worktree has branch `review/42` checked out
- **THEN** it matches, and a detached worktree at the same path would not

#### Scenario: Own checkout never matches
- **WHEN** the patterns are `["**"]`
- **THEN** each workspace folder's own checkout still records as before

### Requirement: Auto-record skips ignored worktrees
Auto-record SHALL NOT give a lane to a new worktree that matches an ignore pattern, and the output channel SHALL name the worktree and the pattern. A lane auto-record added that comes to match, after a branch switch or a settings change, SHALL stop recording and keep its changes. Recording a matching worktree by hand SHALL work as for any other.

#### Scenario: Review worktree not recorded
- **WHEN** auto-record is `fill`, the patterns are `["review-*"]`, and a tool runs `git worktree add --detach .claude/worktrees/review-1` and writes files there
- **THEN** no lane is added, nothing from it is recorded, and the output channel says it matched `review-*`

#### Scenario: Branch switch to an ignored branch
- **WHEN** auto-record added a lane for a worktree on `fix/hud`, the patterns are `["branch:review/*"]`, and the worktree switches to `review/42`
- **THEN** its lane stops recording and keeps the changes it recorded

#### Scenario: Recorded by hand
- **WHEN** the patterns are `["review-*"]` and the user ticks `review-1` in the Checkouts view
- **THEN** `review-1` records in its own lane

### Requirement: Auto-follow skips ignored worktrees
Auto-follow SHALL NOT move to the lane of a worktree that matches an ignore pattern. Such a lane SHALL stay followable by hand. Auto-follow SHALL still move away from it when it is followed, caught up and quiet.

#### Scenario: Hand-recorded review lane queues
- **WHEN** auto-follow is on, the main lane is caught up, and a hand-recorded worktree matching `review-*` has two changes queued
- **THEN** the main lane stays followed and the two changes stay queued

#### Scenario: Leaving an ignored lane
- **WHEN** auto-follow is on, the user follows an ignored lane, it is caught up for 3 seconds, and another lane has a change queued
- **THEN** the other lane is followed

### Requirement: Ignore a worktree from the Checkouts view
A worktree row in the Checkouts view, other than a folder's own checkout, SHALL offer an action that asks for a pattern, suggesting the row's directory name with its last `-`, `_` or `.` separated part replaced by `*` when that part contains a digit. Accepting SHALL add the pattern to the workspace setting; cancelling SHALL change nothing.

#### Scenario: Suggest a pattern
- **WHEN** the user runs the action on the row for `.claude/worktrees/review-mr-203`
- **THEN** the input box suggests `review-mr-*`, and accepting adds `review-mr-*` to the workspace's `autoIgnoreWorktrees`

#### Scenario: Name without a trailing number
- **WHEN** the user runs the action on the row for `../repo-feature`
- **THEN** the input box suggests `repo-feature`

### Requirement: A new worktree waits for its first change
A worktree auto-record picks up SHALL be watched, with baselines taken, but SHALL have no lane until it records its first change. Until then it SHALL NOT be ticked in the Checkouts view, SHALL NOT appear in the lane list, the Changes view or the status bar's checkout count, SHALL NOT count toward the cap, and SHALL NOT be followed. Removed before then, it SHALL leave no lane, and the output channel SHALL name it at most once. Ticked by hand, it SHALL record as a lane the user chose.

#### Scenario: Review worktree re-created
- **WHEN** auto-record is `fill` and a review tool three times runs `git worktree add --detach .claude/worktrees/review-1`, reads files there and removes it
- **THEN** no lane is added, the Checkouts view never ticks it, and the output channel names it at most once each time

#### Scenario: First write gives a lane
- **WHEN** auto-record is `fill`, a new worktree `fix` waits, and an agent writes `src/a.ts` there
- **THEN** a `fix` lane is added, its first change is that write, and the change's before text is the file as it was checked out

#### Scenario: A git operation is not a first change
- **WHEN** `ignoreGitOperations` is on, a new worktree waits, and `git checkout` in it rewrites files
- **THEN** it still has no lane

#### Scenario: Never followed while waiting
- **WHEN** auto-follow is on, the followed lane is caught up, and a new worktree waits
- **THEN** auto-follow does not follow it, and Follow Lane does not offer it

#### Scenario: Ticked while waiting
- **WHEN** a new worktree waits and the user ticks it in the Checkouts view
- **THEN** it records in its own lane, and an ignore pattern added later does not stop it

#### Scenario: Comes to match a pattern while waiting
- **WHEN** a new worktree waits and the user adds an `autoIgnoreWorktrees` pattern it matches
- **THEN** it is no longer watched, and a later write there gives it no lane

#### Scenario: Auto-record turned off while waiting
- **WHEN** a new worktree waits and the user sets `autoRecordWorktrees` to `off`
- **THEN** it is no longer watched, and a later write there gives it no lane

#### Scenario: Recording restarted while waiting
- **WHEN** a new worktree waits and recording is stopped and started again
- **THEN** the worktree is no longer new, so auto-record does not watch it, and the user can tick it to record it

### Requirement: At most five new worktrees wait
At most five new worktrees SHALL wait for their first change at once. A worktree added while five wait SHALL NOT be watched or recorded unless the user adds it, and the output channel SHALL say why. A worktree that stops waiting, because it recorded a change, was removed or was dropped, SHALL make room for the next one added.

#### Scenario: Sixth waiting worktree
- **WHEN** auto-record is `fill`, five new worktrees wait, and a sixth is added and written to
- **THEN** the sixth gets no lane, nothing from it is recorded, and the output channel says five new worktrees already wait

#### Scenario: Room after one records
- **WHEN** five new worktrees wait, one of them records its first change, and another worktree is added
- **THEN** the added worktree waits for its first change
