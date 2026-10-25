---
title: How it works
description: "How Agent Typewriter records changes on disk and replays them as typing."
---

```
disk write ──► watcher ──► debounce ──► diff vs snapshot ──► reorder ──► timeline (ordered buffer)
                                                                               │
                                                 replay editor ◄── player ◄────┘
```

- **Snapshots.** On start, every matching file is snapshotted. When a file changes, the new text is compared with its snapshot and the event stores both sides. The before side is fixed at record time, so a sequence like A, B, A replays correctly even when playback is minutes behind.
- **Write order.** Each change is ordered by its file's modification time and held for a short reorder window (`reorderWindowMs`), so a watcher that reports writes late or out of order, as on Windows, still produces the true order.
- **Timeline buffer.** Events are kept in order (default 500, `historyLimit`). The playback cursor moves through them independently of recording, so you can replay the whole buffer or start from any event.
- **History across reloads.** The buffer and the playback position are saved to VS Code's per-workspace extension storage (not the workspace) every couple of seconds while they change, and restored when the workspace opens again. If changes were still queued, playback comes back paused so nothing starts typing on its own. Up to 64 MB of change text is kept, newest first. `persistHistory: false` turns this off and deletes the saved history.
- **Renames.** A file deleted and another created with the same content (or at least half its lines unchanged, as git judges renames) while the first is still held for reordering are one rename. Replay shows the old name, moves the mirror to the new one, and types any edit. A move between a path the filters record and one they leave out stays a create or a delete. With `reorderWindowMs` at `0`, renames show up as a delete and a create.
- **Diff planning.** Changes are planned line by line, then refined word by word, so renaming one variable retypes only that token. Whole new lines are typed as lines. Leading indentation appears instantly the way an editor auto-indents. Short deletions are backspaced; longer ones are selected and then deleted.
- **Catch-up.** Agents write far faster than people type. Speed is `base x (1 + catchUpFactor x queued)` capped at `maxSpeedup`, so playback accelerates when it falls behind and relaxes when it catches up. Changes larger than `maxAnimatedChars` are applied instantly.
- **Mirror editors.** Each file gets one mirror tab, saved quietly after every change so closing a tab never prompts.

Every setting named here is described on the [Settings](/docs/settings/) page.
