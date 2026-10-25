---
title: Worktrees
description: "How git worktrees inside the workspace are skipped, and how to watch an agent's worktree instead."
---

Agent tools often put git worktrees inside the repository, for example `.claude/worktrees/` or `.worktrees/`. A workspace folder records only its own checkout: other worktrees of the same repository inside it are skipped and get no baselines, and the panel says "other worktrees skipped". Worktrees are what `git worktree list` reports, so submodules and other nested repositories are recorded as usual. A worktree added while watching is skipped as soon as git writes its `.git` file.

To watch an agent's worktree instead, run **Choose Checkout...** or click the branch entry next to **Typewriter** in the status bar, which appears when there is another checkout to choose. It lists the folder's own checkout and every other worktree by branch (or short commit) and path, including worktrees outside the workspace folder.

A folder that holds a bare repository and its worktrees (a `.bare` directory, a `.git` file naming it, and one directory per worktree) has no checkout of its own. Until you choose one of its worktrees, even when there is only one, its worktrees are skipped like any other worktree and only files outside them are recorded: the status bar entry reads **(none chosen)** and the panel says "no checkout chosen". Choose Checkout lists the folder itself, with no checkout of its own, and each worktree.

- The filters apply within the chosen checkout, so `src/**` means that worktree's `src/`. The workspace folder's [repository settings file](/docs/repository-settings/) still applies.
- Changes from a chosen worktree show up under its directory name, like `feature/src/app.ts`, so the same file in two checkouts never shares a mirror. When that name is already in use, by another worktree or by a top-level file or directory of the workspace folder, the parent directory's name goes in front (`worktrees-feature`), or a number when that is taken too. A worktree keeps the name it was given while other worktrees come and go, and across reloads unless the folder has since gained a top-level entry of that name.
- In a multi-root workspace, each change starts with its folder's name. Two folders with the same name get their parent directory's name in front (`client-app`, `server-app`), and a `/` in a folder name becomes `-`. A folder keeps its prefix when folders are added or removed later.
- Switching applies at once while watching. Changes already in the timeline stay and still play.
- The choice is remembered for the folder across reloads. If that worktree is removed, recording falls back to the folder's own checkout, its files are not replayed as deleted, and the output channel says so.
- Without git, or outside a repository, there is one checkout and nothing changes. The extension never creates or removes worktrees.

To record several checkouts at once, each in its own lane, see [Lanes](/docs/lanes/).
