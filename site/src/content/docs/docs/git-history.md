---
title: Replaying git history
description: "Type out a branch, pull request or commit range from git without watching it happen."
---

Work that was never watched, such as a branch an agent pushed overnight or a pull request, can still be typed out from git. **Replay Git Commits...** (in the panel's `...` menu) builds the buffer from a range of commits, one change per file per commit, oldest first. Pick one of:

- **This branch**: the current branch's commits that are not on the default branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main` or `master`).
- **A branch...**: another local or remote-tracking branch's commits that are not on the default branch. A pull request you fetched but did not check out is replayed this way.
- **Last commit**, or **Enter a commit or range...** in git's syntax: `main..feature`, `HEAD~5..HEAD`, or a single commit.

Each change's before and after text come from the commits, not from the files on disk, so uncommitted edits do not show up. Merge commits are skipped, as `git log -p` does, and so are files the [watch filters](/docs/filtering/) leave out, binary files, files over `maxFileSizeKB`, Git LFS files, symbolic links and submodules. Renames git detects replay as renames. Nothing is downloaded: in a partial clone, file versions git does not have locally are skipped (this needs git 2.44 or later; older git fetches them), and in a shallow clone the oldest commit, whose parent is missing, is skipped.

The replay replaces the buffer (after asking) and starts playing at the first change; pause it from the panel or the replay editor. It also stops watching, so live edits do not mix into the history; start watching again when you are done. The repository is only read: nothing is checked out or fetched, and HEAD, the index and your files stay as they are.
