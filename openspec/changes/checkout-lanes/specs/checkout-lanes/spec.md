# Spec Delta

## Purpose

Lets several checkouts record at once as separate lanes, each with its own queue, color and label, while the user follows one of them in replay, by hand or automatically.

## ADDED Requirements

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
With `agentTypewriter.autoRecordWorktrees` set to `fill` or `rotate` (default `off`), a worktree added while recording to a repository whose checkout is recorded SHALL get its own lane while fewer than five lanes record. With `off`, a new worktree SHALL NOT be recorded unless the user adds it.

#### Scenario: Agent creates a worktree
- **WHEN** auto-record is `fill`, the main checkout records, and an agent runs `git worktree add .claude/worktrees/fix` and writes files there
- **THEN** a `fix` lane records those writes

#### Scenario: Full with fill
- **WHEN** auto-record is `fill`, five lanes record, and a worktree is added
- **THEN** it is not recorded and the output channel says the cap was reached

### Requirement: Rotation stops the idlest lane
With `autoRecordWorktrees` set to `rotate` and five lanes recording, a new worktree SHALL take the place of the lane whose latest recorded change is oldest, among lanes that are not followed and have recorded nothing for at least 2 minutes. When no lane qualifies, the new worktree SHALL NOT be recorded and the output channel SHALL say why.

#### Scenario: Idle lane makes room
- **WHEN** rotate is on, five lanes record, `fix/hud` last changed 30 minutes ago and every other lane changed within 2 minutes, and a worktree is added
- **THEN** `fix/hud` stops recording and the new worktree records

#### Scenario: Every lane busy
- **WHEN** rotate is on, five lanes record, and every lane but the followed one changed within the last 2 minutes
- **THEN** the new worktree is not recorded and the output channel says no lane was idle

### Requirement: Stopped lanes keep their changes
A lane that stops recording, because the user removed it, rotation stopped it, or its worktree was removed, SHALL keep its recorded changes and playback position in the buffer. It SHALL be shown as stopped and SHALL still be followable until the buffer is cleared or its changes are trimmed.

#### Scenario: Play a stopped lane
- **WHEN** a lane with four queued changes is stopped and the user follows it
- **THEN** its four changes are typed

### Requirement: Lanes are colored and labeled
Each lane SHALL have a label: its branch, or short commit when detached, or the folder name outside git, plus the folder name in a multi-root workspace. Each lane SHALL also have one of five colors that users and themes can override. A checkout SHALL keep its color across reloads while it records. With only one lane in the buffer, no lane label, color or badge SHALL be shown anywhere.

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
The settings `agentTypewriter.autoFollow` (boolean, default `false`) and `agentTypewriter.autoRecordWorktrees` (`off`, `fill` or `rotate`, default `off`) SHALL apply while recording and playing without a restart. The Checkouts view's title bar SHALL toggle auto-follow.

#### Scenario: Turn on auto-follow mid-run
- **WHEN** playback is caught up in the followed lane, another lane has queued changes, and the user turns auto-follow on
- **THEN** within 3 seconds the other lane is followed
