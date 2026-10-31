# Proposal

## Why

The Claude Code plugin's pane shows only the change it is typing. Since at-o3z.5 and at-u1t it keeps the session's changes in the shared `Timeline`, played ones included, across a reload, but the person can neither see them nor go back to one. at-o3z.3 makes that history usable: a list of the session's changes, replay from the start, and playing from any change in the list, as the VS Code extension's Changes view and seek already do. Linking changes to turns, chapters, captions, file tabs and the scrubber (at-o3z.12, .13, .14, .16, .19) all build on this list.

## What Changes

- **The pane lists the session's changes.** Under the code and the playback controls, the pane lists every change it keeps, oldest first. Each row shows whether the change has played, is being typed, is next or is queued; its number in the session's recording order; the tool that made it (`Edit` or `Write`); its path; and the lines it adds and removes. The row of the change the pane shows names its state: Typing, Paused, Next or Too large. A too-large change that has passed reads Not typed. When older changes were dropped to stay within the limits, the list says how many.
- **Pick a change to play from it.** Pressing a row makes that change the next one typed. Later changes follow in recorded order, earlier ones count as played, and whether playback is paused does not change. While paused, the pane shows the picked change as it was before it, marked next, until playback resumes. Picking the change being typed starts it over.
- **From start.** A new control plays from the first change the pane keeps, as picking the first row does.
- **Finish current covers a picked change.** While paused, Finish current shows the picked change done, and the change after it becomes next.
- **The list keeps up.** The list shows as many rows as fit below the code and keeps the change the pane shows in view. When the person scrolls the list it stays where they put it, until they press a change or another control that moves playback.
- **Hotkeys.** With the pane focused, `r`, `p`, `f` and `l` press From start, Pause or Resume, Finish current, and Skip to latest.
- **Numbers and tools survive a reload.** The saved state keeps each change's number and tool, and its tag moves from `saved-2` to `saved-3`. State saved under `saved-2` or `saved-1` still loads: its changes are numbered by their place, counting back from the number of changes recorded, and show no tool. A reload while paused shows the next change as a pick while paused does.

Out of scope, and kept possible:
- Grouping the list by turn, Play turn, Show in conversation, lane tags, captions and the hover card (at-o3z.12, .13, .14, .15). Rows stay one per change and carry the change's id, so a row can later gain a chip, a lane dot, a reveal button and a turn header.
- File tabs, diff marks and the scrubber (at-o3z.16, .19).
- Grouping the list by file, which no bead covers yet; it is filed as a follow-up.
- The VS Code extension, whose Changes view and seek are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds the changes list, playing from a picked change, From start, and the list keeping up; extends "Playback controls" (From start, hotkeys, Finish current on a picked change), "Pane names the file" (a picked change while paused), "Recorded changes last for the session" (numbers, tools, a reload while paused), and "Changes saved by an earlier version still load" (numbers and tools for `saved-2` and `saved-1` state).

## Impact

- `claude-code/hooks/replay.ts`: `Change` gains `number` and `tool`; new `seek`, `replayFromStart`, `listingOf` and `listWindow`; `finish` finishes a picked change; `restore` and `savedFrom` read `saved-3`, `saved-2` and `saved-1`.
- `claude-code/hooks/register.tsx`: `record()` passes the tool; a `listing` atom holds the rows; the pane draws the list, From start and the hotkeys; a `ui.scroll` hook scrolls the list.
- `claude-code/types/index.d.ts`: `SavedChange` gains `number` and `tool`; new `Listing` and `Row` types and a `listing` state key.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the list's states, From start, a pick while paused and while playing, the list keeping up, and a pick across a reload.
- `claude-code/README.md`: the list, From start, picking a change, and the hotkeys.
- No shared module (`src/timeline.ts` and the rest bundled into `core.mjs`) changes: the plugin uses `Timeline.seek` as the extension does.
