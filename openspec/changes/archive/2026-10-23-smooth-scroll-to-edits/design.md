# Design

## Context

`Player.typeHunk` places the caret and calls `revealRange(..., InCenterIfOutsideViewport)` before each hunk, then waits about 220 ms. Mirrors are shown with `preserveFocus: true`, so the mirror is usually not the active editor. Editor scroll commands (`editorScroll`) act on the active editor only. `TextEditor.revealRange(range, AtTop)` and `TextEditor.visibleRanges` work on any visible editor, so scrolling is done with them.

## Goals / Non-Goals

**Goals:**
- Same-file edits outside the viewport are reached by a visible, eased scroll, as specified in `specs/edit-navigation/spec.md`.
- One place that decides how an edit is brought into view, so `at-mfk.2` can add caret movement there.

**Non-Goals:**
- Moving the caret line by line (`at-mfk.2`).
- Changing file switches, the scroll that follows typing past the bottom of the view, or deletion selections.

## Decisions

### Pure scroll path in `src/scroll.ts`

`centeredTop(line, height, lineCount)` is the top line that puts `line` in the middle of a `height`-line viewport, clamped to `[0, lineCount - height]`, so a scroll near the end of the file doesn't spend frames VS Code would clamp anyway.

`scrollSteps(from, to, height, linesPerSecond, speed)` returns one top line per frame (60 per second), ending at `to`:
- When `|to - from|` is more than `2 * height`, the first frame jumps to `2 * height` lines short of `to`, and the rest is animated.
- The animated part takes `distance / linesPerSecond` seconds, capped at 1 second, then divided by `speed`.
- Positions follow a cosine ease-in-out, so the scroll starts and stops gently.

Being free of vscode, it is unit-tested for monotonic progress, the end point, the jump, and the time cap.

### `Player.scrollTo` runs the frames

`typeHunk` gets a `smooth` flag. `play()` passes `false` for the first hunk after a file switch (and the first change played), and `true` otherwise. `scrollTo(relPath, editor, line, smooth, epoch)`:
1. Jumps (`InCenterIfOutsideViewport`, today's behavior) when `smooth` is false, `smoothScroll` is off, or the editor reports no visible ranges.
2. Returns at once when `line` is already visible.
3. Waits `scrollPauseMs`, humanized like other pauses and divided by the speed multiplier.
4. For each frame: `ready()` (waits out pause, stops on interrupt, follows a reopened tab), stops on finish current, reveals the frame's top with `AtTop` when it changed, sleeps one frame.
5. Ends with an `InCenterIfOutsideViewport` reveal of the edit, so finish current, a clamped frame, or a user scroll during a pause still leaves the edit in view.

The caret is placed after the scroll, so placing it doesn't make VS Code jump first. Using `ready()` for every frame means pause, seek, skip, skip to latest, closing the tab, and dispose all behave the same as in typing, with no new interruption path.

### Settings

| Setting | Default | Range |
|---|---|---|
| `smoothScroll` | `true` | boolean |
| `scrollPauseMs` | 400 | ≥ 0 |
| `scrollLinesPerSecond` | 60 | ≥ 1 |

They are ordinary settings: VS Code settings, the repository file, and `REPO_SETTING_KINDS` all list them.

## Risks / Trade-offs

- Folded regions make `visibleRanges` cover more lines than the viewport shows → the height estimate is too large and the scroll goes further per frame. Mirrors are rarely folded; acceptable.
- A user who scrolls the mirror during a pause sees the scroll resume from the planned position → one small jump. The final reveal still lands on the edit.
- With `editor.smoothScrolling` on, VS Code animates each reveal too; frames are 16 ms apart, so the two blend.
