# Proposal

## Why

With `autoRecordWorktrees` set to `fill` or `rotate`, every worktree added to a recorded repository gets a lane the moment git lists it. Review tools make and remove short-lived worktrees all the time: one was re-created three times in a few minutes and showed up as three lanes, and under `rotate` such worktrees stop real lanes to make room. `autoIgnoreWorktrees` (at-kbn.5) only covers worktrees the user has named. This change is the general safety net: a worktree only gets a lane once something is actually written there.

## What Changes

- **A new worktree waits for its first change.** Auto-record watches it (baselines taken, writes noticed) but gives it no lane. Until it records a change it is not ticked in the Checkouts view, has no lane in the lane list, the Changes view or the status count, does not count toward the 5-lane cap, cannot make `rotate` stop a lane, and cannot be followed or auto-followed.
- **Removed before it records anything, it leaves no trace:** no lane, and the output channel names it at most once, when it starts waiting.
- **Its first recorded change decides.** The cap and rotation rules apply at that moment, as they did when the worktree appeared: `fill` gives it a lane while fewer than 5 record; `rotate` also stops the lane idle longest. Then it is a normal auto-recorded lane, and that change is its first.
- **Full at that moment, it is not recorded.** With `fill` and 5 lanes recording, or `rotate` with no lane idle long enough, that change is not recorded, the worktree is no longer watched, and the output channel says why. This is the decision auto-record used to make when the worktree appeared, made later. The user can still tick it.
- **At most 5 new worktrees wait at once.** A further new worktree is not watched, and the output channel says so. This bounds the watchers and baselines throwaway worktrees can cost.
- A waiting worktree stops waiting when it comes to match `autoIgnoreWorktrees`, or when `autoRecordWorktrees` is turned off. Ticking it in the Checkouts view records it as a lane the user chose.
- Changes that git operations make in a waiting worktree (a checkout, a merge) are skipped as before, so they don't give it a lane.

Out of scope:
- Remembering waiting worktrees across a reload or a stop and start. Worktrees there when recording starts are not new, as before.
- Showing waiting worktrees in the Checkouts view any differently from other unrecorded worktrees.
- Changing how hand-picked checkouts record.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `checkout-lanes`: auto-record gives a new worktree a lane at its first recorded change instead of when it appears; the cap and rotation are decided then; a new requirement describes how a waiting worktree is watched but hidden, and how many may wait.

## Impact

- `src/recorder.ts`: auto-record puts new worktrees in a waiting set instead of the folder's saved choice; waiting checkouts get watchers and baselines but no lane; a waiting checkout's first change asks for a lane and is held in write order until the cap and rotation decide; the waiting set is pruned when a worktree goes, matches a pattern, or auto-record is turned off. Lane counts, recorded lanes and the followed lane leave waiting checkouts out. A dropped worktree's baselines are forgotten with it, so one made again at the same path starts from its own text.
- `src/lanes.ts`: a constant for how many new worktrees may wait at once.
- `package.json`, `schemas/agent-typewriter.schema.json`: `autoRecordWorktrees` descriptions.
- `site/src/content/docs/docs/lanes.md`, `CHANGELOG.md`, the tour's worktree step text in `scripts/tour-scenarios.mjs`.
- Tests: recorder lane tests for waiting, promotion, the cap and rotation at the first change, removal without a trace, and the waiting limit; existing auto-record tests updated to write before expecting a lane; an integration launch that re-creates a review worktree and checks for no lanes.
