---
title: Limits
description: "What Agent Typewriter does not do."
---

- Text files only. Binary files and files over `maxFileSizeKB` are skipped.
- The replay is a reconstruction, not a recording. It shows each change as a person would plausibly type it, not the agent's literal edit sequence (which is always an atomic write anyway).
- Every matching file needs a baseline for its first change to replay. In a git repository with git installed, clean tracked files use git as their baseline and cost no memory (`gitBaselines`). Other files are kept in memory up to `baselineBudgetMB`, newest first. A file left out starts recording from its second change, and the **Agent Typewriter** output channel says how many files that is.
- The buffer keeps at most `historyLimit` changes and `historySizeMB` of change text (before plus after, a character counted as a byte), whichever is reached first; the oldest changes are dropped. The newest change is always kept, even when it alone is bigger.
- A rename is only detected while its first half is still held for reordering; a delete and a create further apart replay separately.
- On Linux, VS Code's file watcher does not look inside a folder tree made several levels deep at once (`mkdir -p`, `git worktree add` into a new folder, a folder moved in): it reports the top folder and nothing written below it. Agent Typewriter watches those folders itself if they were made while it was recording in this window: up to 2000 per lane, and no more than a quarter of the inotify watches the system allows (`fs.inotify.max_user_watches`), which VS Code's own watcher shares. Changes in a tree made before that are missed until the window is reloaded (**Developer: Reload Window**). So are changes in folders made at once inside a folder that was there before recording and is deleted and made again in one quick step (`rm -rf dir && mkdir -p dir/...`): VS Code reports that folder as merely changed, the same as a `chmod`.
