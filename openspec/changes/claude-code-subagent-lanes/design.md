# Design

## Context

See proposal.md for why. What the change builds on:

- **The shared `Timeline` already has lanes.** `src/timeline.ts` keeps a cursor per lane, a followed lane, `follow()`, `laneEvents()`, `pendingCount(lane)`, lane infos (`defineLane`, `setLaneRecording`, `laneList`), and `restore()` with a `LaneRestore` (lanes, cursors, followed). `push()` follows a new change's lane when the followed lane has no changes, and a followed lane that is not recording and has played out gives way (`giveWay`). The plugin's `Deck` uses all of it on the default lane `''` today.
- **`src/lanes.ts` is pure.** It imports nothing; `colorSlot`, `autoFollowTarget`, `autoFollowDecision`, `LANE_COLORS` and `AUTO_FOLLOW_IDLE_MS` are what the extension's `AutoFollow` runs on.
- **The plugin already knows each change's agent.** at-o3z.12 stamps `agentId` from `tool.call` on every change and keeps `live.agents` (agentId → main turn and `Agent` call) in the `agents` atom (`agents-1`). `agent.spawn` hands the hook `description` and `subagentType` before the agent runs; the plugin reads neither yet.
- **`turn.start` and `turn.complete` carry `agentId`**, so the plugin can tell when a subagent's loop is in a turn.
- **Engine drawing.** `Text` takes `color` (a theme key or any CSS color); `Button` takes `variant: 'primary' | 'secondary'` and child `Text`; `Box` takes `flexWrap`. Nothing draws on the terminal surface.
- **In flight before this lands** (queue: .14, .27, .16, then .15): captions (at-o3z.14) attach to a change, with no lane concern. By-file groups (at-o3z.27) add a file group's *Play from first*, which "acts as pressing the group's first change in the list". Tabs and marks (at-o3z.16) already scope tabs, baselines and clears to "the followed lane", saying the followed lane is the main conversation's until lanes exist.

## Goals / Non-Goals

**Goals:**
- Reuse the shared `Timeline` lanes and `src/lanes.ts` policy rather than re-implement them, so the extension and the plugin follow and auto-follow the same way.
- Keep a session with one lane drawing exactly as today.
- Keep the delta free of MODIFIED blocks on requirements that at-o3z.27 also modifies, so either archive order leaves both changes' text intact. *Superseded in implementation:* by the time this change was implemented, at-o3z.27 and .16 had archived, so the reason held no longer. Task 6.1 modified *Play from first* and *File tabs over the code view*, and review round 1 added *The list keeps up with playback* and the three clear requirements (see *Corrected in implementation* below).

**Non-Goals:**
- A lane cap, lane rotation, ignore patterns, a Checkouts view: they exist for checkouts the extension chooses to record, and have no counterpart when every lane is an agent of one session.
- Persisting anything beyond the session.

## Decisions

### A lane is an `agentId`; the main conversation is lane `''`

`enqueue` pushes each change with `lane: change.agentId` (absent for the main conversation, which `Timeline` stores as `''`). The `agentId` is already on the change, saved since `saved-4`, so no new per-change field is needed and old saves map onto lanes for free.

A nested agent gets its own lane rather than folding into the subagent the main conversation started. The bead keys lanes by the `agentId` on `tool.call`, and an inner agent can run in parallel with its parent's own edits, which is exactly what lanes separate. Chapters already fold the chain up to the top agent for grouping by turn; lanes answer a different question (whose edit is this).

*Alternative:* one lane per top-level agent (the chain's `agentCallId`). Fewer chips, but an inner agent and its parent would interleave in one lane, which is what lanes exist to stop.

### Lanes are defined at their first change

The plugin calls `timeline.defineLane({ id, label, root: '', color, recording })` when a lane's first change is enqueued, not at `agent.spawn`. A spawn that never edits makes no lane, no chip and no color, and `push()`'s "follow the new lane while the followed one has no changes" gives the *followed lane has no kept change* rule without extra code. The label comes from `live.agents` at that moment, the color from `colorSlot(undefined, colors of lanes in the buffer)`, which gives Main slot 1 when it is first and the least used slot otherwise.

Defining Main up front, as running, would block that: a session whose first change is a subagent's would keep following an empty Main and wait 3 s for auto-follow.

### Running and finished lanes map onto `recording`

Main's lane is defined with `recording: true` and stays so. A subagent lane is `recording` while `live.turns` has its `agentId` (between its `turn.start` and `turn.complete`), toggled with `setLaneRecording`. That reuses `Timeline.giveWay` and `playedOut` unchanged, so with auto-follow off a finished agent's played-out lane hands over to a running lane, matching `checkout-lanes`' stopped-lane scenarios, and Main never gives way while it is followed. A teammate that goes idle between turns counts as finished until it wakes, which is the same thing a stopped checkout is.

`dropEmptyLanes` already forgets a lane that is not recording once its changes are gone; a running lane with no changes left keeps an info entry but draws nothing, since chips and tags come from `lanesInBuffer()`.

### Auto-follow uses `src/lanes.ts` through the bundle

`src/lanes.ts` joins `CORE_ENTRY` in `scripts/build-claude-code.mjs` (it imports nothing, so the neutral-platform bundle accepts it). The deck gains `autoFollow: boolean` (default true) and `quietSince` (epoch ms, set whenever the followed lane types a keystroke, finishes a change, or receives a change). On each tick that types nothing, the plugin calls `autoFollowDecision({ enabled, playing, followed, lanes, quietSince, now })` with each lane's `firstPendingSeq` from the timeline and `ignored` unset, and follows the answer. Time comes from `$.clock.now()` passed into the tick, so replay.ts stays engine-free and tests drive time directly. *Superseded in implementation:* see *The auto-follow clock* under *Corrected in implementation*.

*Alternative:* count ticks (60 ticks = 3 s). Equivalent while the timer runs, but a paused or throttled timer would stretch the wait; the extension measures wall time, and sharing its decision function means sharing its clock model.

The mockup switches the instant a lane plays out. The 3 s quiet comes from `checkout-lanes` and keeps a burst of Main edits from bouncing playback between lanes; the bead asks for the extension's behavior.

Auto-follow defaults on here, against the extension's default off: the mockup draws it on, and the bead describes auto-follow as the normal flow. It is a pane switch kept in `saved`, not a `userConfig` option, because the plugin's options are read at load and an option the pane also toggles would need two sources of truth.

### Controls that move playback

| Control | Timeline operations |
|---|---|
| Press a row or its chip | `follow(laneOf(e))`, then `seek(e.seq)` in that lane |
| Press a lane chip | `follow(lane)`; when it has nothing pending, show its last change done |
| Play turn | for each lane with rows in the chapter: `follow(lane)`, `seek(first row of lane)`; finally `follow` the lane of the chapter's first row |
| From start | for each lane in the buffer: `follow`, `seekToStart()`; finally `follow` the lane of the first kept change |
| Skip to latest | for each lane in the buffer: `follow`, `seekToEnd()`; finally `follow` the lane that was followed |
| Finish current | unchanged: completes the followed lane's current change |

`seek`, `seekToStart` and `seekToEnd` act on the followed lane, hence the follow-then-seek walk. Each bumps the timeline's generation, so a change being typed is overtaken and stays pending, as today.

Play turn and From start move every lane they cover, while pressing a row moves only its lane. A row press means "play from here"; Play turn and From start mean "replay this stretch of the session", which spans lanes. Moving only the first change's lane would leave the turn's other agents' changes played and skip them.

Skip to latest catches up every lane rather than only the followed one (the extension's `seekToEnd`): in the plugin "latest" is the session's latest, and leaving other lanes queued would make auto-follow start typing them right after the skip.

**Controls from the in-flight changes.** at-o3z.27's *Play from first* is defined as pressing the group's first change, so it follows that change's lane by *Play from a picked change*; its own sentence "every change recorded after it follows in recorded order whatever file it changed" becomes "in its lane". at-o3z.16's tabs, baselines and clears are already per followed lane; following another lane shows that lane's tabs, and a pin ends because following moves playback (*Following a lane moves playback*). When this change is implemented, after those archive, task 6.1 rebases the delta onto the archived specs and adds a MODIFIED block for *Play from first*. This delta deliberately states *Following a lane moves playback* as its own requirement instead of modifying *The list keeps up with playback* and the pin requirement, which at-o3z.27 and .16 own. *Superseded in implementation:* once those changes had archived, the list requirement's closed list of presses would have contradicted *Following a lane moves playback*, so the delta modifies it to add a lane's chip. The pin requirement already says "anything that moves playback" and stays as it is.

Pressing a lane chip goes through `move`, so it does everything a press that moves playback does: the list keeps up again, a pin ends, and clears made past where a lane now starts are undone.

### What the pane draws

- **Chip row** (only while `lanesInBuffer().length > 1`), between the header and the code: one `Button` per lane, `variant="primary"` for the followed lane and `"secondary"` for the rest, holding `<Text color={laneColor}>●</Text>`, the label cut to 24 characters, and a dim state (`typing · 1 queued`, `paused`, `2 queued`, `caught up`). Then a `Button` `Auto-follow: on|off`. The row is a `Box flexWrap="wrap"`; the plugin measures chip widths in columns against `bodyColumns` to keep it to two rows and replaces the chips it leaves out with `+N more` text. Keys: `lane:<id>` (Main `lane:main`), `auto-follow`.
- **Header**: while several lanes, `<Text color>●</Text>` and the followed lane's label, `(subagentType)` for an agent, before the file name. The status adds `· N in other lanes` from the timeline's total pending minus the followed lane's.
- **Rows**: while several lanes, a subagent's row gets `● label` (cut to 16 characters) in its tail, before the line counts; `rowLabel` takes the lane tag so the path is cut to make room.
- **Colors**: the five slots map to `blue`, `green`, `orange`, `purple`, `red`, the extension's default order. CSS color names draw on desktop and VS Code, both web surfaces. The plugin cannot read the VS Code theme's `agentTypewriter.lane1..5` colors, so they are not overridable here.

The code view itself is not tinted by lane: at-o3z.16 makes it a unified diff whose colors the surface owns.

### State shapes

- `saved-5`: `{ changes, recorded, isPaused, lanes: SavedLane[], positions: Record<laneId, number>, followed: string, autoFollow: boolean }`. `changes` stay in recorded order. `positions[lane]` replaces `played`: how many of the lane's changes, oldest first, have played. `restore` rebuilds per-lane cursors from `positions` and calls `Timeline.restore`'s lane path, or sets cursors with `follow` plus `seek` per lane; lanes come back with `recording: false` except Main, until their loop's next `turn.start`.
- `savedFrom` reads `saved-4` and `saved-3` as before and derives lanes: each change's lane is its `agentId`; since the old `played` prefix is a prefix of every lane too, `positions[lane]` counts the lane's changes within that prefix; `followed` is `''` when Main has a change, else the first change's lane; `autoFollow` true; labels from the `agents` atom, colors by first change.
- `agents-2`: `AgentLink` gains `description?` and `subagentType?`; `agents-1` reads with neither.
- `View` gains `lane?: { label, kind?, color }` and `otherQueued` (`view-4`); `Listing` gains `lanes: { id, label, color, state, queued }[]`, `followed`, `autoFollow`, and each `Row` a `lane?: string` (`listing-5`). The conversation chip and Play turn chip read `listing` as today and need no lane field.
- `marks-2`: *Added in implementation*, see *Clears belong to a lane* below.

## Risks / Trade-offs

- [A session with many short-lived agents fills the chip row] → chips of caught-up, unfollowed lanes go first, the row stops at two lines with `+N more`, and finished lanes vanish once their changes are dropped.
- [Repeated colors past five lanes] → labels always accompany colors, on chips, the header and rows.
- [Auto-follow on by default could surprise someone watching Main] → the switch is on the chip row in plain words, and turning it off survives a reload.
- [Play turn moving several lanes is new relative to the extension] → it only rewinds lanes that hold changes in that turn; scenarios pin it.
- [The delta's MODIFIED blocks predate at-o3z.27 and .16] → none of them is a requirement those changes modify; task 6.1 re-checks after they archive. *Superseded in implementation:* both had archived before implementation, and the delta now modifies four requirements they added (*Play from first*, *File tabs over the code view*, *The list keeps up with playback*, *Clear marks*) plus two more from .16 (*Seeking back past a clear undoes it*, *Clears survive a reload*). Each MODIFIED block keeps every scenario of the living requirement.
- [`saved-5` shape grows] → `savedFrom` keeps reading every older tag; tests cover each migration.

## Corrected in implementation

### The auto-follow clock

The design said time "comes from `$.clock.now()` passed into the tick". That can't be done as written: `$.clock.now()` returns a promise, and the `$.clock.every` callback that ticks the deck is synchronous, so a tick can't wait for the reading. `tick(deck, opts, now)` still takes the time as an argument, so replay.ts stays engine-free and tests drive time directly. The plugin keeps the time it last read (at load and at each recorded change), moves it on by `TICK_MS` each tick, and reads the clock again for the next tick.

The first version re-read the clock only while nothing was typed, to save a host round trip every 50 ms. Review round 1 showed why that fails. While a change types, the tick-counted time falls behind a slowed timer. The first idle tick's reading then jumps it forward, so the 3 s wait shrinks or vanishes right after a change, and a chip press can be undone at once. The clock is now read on every tick while auto-follow is on and several lanes hold changes, typing or not, so whatever stamps the time is at most a tick old. A session with one lane, or with auto-follow off, still makes no extra reads.

### Clears belong to a lane

The design said at-o3z.16's "clears are already per followed lane" and left them there. In code that meant choosing what a clear means when another lane is followed, and what a seek in one lane does to another lane's clear. Neither choice was in a requirement until review round 1. Each `Clear` gains `lane?`, the lane followed at the press (absent for Main), stored as `marks-2`. Clear marks clears the followed lane only, and a lane's baselines read only its own clears. A move of playback prunes each lane's clears against that lane's own next change, so following or seeking one lane never undoes another's clear. `marks-1` reads as Main's clears. A session-wide clear, as the extension's `clearHighlights()` makes, was the alternative. It would remove the marks of lanes the person has not watched yet. The owner approved the per-lane reading with the round 1 plan, as recommended, and the delta modifies *Clear marks*, *Seeking back past a clear undoes it* and *Clears survive a reload* to say it.

### The header's lane name

The design drew the followed lane's label and agent type in the header uncut. Review round 1 found that a description from the model can run past the pane's width in a row the layout counts as one line, and that a lane labeled by its agent type read `Explore (Explore)`. The header now cuts each to 24 characters, as a chip cuts the label, and leaves out an agent type equal to the label. *The pane names the followed lane* says both, *Added in implementation* in round 2.

## Migration Plan

Within one session, a reload into this version reads `saved-4` (or older) and `agents-1` and builds lanes as above; a downgrade reads `saved-5` as an unknown tag and starts fresh, the existing rule for shape changes. Nothing outlives a session, so there is no cross-session migration.

## Open Questions

None. The row tag's width (16 characters) is a starting value the implementation may tune against the desktop pane; the spec fixes only the chip's 24.
