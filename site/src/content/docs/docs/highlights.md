---
title: Highlights
description: "How replay marks added and removed text like a git diff, and how to clear or recolor the marks."
---

Replay marks what changed in each mirror the way a git diff does, compared with the file before its first replayed change (or since you last cleared highlights):

- Lines with added text get a soft green background, a bar in the gutter, and a mark in the scrollbar. On a line that keeps some older text, the new characters get a slightly stronger green. Text appears highlighted as it is typed and stays highlighted.
- Just before replay deletes text, the text turns red with a strikethrough. Where text was removed, a small red marker sits in the gutter; hover the line to see the removed text.
- Highlights follow the playback position: seeking back removes highlights for changes not yet replayed, and skip to latest highlights everything that jumped in. Text added and later removed again leaves no mark.
- **Clear Highlights** (in the Playback panel and the Command Palette) starts over from what every mirror shows now. **Clear Highlights in This File** (in the replay editor's title bar and the Command Palette) does the same for one file. Replaying from before a clear brings its highlights back.

Turn `highlightAdditions` off to get only a brief flash on each typed edit, and `markDeletions` off to drop the red preview and removal markers. The colors follow your theme and can be changed with `workbench.colorCustomizations`:

```jsonc
"workbench.colorCustomizations": {
  "agentTypewriter.addedLineBackground": "#2ea04326",
  "agentTypewriter.addedTextBackground": "#2ea0434d",
  "agentTypewriter.addedOverviewRuler": "#2ea04399",
  "agentTypewriter.removedOverviewRuler": "#f8514999",
  "agentTypewriter.deletingTextBackground": "#f8514940"
}
```
