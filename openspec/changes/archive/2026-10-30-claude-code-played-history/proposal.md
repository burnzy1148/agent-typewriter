# Proposal

## Why

Since at-o3z.5 the Claude Code plugin keeps its changes in the shared `Timeline`, played ones included, but a reload of the plugin (a changed option causes one) brings back only the change being typed and the waiting ones. What it saves also lacks each change's kind and recording time, so the timeline events a reload builds carry placeholders. at-o3z.3's changes list, replay from start and seek need the played history, with real kinds and times, to outlast a reload, so this comes first.

## What Changes

- **Played changes survive a reload.** The plugin saves every change its timeline keeps, played or waiting, and which of them had played. After a reload the played ones stay played and the waiting ones play on. The change being typed still starts over.
- **Played changes keep their texts.** A change's before and after texts stay saved until the timeline drops the change, instead of being cleared once it has played.
- **Each change keeps its kind and time.** The plugin saves whether a change created its file or modified it, and when it was recorded, and a reload restores both on the timeline's events instead of `modify` and `0`.
- **The pane picks up where it was.** After a reload, the pane shows the last played change's file and after text until the next change starts, as it did before the reload, instead of "No changes yet".
- **One limit for played and waiting changes.** The spec now says what the plugin has done since at-o3z.5: at most 200 changes and 20,000,000 characters of text are kept in all, played or waiting, and past either limit the oldest go first, which are the played ones.
  - *Superseded in implementation:* the limit applies besides the change being typed, which stays kept after the timeline drops it. See *Corrected in implementation*.
- **Old saved state still loads.** The saved state's shape tag moves from `saved-1` to `saved-2`. A reload that finds state saved under `saved-1` restores its changes as waiting, each a modify with an unknown time, instead of dropping them.

Out of scope:
- The changes list, replay from start and seek (at-o3z.3), and linking changes to turns and tool calls (at-o3z.12).
- The VS Code extension, which saves its own timeline.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: "Recorded changes last for the session" covers played changes, their kind and recording time, and what the pane shows after a reload, and states the limits for played and waiting changes together.
  - *Added in implementation:* a new requirement, "Changes saved by an earlier version still load", carries the "Old saved state still loads" item above.

## Impact

- `claude-code/hooks/replay.ts`: `Change` gains `kind` and `time`; `savedOf` saves every kept change and how many had played; `restore` rebuilds the cursor and the shown change; a helper reads `saved-1` state.
- `claude-code/hooks/register.tsx`: `record()` captures kind and time; `flush()` clears texts only of changes no longer saved; `load()` reads either shape and restores played changes.
- `claude-code/types/index.d.ts`: `SavedChange` gains `kind` and `time`, and `Saved` gains `played`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for a reload that keeps played changes, `saved-1` state, the limits, and kind and time.
- `claude-code/README.md`: a line on what a reload keeps.
- `$.state` holds more text: up to 20,000,000 characters a session across played and waiting changes, where before it held only the waiting changes' texts. The in-memory timeline already held them.

## Corrected in implementation

Both corrections came from the spec lens's round-1 review of PR #87. Neither changed the code, which already did what design.md describes.

- **The limit counted the change being typed.** The first delta bounded what is "kept" at 200 changes and 20,000,000 characters. The living requirement had bounded only what waits to play, and the change being typed is not waiting. When I moved the bound to cover played changes too, I dropped that exception. design.md keeps the change being typed outside the timeline's limits, and so does the existing unit test `the change being typed still finishes, and is saved, once the timeline drops it`, so 201 changes can be kept. The requirement now sets the limit "besides the change being typed", and the scenario "Change typed past the limit" covers it.
- **Old saved state had no requirement.** "Old saved state still loads" was a What Changes item, but no requirement carried it. The modified requirement promised kind and time with no exception, while `saved-1` state loads as modifies at time 0. I offered two fixes: specify the transition, or leave it out and note "0 means unknown" on at-o3z.12's bead. I recommended specifying it, and the owner approved that with the round-1 plan. The ADDED requirement "Changes saved by an earlier version still load" says such changes wait to play, count as modifying their file, and have time 0, meaning unknown.
