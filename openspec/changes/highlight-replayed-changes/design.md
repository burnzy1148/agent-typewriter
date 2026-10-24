# Design

## Context

`Player` (`src/player.ts`) types each change into its mirror through `edit()`, and keeps `expected`, the LF text the mirror should hold mid-change. After each hunk it flashes the typed range with `diffEditor.insertedTextBackground` for 700 ms (`flashRange`). Long deletions are selected and held for about 380 ms before removal, a deleted file is selected whole for 500 ms, and short deletions are backspaced from the end.

`Timeline` (`src/timeline.ts`) holds the events and a cursor: events below `cursor` are played or skipped. `seek`, `seekToStart`, `seekToEnd`, `clear` and `restore` move the cursor, and `restore` gives events fresh seqs and maps the cursor by position. `mirrorStates()` already gives each file's text at the cursor. The `Session` JSON is shared by workspace persistence (`src/persistence.ts`) and session files. `parseSession` builds its result from known fields, so it ignores unknown ones.

`planHunks(before, after)` returns hunks in ascending order. Each hunk's offset is in the coordinates of the text after earlier hunks, so `[offset, offset + insertText.length)` is a range in the after text, and `offset` is where `deleteText` used to be. Large diffs fall back to one changed region (`LINE_DIFF_MAX_EDITS`).

The extension targets VS Code `^1.85.0`. Decorations belong to an editor, are lost when its tab closes, and can't render whole phantom lines. Gutter icons are image files and can't use theme colors.

## Goals / Non-Goals

**Goals:**
- Highlights are a pure function of the timeline, its clear points and the mirror's current text, so restore, seek, snap and tab reopen need no extra bookkeeping.
- One highlight computation shared by live typing and settled files.

**Non-Goals:**
- Showing removed text inline or as ghost lines (the hover covers it, see proposal).
- Highlights in the recorded-change diff view (`showDiff`) or on real files.
- Per-change colors or blame-style attribution of which change added a line.

## Decisions

### Net diff against a baseline, computed from the timeline

`src/highlights.ts` (pure, no `vscode` import) has:

- `baselines(events, through, clears)`: each file's baseline for the events with seq below `through` (the cursor, or one past the change being typed). It is the file's text at its latest clear (global or its own), or the before text of its earliest such event. A clear at seq C takes effect before the first event with seq >= C. A rename (`fromRelPath`, added on `develop`) carries the old path's baseline to the new path, so highlights survive a rename. Files with no such event have no baseline and show no marks.
- `diffMarks(baseline, current)`: runs `netHunks(baseline, current)` and returns `added` ranges (LF offsets into `current`) and `removed` points `{ offset, text }`, merging removals at the same offset. `netHunks` trims the shared first and last lines, anchors on lines both texts hold exactly once (the longest run of them in the same order, as a patience diff does), and runs `planHunks` on each stretch between anchors. Its output has `planHunks`' form, so applying it reproduces `current`. A net diff builds up over many changes. In the second review, one `planHunks` call over a heavily edited file passed its edit limit and marked everything from the first difference to the last. With anchors, only a stretch that really differs throughout can reach that limit.
- `highlightPair(state, relPath, live)` and `renderAction(pair, docText, drawnToken, liveToken)`: the pure decisions behind drawing, below, so they are unit tested.

The controller turns marks into line numbers: lines touched by an added range get the line decoration. Added characters get the text decoration only on lines that also hold baseline text. A removal goes on the line containing its offset, or on the last line when the offset is at the end of the text.

Alternative considered: carry each change's typed ranges forward through later changes with a range-transform function (the exploration's first idea). Rejected after the user chose net-diff semantics. It marks text that was added and later removed, needs its own persisted state, and could drift from what the text actually shows.

### Clear points live in the Timeline

`Timeline` gains `clearHighlights(relPath?)` and a `highlightClears` getter returning every clear still in effect, oldest first, as `{ seq, relPath? }`. Seqs are cursor style: "the next change at the time of the clear". A later clear never replaces an earlier one, so undoing it (by seeking before it) brings the earlier one back. A first version kept only the latest global and per-file clear, and the review found that seeking between two clears lost the older one.

- Clearing records `cursor`, or `playingSeq + 1` when a change is being typed, so the change in flight counts as baseline. A per-file clear on the old path of a rename being typed is keyed to the new path, because `baselines` applies it after the rename moved the baseline.
- `seek`/`seekToStart` drop every clear greater than the new cursor. Normal progress (`begin`/`complete`) and `seekToEnd` never drop one.
- `clear()` drops all of them. `restore(events, cursor, clears?)` maps them by position like the cursor and drops any at or before the first kept event. It does not apply the seek rule, so a clear made while the saved cursor's change was typed (cursor + 1) survives the reload.
- Load Session passes no clears, and its cursor is the first event, so a loaded session starts with none.

`toSession` writes an optional `highlightsFrom: Array<{ seq: number; relPath?: string }>`. `parseSession` reads it when well-formed and ignores it otherwise. `SESSION_VERSION` stays at 2 (bumped on `develop` for renames): older readers ignore the field, and losing clears on a downgrade only brings back older highlights. The comment above `SESSION_VERSION` is updated to say that optional, ignorable fields don't bump it.

Alternative considered: keep clear points in the highlight controller and save them in `workspaceState`. Rejected because seq remapping on restore, the seek-drop rule and the buffer clear all already live in `Timeline`.

### Highlight controller renders, the player reports text

A new `HighlightController` (in `src/highlightView.ts`) owns the decoration types and renders on every visible mirror editor. It re-renders on `onDidChangeVisibleTextEditors`, mirror document changes, timeline changes and setting changes. For each editor it picks the current text:

- the file of the change being typed: `Player`'s live `expected` text, via a new `onDidEditMirror(relPath)` event and a `liveText(relPath)` getter. `liveText` returns nothing once that change is interrupted (its epoch is stale), so a seek never draws marks on half-typed text. When the file's latest clear is greater than the playing seq, it shows nothing for that file until the change completes. During a rename's move pause, the old path uses the baselines from before the rename, so its marks stay up until the tab moves.
- any other file: `timeline.mirrorStates()`.

It renders only when the document's normalized text equals that current text. While a change is typed, the document can be a step ahead of the player's text; the previous marks are kept only when they were drawn during that same change (the player's `liveToken`), so marks from before a seek are cleared rather than kept. A clear made during the change being typed hides that file's marks right away, whether or not its live text is set yet; the player sets it before opening the tab. For a rename, the check also covers the new path, where its clear is kept. That covers the window after a seek back, before the next play resets the mirror, and restored tabs before they are refilled.

Recomputation is throttled per file to at most every 100 ms, with a trailing run, and spaced out further after an expensive run (`renderWait`: at least four times the last run's duration), so a slow diff on a heavily edited file takes at most about a fifth of the time. Each player edit also schedules the "which mirrors have highlights" pass, so the clear buttons appear while a change types, not only when it completes. Throttling keeps typing at 60 ticks a second from running the diff 60 times a second. It is never synchronous, because the document change event can arrive before the player has updated its text. While a change is being typed and the document is a step ahead of the player's text, the controller keeps the previous decorations (VS Code moves them along with the edit) instead of clearing them, which avoids flicker. `diffMarks` results are cached per file by baseline and text, so re-showing a tab costs nothing. The controller exposes the marks it last drew per mirror (`drawn`) for the integration tests.

Alternative considered: have `Player` set decorations itself as it types. Rejected because settled files, seek, snap, restore and setting toggles would need a second path anyway.

### Deletion preview stays in the player

The red strikethrough is a transient decoration the player sets on the range it is about to remove: the selected range during the existing 380 ms or 500 ms pause, and, when backspacing, the remaining characters of the hunk, updated each step. It is set only when `markDeletions` is on and adds no sleeps. It goes up when the caret arrives, before the existing 220 ms pause, and comes down in a `finally`, so an interrupted change never leaves it behind. `Player.deletionPreview` reports the previewed text for the integration tests. `flashRange` runs only when `highlightAdditions` is off.

### Decoration types and colors

| Type | Options |
|---|---|
| added line | `isWholeLine`, `backgroundColor: agentTypewriter.addedLineBackground`, `overviewRulerColor: agentTypewriter.addedOverviewRuler` (lane `Left`), `gutterIconPath`: thin green bar SVG (light and dark variants) |
| added text | `backgroundColor: agentTypewriter.addedTextBackground` |
| removed marker | `isWholeLine`, `gutterIconPath`: small red triangle at the top edge (light and dark variants), `overviewRulerColor: agentTypewriter.removedOverviewRuler` |
| deleting text | `backgroundColor: agentTypewriter.deletingTextBackground`, `textDecoration: line-through` |

`contributes.colors` defaults (dark / light / high contrast):

- `addedLineBackground`: `#2ea0431a` / `#2ea04314` / `#00000000` (high contrast relies on the gutter bar and ruler)
- `addedTextBackground`: `#2ea04340` / `#2ea04333` / `#2ea04366`
- `addedOverviewRuler`: `#2ea04399` for all
- `removedOverviewRuler`: `#f8514999` for all
- `deletingTextBackground`: `#f8514940` / `#f8514933` / `#f8514966`

These are about half the opacity of the diff editor's inserted colors. The removed text comes from a hover provider for the mirror scheme rather than a decoration `hoverMessage`. A decoration hover only appears over the decorated text, while the provider answers anywhere on the line and can be tested with `vscode.executeHoverProvider`. The hover is a `MarkdownString` code block in the document's language: the first 20 removed lines, each capped at 500 characters, then "…N more lines".

### Commands, context keys and the panel button

- Commands `agentTypewriter.clearHighlights` and `agentTypewriter.clearHighlightsInFile` (`$(clear-all)`). The latter acts on the active editor and does nothing unless it is a mirror.
- Context key `agentTypewriter.highlightedMirrors`: an array of mirror paths with any marks, set only when it changes. The `editor/title` entry at `navigation@6` uses `resourceScheme == agent-typewriter && resourcePath in agentTypewriter.playbackMirror && resourcePath in agentTypewriter.highlightedMirrors`, the same pattern as the existing buttons.
- `ScrubberState` gains `hasHighlights`. The panel adds a `clearHighlights` button, disabled when it is false, and `clearHighlights` joins the `SIMPLE` message set.

### Settings

`highlightAdditions` and `markDeletions` (booleans, default `true`) are added to `package.json`, `Settings`, `REPO_SETTING_KINDS`, the JSON schema and the README. The controller reads them on each render, so toggling needs no reload, and turning one back on just re-renders.

## Risks / Trade-offs

- [Diff cost on large files during typing] → Anchored stretches keep each diff small. Redraws are throttled to 100 ms, and spaced out after an expensive run (capped at 2 s). The pass that works out which mirrors have highlights compares strings when both settings are on, and otherwise stops diffing after 30 ms and finishes on a later pass.
- [Clears pile up] → A clear identical to one in effect is not added, and clears at or before the oldest change left in the buffer are dropped on trim.
- [Net diff alignment differs from what was typed, e.g. a repeated line matched elsewhere] → Accepted: the marks describe the text, like `git diff`, and the planner's word-level refinement keeps typical edits tight.
- [Gutter icons have fixed colors and share the glyph margin] → Light and dark variants. Mirrors are read-only, so breakpoint glyphs aren't expected. The ruler and backgrounds stay themeable.
- [Mirror text briefly doesn't match after a seek back] → Highlights are hidden until it matches, rather than drawn on the wrong lines.
- [Baseline moves forward when the history limit trims a file's oldest change] → Accepted and specified, since the buffer no longer has that text.
- [Optional session field without a version bump] → A downgrade loses clears and nothing else. Documented next to `SESSION_VERSION`.

## Migration Plan

No migration. Both settings default on, so existing users see highlights after updating. Saved timelines from earlier versions restore with no clears. Rollback is turning both settings off, which restores today's behavior.
