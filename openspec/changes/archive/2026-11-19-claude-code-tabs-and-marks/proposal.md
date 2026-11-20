# Proposal

## Why

The Claude Code plugin's pane shows one file at a time: whichever file the change being typed touches. A file it typed a minute ago is gone from view, and nothing in the code view says which lines playback changed. The VS Code extension has a mirror tab per file and git-style highlights for both. at-o3z.16 carries both into the pane, as the at-o3z.8 mockup designs them (Main board; Mapping rows "Mirror documents, one tab per file" and "Change highlighting").

## What Changes

- **File tabs over the code view.** Each file the followed lane has typed gets a tab over the code view, in the order the lane first typed them. The tab of the file the code view shows is marked. Until at-o3z.15 adds lanes, the followed lane is the main conversation's, the only one.
- **Pressing a tab pins its file.** The code view then shows that file as the lane last typed it, with its marks and no caret. A line says which file playback is in, with a Follow playback button. Playback carries on meanwhile. The pin ends on Follow playback, on pressing the tab of the file playback shows, on any press that moves playback, or when the file loses its tab. *Superseded in implementation: a pin also ends when playback moves into its file, and the header and caption stay playback's while pinned. See Corrected in implementation, P1 and P2.*
- **The code view is a unified diff.** It is drawn with the Code element's `diff` format against each file's baseline. Lines typed since the baseline are marked added. Lines removed since then stay in view, marked removed. Marks are whole lines, because the Code element marks no character ranges, and the surface picks their colors.
- **A line about to be erased is shown red before it goes.** Before a deletion that is removed in one step, the lines it touches are drawn as removed for a short beat, then the deletion lands. A line that was in the baseline stays marked removed afterward. A line typed since the baseline disappears.
- **Clear marks.** A new control makes every file's current text its baseline, so only later changes are marked. As in the extension, a seek back past a clear undoes it, and a clear made while a change is typed leaves that file unmarked until the change finishes. Clears survive a reload.

Out of scope, and kept possible:
- Lanes, lane chips and following another lane (at-o3z.15). Tabs, baselines and clears are worded per followed lane so they hold once lanes exist.
- Clearing one file's marks, as the extension's Clear Highlights in This File does. The pane has one Clear marks control.
- Character-level marks, a struck-through look and theme colors, which the Code element cannot draw.
- A drag scrubber or smooth scrolling in a surface module (at-o3z.19).
- The VS Code extension, whose mirrors and highlights are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds file tabs, pinning a tab, the diff code view, baselines, marks following playback, the deletion preview, Clear marks, undoing a clear by seeking back, and clears across a reload. No existing requirement's text changes. *Superseded in implementation: three existing requirements change, as MODIFIED blocks in the delta: "Long deletions are removed at once", "Replay pane" and "Pane names the file". See Corrected in implementation, P3.*

## Impact

- `src/highlights.ts`: `netHunks` and the helpers it uses move to a new `src/netHunks.ts`, which imports neither `vscode` nor Node built-ins, and `highlights.ts` re-exports it. The extension's behavior is unchanged. *Superseded in implementation: `highlights.ts` and its tests import it from `src/netHunks.ts`, with no re-export. See design.md, Corrected in implementation, C1.*
- `scripts/build-claude-code.mjs`: the bundle's entry adds `netHunks`. `claude-code/hooks/core.mjs` and `core.d.mts` are rebuilt.
- `claude-code/hooks/replay.ts`: per-file baselines and clears; diff rows for the view; the deletion preview beat in `tick`; the tab list; the view of a pinned file. *Superseded in implementation: the diff rows moved to `marks.ts`; replay.ts keeps the view's window of them and its hunk header.*
- `claude-code/hooks/marks.ts` (new, *added in implementation*): whole-line diff rows, tab labels and the tab layout, as pure functions. See design.md, Corrected in implementation, C2.
- `claude-code/hooks/register.tsx`: the tab row, the pinned line with Follow playback, Clear marks, the Code element under `format: 'diff'`, and new `tabs` and `marks` atoms.
- `claude-code/types/index.d.ts`: `View` carries diff rows; new `Tabs` and `Marks` types and state keys.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for each behavior above.
- `claude-code/README.md`: tabs, marks and Clear marks.
- `CLAUDE.md`: the shared core list gains `src/netHunks.ts`.

## Corrected in implementation

Recorded after review round 1 of the PR. The owner approved these with the round 1 response plan, as recommended there.

- **P1. A pin ends when playback moves into its file.** The proposal listed four ways a pin ends. While coding, the pane also ended the pin when playback came to show the pinned file, and the delta's sentence was then rewritten in place to match, with no record. That rewrite is what this note corrects. The behavior stays: the view already ignores a pin on playback's own file, so without the extra end the pin would hide while playback is in that file and quietly come back when playback leaves it. The delta keeps the sentence and its scenario "Playback reaches the pinned file".
- **P2. The header and caption while pinned.** The proposal did not say which caption shows over a pinned file. They stay playback's: the header names playback's file, and the caption, above the tabs, is that of the change playback shows, as in the mockup. The pin requirement now says so, with a scenario.
- **P3. Three existing requirements change.** The proposal said no existing requirement's text changes, which the beat, the diff view and pinning make false. The delta modifies "Long deletions are removed at once" (the deletion lands after its beat), "Replay pane" (the text is drawn as a diff against its baseline, unless a tab is pinned) and "Pane names the file" (while idle, the after text shows unless a tab is pinned). Each keeps its scenarios under their names. The beat requirement's own scenario was renamed "Deleted baseline block", so it no longer shares a name with the modified "Deleted function".
