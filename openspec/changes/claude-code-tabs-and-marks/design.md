# Design

## Context

The deck (`claude-code/hooks/replay.ts`) keeps the session's changes in the shared `Timeline` on its default lane. `deck.shown` is the one text the pane draws, with the caret. `viewOf()` cuts a window of `VIEW_LINES` lines around the caret into the `view` atom (shape `view-1`), and `frame()` fits it to the pane and puts a `▍` at the caret. The pane draws it with `Code` in its default `source` format, with `startLine` for the gutter. A deletion over 24 characters, or one spanning lines, is one keystroke that ends its tick (`isLongDeletion`). Every press that moves playback goes through `move()` in `register.tsx`.

The `Code` element (`claude-code/.claude-plugin/types/claude-code/index.d.ts`, `CodeProps`) takes `format: 'diff'`. It then reads `source` as unified-diff hunks (`@@ -a,b +c,d @@`, then ` `, `+` and `-` lines) and draws gutters, markers, and add and remove colouring. The hunks carry their own numbers, so `startLine` is ignored. It marks no character range and takes no colors. A source that parses as no hunk is drawn as plain code, and one drawing holds 100,000 characters at most.

The extension's highlights (`src/highlights.ts`) diff a mirror against a baseline with `netHunks`, which is minimal on small stretches and anchors on unique lines in big files. Its baselines come from the timeline and a list of clears, each a seq: the next change at the time of the clear. A clear made mid-change holds back the typed file until that change finishes. `netHunks` and its helpers import only `diff` and the planner. `highlights.ts` also imports `changeText`, which reads the log from disk, so the bundle cannot take that module whole.

The design is the at-o3z.8 mockup's Main board (tabs, the Viewing line with Follow playback, Clear marks) and its Mapping rows.

## Goals / Non-Goals

**Goals:**
- The same baseline and clear semantics as the extension, so a file reads the same in either.
- Nothing more saved than a list of clears: baselines come from the kept changes.
- Every state a lane-aware pane needs is a function of a lane's events, so at-o3z.15 passes the followed lane where today it uses the default one.

**Non-Goals:**
- Per-file clears, character marks, strike-through, and colors.
- Keeping a pin across a reload.
- Keeping a file's tab after all its changes are dropped. Its text goes with them.

## Decisions

### Share `netHunks` through the bundle

Move `netHunks`, `splitLines`, `uniqueShared`, `increasingRun` and their constants from `src/highlights.ts` to `src/netHunks.ts`. `highlights.ts` imports and re-exports them, so the extension's callers and tests stay as they are. Add `netHunks` to `CORE_ENTRY` and rebuild `core.mjs`.

Alternative: a line diff of the plugin's own, or `diffLines` from the bundled `diff` package. Rejected: `diffLines` is quadratic on big rewrites, and the extension already solved that with anchors. Two diffs would also mark the same file differently in the two frontends.

### Diff rows: whole lines from net hunks

`diffRows(baseline, text)` turns `netHunks(baseline, text)` into rows `{ kind: ' ' | '+' | '-', text, oldLine?, newLine? }`. Every line a hunk touches, on either side, becomes a `-` row (its baseline version) and a `+` row (its current version). Rows come in file order, a hunk's `-` rows before its `+` rows. Two invariants hold and are fuzz-tested: the ` ` and `+` rows give back `text`, and the ` ` and `-` rows give back `baseline`.

`viewOf` keeps `VIEW_LINES` rows around the caret's row instead of lines, and `View` changes from `lines` and `firstLine` to `rows`, with each row's numbers (`view-2`). `frame()` cuts the rows to the pane and puts the caret into its row. It writes one hunk header for the rows it keeps: `-a,b` from the first old line and the count of ` ` and `-` rows, `+c,d` likewise for new lines. A file with no marks is one hunk of context rows, so the pane always draws `format: 'diff'`, and the layout does not jump when the first mark appears.

The diff runs once per tick while typing, on the whole file. `diffRows` memoizes its last result by baseline and text. `netHunks` trims common lines at both ends before it looks further, so a tick on a large file costs about one pass over its lines.

### Baselines from kept changes and clears

`baselineOf(deck, path, clears)` follows `baselines()` in the extension, minus renames, which Edit and Write never make. Walk the lane's played changes in order. A file's baseline is the before text of its first kept change, and at each clear whose point has passed, every file's text so far becomes its baseline. A clear is `{ at: number; heldBack?: string }`: `at` is the recording number of the first change not played at the press, counting the change being typed as played. `heldBack` names that change's file. While the held-back change is typed, its file draws no marks (baseline = shown text). Once it finishes, the clear applies to that file too.

Clears live in a new `marks` atom (`marks-1`, `{ clears: Clear[] }`), newest last, at most 50. `seek` drops every clear whose `at` is past the picked change's number, which undoes a clear when playback goes back before it. A clear outlives the changes it was made among: with none of them kept, it has nothing left to reset.

Alternative: save each file's text at the press as `text` members. Rejected: up to 200 files of up to 1 MB each, a second copy of what the kept changes already hold, and seeking back past a clear would still need the clear's position.

### The deletion preview is a beat in `tick`

`Playback` gains `preview`, a count of ticks. When `keystroke` reaches a long deletion that has not started, it sets `preview` to `PREVIEW_TICKS` (8, so 400 ms at the 50 ms tick) and ends the tick without deleting. Each later tick counts down, and at zero the deletion lands as it does now. A paused deck does not tick, so Pause holds the beat. `finish` and `seek` drop `playing`, so they skip it. The beat does not scale with speed: it is there to be seen.

While `preview` is above zero, `viewOf` turns each row whose new line lies in the deletion's range into a `-` row. A row partly in the range counts too, since marks are whole lines. Once the deletion lands, the diff decides: a baseline line stays a `-` row, and a line typed since the baseline is gone.

A backspaced deletion needs no beat. The whole-line diff already shows the baseline line removed above the shrinking line.

### Tabs come from the lane's played changes

`tabsOf(deck)` returns one entry per path with a played change in the lane, or that is the shown change's path, in order of the path's first kept change. Each entry carries the change the tab shows: the lane's latest played change to the path, or the shown change. A pinned file's view is that change's after text, its caret where typing it ended (`finalCaret`), with its marks and no caret glyph. A too-large change shows its note.

Labels are base names. When base names clash, a pure `tabLabels(paths, cwd)` adds leading folders of the relative path until each label is unique. `tabRows(labels, shown, width)` lays the labels into at most two rows. It keeps the shown tab, then the most recently typed, and returns the rows and how many it left out. The pane gets the rows' count before it splits its height between the code and the list.

### The pin lives in module memory

`live.pin` holds a path. A tab press sets it, or clears it when the tab is the playback file's. `move()` clears it, which covers every press that moves playback. Follow playback clears it. `sync` clears it when `tabsOf` no longer lists the path. Pause goes through `act()`, not `move()`, so it keeps the pin. The `view` atom then holds the pinned file's view, and a new `tabs` atom (`tabs-1`) holds `{ tabs: { path, label }[], shown?: string, pinned?: string }` for the tab row and the Viewing line.

While pinned, the header still names playback's file, number and status ("Pane names the file" stands). The Viewing line under the tabs reads "Viewing a.ts as last typed. Playback is in b.ts." with a Follow playback button.

### Layout

From the top: the header, the tab rows (none before the first change), the Viewing line while pinned, the code, the controls with Clear marks after Skip to latest, then the Changes line and list. The code's rows are the body less all of those. Clear marks gets no hotkey, so "Playback hotkeys" stands.

## Risks / Trade-offs

- [A tick on a large file rewritten all over costs a full `netHunks`] → `netHunks` anchors and caps its own search. If the plugin test on a 1 MB file runs over budget, cache the rows outside the current change's touched lines at the change's start, and diff only that span on each tick.
- [During the beat, a `-` row made from a line typed since the baseline has no old line, so the old-side numbers below it read one higher until the deletion lands] → New-side numbers, the file's real line numbers, stay right. If a surface shows the slip, close the hunk before such rows and open another after them.
- [The surface may draw the hunk header as a row of its own] → `frame()` takes the header's row from the code's budget. The pane tests check the row count, and the first run on desktop shows whether that budget is needed.
- [Old-side numbers are the baseline's, which a viewer may not expect after many changes] → That is what a unified diff means. The new side carries the file's numbers.
- [`view`, `listing` and the ToolUse hook are being changed by at-o3z.13, .14 and .27 at the same time] → This change adds its own atoms (`tabs`, `marks`) and changes only `view`'s rows. The orchestrator gives the plugin slot to one change at a time, and each rebases on the last.

## Migration Plan

`view` moves to `view-2`, and a reload drops the old view and redraws it from the deck. `tabs` and `marks` are new, so a reload of a session from an earlier version starts with no clears. The extension is unchanged.

## Open Questions

- The beat's length, 400 ms, is a guess. Watching it on desktop may move it. It is one constant and changes no requirement other than the number.
