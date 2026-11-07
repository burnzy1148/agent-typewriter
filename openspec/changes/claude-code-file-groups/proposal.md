# Proposal

## Why

at-o3z.13 groups the Claude Code pane's changes list into a chapter per turn. When the person wants to see what happened to one file across a session, they still have to hunt for its rows in every chapter. The at-o3z.8 mockup's Main and ChangesList boards put a By turn / By file switch over the list; at-o3z.13 left room for it and draws no switch. This change adds the By file side and the switch.

## What Changes

- **A switch over the list.** The `Changes` line gains two buttons, By turn and By file, between its title and its hint. The chosen one is drawn as the selected button. By turn is the default and is the list at-o3z.13 draws.
- **By file.** The same rows, grouped by the file they changed: a group per path, holding that file's kept changes in recorded order. Groups are ordered by their first kept change, so the file Claude first touched most recently is last.
- **A group's header.** The file name in bold, its folder dim (named as the pane names a file, cut to fit), how many of its changes the pane keeps, and a Play from first button.
- **Play from first.** Acts as pressing the group's first row: that change is typed next from its before text, and every change recorded after it follows in recorded order, whatever file it changed. Whether playback is paused does not change.
- **The choice survives a reload.** The grouping the person picked holds for the rest of the session, across a reload of the plugin.
- **Switching keeps up.** Switching grouping brings the shown change's row back into view, as a pick does.

Rows, their numbers, states, Show in conversation, the dropped note, the transport and its hotkeys, and the conversation's chips (the change chip and at-o3z.13's Play turn chip) are the same in both groupings.

Out of scope:
- Collapsing groups, and sorting files any other way.
- Playing only one file's changes. Play from first plays on through later changes of every file, as a pick does.
- A hotkey for the switch: `r`, `p`, `f` and `l` stay the transport's.
- Lane tags and following a lane (at-o3z.15), captions (at-o3z.14), the terminal, and the VS Code extension.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for the By turn / By file switch, groups by file, a file group's header, Play from first, and the choice surviving a reload. Modifies the requirements at-o3z.13 leaves behind: *The changes list is grouped by turn* (it holds while By turn is chosen), *Pane lists the session's changes* (by turn or by file), *The list says how many changes were dropped* (above the first group either way), and *The list keeps up with playback* (Play from first and the switch bring a scrolled list back). These deltas are written against the spec as it reads once at-o3z.13's `claude-code-turn-chapters` is archived; this change lands after it.

## Impact

- `claude-code/hooks/replay.ts`: a pure grouping of `Listing` rows by path beside at-o3z.13's chapters, and a header label for a file group.
- `claude-code/hooks/register.tsx`: a saved `grouping` atom, the switch on the `Changes` line, file group headers with Play from first, and the list window drawn from whichever grouping is chosen.
- `claude-code/types/index.d.ts`: the `grouping` atom's value in `PluginState`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for the grouping, the header, Play from first, the switch and the reload.
- `claude-code/README.md`: By file and the switch.
- No shared module (`core.mjs`) changes. `saved` and `listing` keep their shapes.
