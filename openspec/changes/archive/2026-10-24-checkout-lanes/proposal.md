# Proposal

## Why

Agents increasingly run side by side, each in its own git worktree (Claude Code puts them under `.claude/worktrees/`). Agent Typewriter records only one checkout per workspace folder, so watching one agent means losing everything the others write. Recording several checkouts at once, each as its own colored lane, lets the user follow one agent while the rest are captured for later, and lets the extension tour every agent's work on its own.

## What Changes

- A **lane** is one recorded checkout of a workspace folder: the folder's own checkout, another worktree git lists, or the folder itself outside git. Up to **5 lanes** record at once. Each records into its own queue with its own playback position, but all lanes share one buffer and the existing history limit.
- Exactly **one lane is followed**: only it is typed out, into the replay editor group, with today's controls. Following another lane picks up where that lane was left. Lanes not followed keep recording and queue up.
- **Choosing checkouts becomes choosing a set.** The folder's own checkout is recorded by default as today. The user can add or remove other worktrees, up to the cap, from a new Checkouts view or the existing Choose Checkout command, which becomes a multi-select. A worktree removed from disk stops its lane. Its recorded changes stay. **BREAKING** (behavior): choosing another worktree no longer stops recording the folder's own checkout. The user unticks it to get today's behavior.
- **Auto-follow** (`agentTypewriter.autoFollow`, default off): once the followed lane is caught up and has been idle for a few seconds, playback moves to the lane whose oldest pending change is oldest. It never switches in the middle of a change.
- **Auto-record** (`agentTypewriter.autoRecordWorktrees`: `off` | `fill` | `rotate`, default `off`): `fill` gives each new worktree of a recorded repository its own lane while there is room. `rotate` also makes room when all 5 are taken by stopping the lane idle longest. That lane must not be the followed one and must have been idle at least 2 minutes. Otherwise the new worktree is not recorded and the log says so. A stopped lane keeps its recorded changes.
- **Lane identity is visible everywhere a change is shown.** Each lane has one of five themeable colors and a label (branch or short commit, plus its folder name). Where that shows up:
  - The Changes tree groups changes under a node per lane.
  - The mirror status row starts with the lane's label.
  - Mirror tabs get the lane's color and a short badge.
  - The status bar shows the followed lane.
  - With only one lane in the buffer, everything looks as it does today.
- **New Activity Bar container.** Agent Typewriter gets its own Activity Bar icon. It holds the new Checkouts view (checkbox = recorded, eye = followed, queue count per lane) plus the Changes and Playback views, which move there from Explorer.
- **Persistence.** The session format moves to version 3. It carries lanes, a playback position per lane, and the followed lane. Version 1 and 2 files load as one lane. Saving encodes each recorded change once and reuses it, so five busy lanes don't rewrite the whole timeline every 2 seconds.

## Capabilities

### New Capabilities
- `checkout-lanes`: lanes: what one is, the cap of five, following one, auto-follow, auto-record with fill and rotate, lane colors and labels, the Checkouts view, and the Activity Bar container.

### Modified Capabilities
- `checkout-scope`: choosing a checkout becomes choosing a set of recorded checkouts per folder. The default (own checkout only), new-worktree handling, the status display, switching, the remembered choice and the fallback when a chosen worktree is removed all change to fit sets.
- `session-persistence`: session format version 3 with lanes, per-lane playback positions surviving a reload, the history limit and the saved-size bound applying across all lanes, and loading older files as one lane.
- `playback-controls`: the scrubber and the playback commands act on the followed lane, the mirror status row names the lane, and the Playback panel moves into the Agent Typewriter container.

## Impact

- `src/timeline.ts`: a lane id on each change and lane metadata. A cursor per lane and a followed lane, with the existing single-cursor API acting on the followed lane. Lane-aware `stateOf`, `mirrorStates`, clears and trimming. Session format v3 with v1/v2 compatibility.
- `src/recorder.ts`: a scope per recorded checkout instead of per folder, with per-scope watchers, gone checks, held deletes and provisional directories. New-worktree detection for auto-record, and lane registration in the timeline.
- `src/worktrees.ts`: `CheckoutChoiceFile` stores a set of checkouts per folder, the followed lane and lane colors, and still reads the old one-path-per-folder file.
- New `src/lanes.ts` (pure): cap, color slots, rotation choice and auto-follow choice. New `src/checkoutsView.ts`: the Checkouts tree with checkboxes.
- `src/timelineView.ts`, `src/scrubberState.ts`, `src/mirrorControls.ts`, `src/highlights.ts`/`src/highlightView.ts`, `src/persistence.ts`, `src/statusText.ts`, `src/extension.ts`: per-lane behavior, wiring, the auto-follow controller and a `FileDecorationProvider` for mirror tabs.
- `package.json`: a `viewsContainers.activitybar` entry with an icon, views moved into it, the Checkouts view, follow/auto-follow commands and menus, two settings, and five `agentTypewriter.lane*` colors. Plus config, the repo settings schema and the README.
- Unit tests for lanes, timeline cursors, sessions v3 and choice files. Integration tests for recording two checkouts at once, following, auto-follow and auto-record.
- Replay still writes only to `agent-typewriter:` mirrors. "Before" text is still captured at record time, per lane. Recording and playback stay decoupled through the `Timeline`.
- Two agents in the **same** checkout still share a lane. Telling them apart needs agent identity from the Claude Code hook bead (`at-3hc.1`), which can later supply its own lane id.
