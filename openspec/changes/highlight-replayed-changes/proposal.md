# Proposal

## Why

Replay shows each edit as it is typed, but nothing remains once typing moves on. Today each typed hunk flashes green for 700 ms and then clears. A viewer who looks away, or comes back to a tab after the agent has moved through several files, can't see what changed. A persistent, git-diff-style view of what replay added and removed lets the mirror answer "what did the agent change here?" at a glance, without opening a separate diff.

## What Changes

- Mirror documents highlight the text that differs from the file's baseline, like `git diff`: a soft green background on lines with added text, a stronger tint on the added characters of lines that are only partly new, a gutter bar, and an overview ruler mark. The baseline is the file before its earliest change in the buffer, or as it was when highlights were last cleared. Text added and later removed leaves no mark.
- Highlights grow as replay types, and they persist until cleared. They follow the playback position: seeking back removes highlights for changes no longer played, and skip to latest shows everything that jumped in.
- A change too large to animate (over `maxAnimatedChars`) highlights only the lines that differ, not the whole file.
- Before replay deletes text, it shows that text tinted red with a strikethrough, during the pause that already exists.
- Where text was removed relative to the baseline, the gutter shows a "removed here" marker and the overview ruler a red mark. Hovering the line shows the removed text, up to about 20 lines. A deleted file gets one marker at line 1.
- New commands: Clear Highlights (all files) and Clear Highlights in This File. They appear as buttons in the playback mirror's title bar and the Playback panel, and in the command palette.
- Clear points are kept with the saved timeline, so highlights look the same after a reload. Loading a session file starts with every change pending, so it starts with no highlights.
- New settings `agentTypewriter.highlightAdditions` and `agentTypewriter.markDeletions`, both default `true`. With `highlightAdditions` off, replay keeps today's 700 ms flash. With `markDeletions` off, deletions look as they do today.
- Highlight colors are contributed theme colors with subdued defaults, so users and themes can override them with `workbench.colorCustomizations`.

## Capabilities

### New Capabilities
- `change-highlighting`: how mirror documents mark text added and removed relative to a baseline, how the marks follow playback, how deletions are previewed, how highlights are cleared, and the settings and colors that control them.

### Modified Capabilities
- `playback-controls`: adds the Clear Highlights controls on the playback mirror's title bar and in the Playback panel.
- `session-persistence`: adds a requirement that highlight clear points are kept with the saved timeline.

## Impact

- New `src/highlights.ts`: pure functions that choose each file's baseline and compute added ranges and removal points from a baseline and current text, built on `planHunks`.
- New highlight controller (decoration types and rendering on visible mirror editors), wired up in `src/extension.ts`.
- `src/player.ts`: reports the in-progress text of the change being typed, shows the red deletion preview, and keeps the flash only when `highlightAdditions` is off.
- `src/timeline.ts`: clear points (global and per file), dropped on clear and when a seek moves the cursor before them, remapped on restore, and an optional `highlightsFrom` field in the session JSON (format version unchanged).
- `src/persistence.ts`, `src/scrubberHtml.ts`, `src/scrubberView.ts`, `src/mirrorControls.ts`: saving clear points, the panel button, and a context key for the title bar button.
- `package.json`: commands, `editor/title` entries, settings, `contributes.colors`, and gutter icon assets. `src/config.ts`, `src/repoSettings.ts`, `schemas/agent-typewriter.schema.json`, README: the new settings.
- Unit and fuzz tests for the highlight module and clear points, plus an integration section.
- Highlights are decorations on `agent-typewriter:` documents only. They never change mirror text and never touch the user's real files.
