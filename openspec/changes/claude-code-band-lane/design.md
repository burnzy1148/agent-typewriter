# Design

## Context

See proposal.md for why, and the delta spec for the behavior. What exists once at-o3z.18 (`claude-code-prompt-band`, PR #106) lands on `claude-code-extension`:

- `bandOf(deck)` in `claude-code/hooks/replay.ts` builds `{ line, isActive, isPaused }`. The line is `BAND_PREFIX` (`Agent Typewriter`), the state and change, ` · <n> queued` from `timeline.pendingCount()` (the followed lane's), and ` · <n> in other lanes` from `pendingTotal() - pendingCount()`.
- `flush` in `register.tsx` writes it to the `band` atom (`band-1`) and passes `line` to `$.ui.status` unless a terminal is attached.
- The `AbovePrompt` hook draws `b.line` in one `Text` with `wrap="truncate-end"`, then three Buttons.
- `viewOf` decides the header's lane inline: `timeline.lanesInBuffer().length > 1` ? `timeline.laneInfo(timeline.followed)` (label and color slot), plus the agent type from `deck.kinds` when it differs from the label. The header draws `<Text color={laneColor(slot)}>●</Text>` then `laneHeaderText(lane)` (label and type, each cut to `MAX_CHIP_LABEL` 24).
- Row tags cut a lane label with `laneTagText` (`MAX_TAG_LABEL` 16).
- `$.ui.status(text: string | undefined)` takes plain text: no color, no nodes.

## Goals / Non-Goals

**Goals:**
- The band and the pane's header never disagree about whether a lane is named or which one.
- The status entry and the band keep reading one line, built in one place.
- No change to `saved`, `view` or `listing`, which .15, .16, .19, .20 and .21 move.

**Non-Goals:**
- The agent type on the band, chips or follow controls on the band, a dot with one lane (proposal).

## Decisions

### One lane lookup shared by the header and the band

Pull the condition and lookup out of `viewOf` into `followedLane(deck): { label, color, kind? } | undefined`: undefined unless more than one lane holds a kept change, else the followed lane's label, color slot and the agent type when it is not the label. `viewOf` keeps its `lane` from it unchanged; `bandOf` uses its `label` and `color`.

Alternative: repeat the condition in `bandOf`. Rejected: the bead exists because the band drifted from the header once already.

### The label sits in the line, after `Agent Typewriter`

`bandOf` builds `[BAND_PREFIX, laneTagText(lane.label), what, queued, other]` when a lane is named, so the status entry, which can only be text, names the lane too, and the band and the status entry stay one string. The label goes right after the prefix, where the header puts it (before the file), and keeps `N queued` reading as that lane's.

Cut to 16 (`laneTagText`), not the header's 24: the band is one row beside three Buttons and cuts its line at the end, so a long label would push the counts off first. 16 is what a row's lane tag uses, so the same lane reads the same in the list and the band.

Alternative: leave the line alone and draw the label only on the band. Rejected: the status entry is the only state shown while the pane is docked and scrolled, and in VS Code, where Claude Code raises no band.

### `Band` carries the lane; the band splits its line around the dot

`Band` becomes `{ line, isActive, isPaused, lane?: { label: string; color: number } }`, where `label` is the cut label as it appears in `line`. The shape tag moves to `band-2`, so a reload from `band-1` starts from `null` and the next `flush` fills it. The status entry still reads `line`.

The hook draws, inside the one truncating `Text`: `${BAND_PREFIX} · `, `<Text color={laneColor(lane.color)}>●</Text>`, then a space and the rest of the line, from the label on. `bandOf` guarantees a lane-naming line starts with `${BAND_PREFIX} · ${lane.label} · `, so the rest is `line.slice(BAND_PREFIX.length + 3)`, and nested `Text` keeps one end-truncation for the whole row. A unit test pins that prefix.

Alternative: store the pieces (`head`, `tail`) instead of `line`. Rejected: the status entry wants the whole string, and two sources for one line invite drift.

Alternative: the dot first in the row, before `Agent Typewriter`, as the mockup draws it. Kept as an owner choice (see below); the default follows the header and the row tags, where the dot sits against the label it colors.

### No change when one lane holds changes

`followedLane` is undefined with one lane, so the line and the band are exactly at-o3z.18's. Existing single-lane tests stay as they are.

## Risks / Trade-offs

- [The line gets longer on a narrow window] → the label is at most 16 characters plus ` · `; the band already cuts at the end, so the other-lanes count goes first. The pane has the full picture one press away.
- [MODIFIED block of a requirement not yet in the living spec] → `openspec validate` reports that archive would refuse it until at-o3z.18 archives. The plugin slot puts .18 first; task 4.1 checks the living spec before archiving.
- [`band-2` drops a saved band on reload] → the band is derived each `flush`; nothing is lost.
- [Splitting the line by a known prefix] → guarded by a unit test; if the line's start changes, the test fails before the band draws a wrong dot.

## Migration Plan

`band` moves to `band-2`; a reload from a version with `band-1` starts from `null` until the next `flush`. Rollback is reverting the change.

## Owner choices

The owner kept all five on 2026-11-22 ("keep .32").


1. Lane named only while more than one lane holds kept changes (as the header), not always (the mockup draws a dot in every state).
2. The label in the shared line, so the status entry names it too; the dot on the band only.
3. Label right after `Agent Typewriter`, dot directly before the label (not at the row's start as in the mockup).
4. Label cut to 16 as row tags, no agent type.
5. Counts unchanged: `N queued` is the named lane's, `N in other lanes` the rest.
