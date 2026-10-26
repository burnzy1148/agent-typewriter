# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Auto-record new worktrees
With `agentTypewriter.autoRecordWorktrees` set to `fill` or `rotate` (default `off`), a worktree added while recording to a repository whose checkout is recorded SHALL get its own lane while fewer than five lanes record, unless it matches an ignore pattern. With `off`, a new worktree SHALL NOT be recorded unless the user adds it.

#### Scenario: Agent creates a worktree
- **WHEN** auto-record is `fill`, the main checkout records, and an agent runs `git worktree add .claude/worktrees/fix` and writes files there
- **THEN** a `fix` lane records those writes

#### Scenario: Full with fill
- **WHEN** auto-record is `fill`, five lanes record, and a worktree is added
- **THEN** it is not recorded and the output channel says the cap was reached

#### Scenario: Ignored worktree with room
- **WHEN** auto-record is `fill`, two lanes record, and a worktree matching an ignore pattern is added
- **THEN** it is not recorded, and two lanes still record

### Requirement: Rotation stops the idlest lane
With `autoRecordWorktrees` set to `rotate` and five lanes recording, a new worktree SHALL take the place of the lane whose latest recorded change is oldest, among lanes that are not followed and have recorded nothing for at least 2 minutes. When no lane qualifies, the new worktree SHALL NOT be recorded and the output channel SHALL say why. A worktree that matches an ignore pattern SHALL NOT stop any lane.

#### Scenario: Idle lane makes room
- **WHEN** rotate is on, five lanes record, `fix/hud` last changed 30 minutes ago and every other lane changed within 2 minutes, and a worktree is added
- **THEN** `fix/hud` stops recording and the new worktree records

#### Scenario: Every lane busy
- **WHEN** rotate is on, five lanes record, and every lane but the followed one changed within the last 2 minutes
- **THEN** the new worktree is not recorded and the output channel says no lane was idle

#### Scenario: Ignored worktree never evicts
- **WHEN** rotate is on, five lanes record, `fix/hud` has been idle for 30 minutes, and a worktree matching an ignore pattern is added
- **THEN** `fix/hud` keeps recording and the new worktree is not recorded

### Requirement: Lane settings
The settings `agentTypewriter.autoFollow` (boolean, default `false`), `agentTypewriter.autoRecordWorktrees` (`off`, `fill` or `rotate`, default `off`) and `agentTypewriter.autoIgnoreWorktrees` (glob patterns, default empty) SHALL apply while recording and playing without a restart. The Checkouts view's title bar SHALL toggle auto-follow.

#### Scenario: Turn on auto-follow mid-run
- **WHEN** playback is caught up in the followed lane, another lane has queued changes, and the user turns auto-follow on
- **THEN** within 3 seconds the other lane is followed

#### Scenario: Add a pattern mid-run
- **WHEN** auto-record added a lane for `review-1` and the user adds `review-*` to `autoIgnoreWorktrees`
- **THEN** the `review-1` lane stops recording and keeps its changes
