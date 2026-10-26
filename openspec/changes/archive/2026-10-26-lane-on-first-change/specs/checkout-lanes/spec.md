# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: A new worktree waits for its first change
A worktree auto-record picks up SHALL be watched, with baselines taken, but SHALL have no lane until it records its first change. Until then it SHALL NOT be ticked in the Checkouts view, SHALL NOT appear in the lane list, the Changes view or the status bar's checkout count, SHALL NOT count toward the cap, and SHALL NOT be followed. Removed before then, it SHALL leave no lane, and the output channel SHALL name it at most once. Ticked by hand, it SHALL record as a lane the user chose.

#### Scenario: Review worktree re-created
- **WHEN** auto-record is `fill` and a review tool three times runs `git worktree add --detach .claude/worktrees/review-1`, reads files there and removes it
- **THEN** no lane is added, the Checkouts view never ticks it, and the output channel names it at most once each time

#### Scenario: First write gives a lane
- **WHEN** auto-record is `fill`, a new worktree `fix` waits, and an agent writes `src/a.ts` there
- **THEN** a `fix` lane is added, its first change is that write, and the change's before text is the file as it was checked out

#### Scenario: Made again at the same path before a listing
- **WHEN** a waiting worktree is removed and made again at the same path from another commit before worktrees are listed again, and an agent then writes there
- **THEN** git's checkout of it is no first change, and the agent's first change starts from the new checkout's text

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
