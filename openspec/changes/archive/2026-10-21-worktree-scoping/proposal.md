# Proposal

## Why

Agent tools often create git worktrees inside the repository, for example Claude Code in `.claude/worktrees/` or a `.worktrees/` folder. A user who opens the main checkout in VS Code then records every write from every agent's worktree, mixed into one timeline. Those worktrees also take baselines from the memory budget for files the user never wanted. And the opposite case, watching one agent's worktree while keeping `main` open, is not possible at all when the worktree sits outside the workspace folder.

## What Changes

- By default, a workspace folder in a git repository records only its own checkout. Other worktrees of the same repository that sit inside the folder are not recorded and get no baselines. This applies on top of the extension, exclude, include, and gitignore filters.
- Worktrees come from git's own list (`git worktree list`), so submodules and unrelated nested repositories are unaffected. The list is refreshed while recording when worktrees are added or removed.
- New command **Agent Typewriter: Choose Checkout** and a status bar entry showing the watched checkout. A quick pick lists the folder's own checkout and each of the repository's other worktrees, by branch (or short commit when detached) and path. Choosing one records that checkout instead, whether it sits inside the workspace folder or elsewhere on disk.
- The choice is remembered per workspace folder across reloads. If the chosen worktree is removed, recording falls back to the folder's own checkout and says so.
- Switching checkouts while recording applies without a restart. Changes already in the timeline stay as they are.
- Changes recorded from a checkout other than the folder's own are labelled with the worktree's folder name in the timeline and in mirror document paths, so the same file in two checkouts never shares a mirror.
- Without git, or outside a git repository, nothing changes and the command says the folder has no other checkouts.
- **BREAKING** (behavior): users who relied on recording nested worktrees from the main checkout now need to choose that worktree. There is no setting to record every checkout at once in this change.

## Capabilities

### New Capabilities
- `checkout-scope`: which git checkout a workspace folder records from, how other worktrees are excluded, and how the user chooses a checkout.

### Modified Capabilities
None. The existing path-filtering and change-recording requirements still hold within the chosen checkout.

## Impact

- New `src/worktrees.ts`: read-only `git worktree list --porcelain -z` parsing and nesting checks, unit-tested with an injected runner.
- `src/recorder.ts`: a per-folder checkout root replaces the workspace folder as the base for watchers, baseline capture, filter paths, git calls, and display paths; nested worktrees join the `passes` check; a refresh path for checkout and worktree-list changes.
- `src/extension.ts`: the Choose Checkout command, status bar entry, `workspaceState` persistence, and fallback handling.
- `package.json`: command contribution.
- README: a section on worktrees.
- Integration tests: a git workspace with a nested worktree and a sibling worktree.
- Not in scope: recording all checkouts at once, auto-following the most recently written worktree, and changes to how repository settings files are found (the workspace folder's `.agent-typewriter.json` keeps applying).
