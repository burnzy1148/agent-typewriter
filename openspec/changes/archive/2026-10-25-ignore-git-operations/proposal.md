# Proposal

## Why

The recorder treats every settled write in a recorded checkout as a change to replay, and it never looks inside `.git`, so it cannot tell git's writes from an agent's. A `git merge`, `pull`, branch switch, rebase, cherry-pick, reset to another commit or stash push/pop floods the timeline with every file git rewrote, burying the agent's work and replaying content nobody typed (bead at-yd9).

## What Changes

- Writes that a git operation makes while bringing in content from other commits are no longer recorded: merge, pull, checkout/switch of a branch or commit, rebase, cherry-pick, revert, reset to another commit, `merge --abort`, and the steps of `rebase --continue`/`--skip`. The recorder takes the written text as the file's new baseline silently, so the next real edit replays from it.
- Conflicted files are covered: the marker text a conflicted merge, rebase, cherry-pick or revert writes is git's and becomes the baseline without being recorded. The resolution then written records as a normal change, from the marker text to the resolved text; one the user saves from a VS Code editor follows `ignoreOwnSaves` like any other save. Choosing a side with `checkout --ours`/`--theirs` counts as resolving and records too.
- `git stash` push and pop are not recorded: push's writes back to the index, and pop's writes to the paths the popped stash changed.
- Writes that discard working-tree edits back to the index (`git restore <path>`, `checkout -- <path>`, `reset --hard` to the same commit) and `git stash apply` still record, like any edit that returns a file to its committed text. Git leaves nothing that tells them apart from an agent doing the same.
- A write is attributed to git only when git itself shows it: the operation changed that path's index entry (or the stash recorded the path), and the file on disk agrees with git's result. An agent edit that lands during a git operation, including VS Code's own background `git status`, still records.
- New setting `agentTypewriter.ignoreGitOperations` (default on). Off, or outside a git repository, or when git cannot run, every write records as before.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-recording`: adds requirements for skipping writes made by git operations (including conflicted files and stash push/pop), for what still records (agent edits during an operation, conflict resolutions, discards, stash apply), and for the `ignoreGitOperations` setting and its fallback when git is unavailable.

## Impact

- `src/recorder.ts`: classifies each flushed write against the git state of its checkout before recording it; updates snapshots and git baselines for skipped writes.
- New module (e.g. `src/gitOperations.ts`): reads the checkout's git directory markers, diffs index entries across an operation, tracks the stash ref, and decides whether a write is git's. Pure decision logic is unit-testable without VS Code.
- `src/gitBaseline.ts`: reuses `runGit` and `ls-files -s` parsing; still only reads the repository (`--no-optional-locks`).
- `src/config.ts`, `package.json`: the new setting. README settings table.
- Linked worktrees (checkout-scope lanes): each checkout's per-worktree git directory is read, and the stash ref in the repository's common directory.
- Tests: unit tests with real git fixtures (`test/gitFixture.ts`); an integration test in `it/` for a merge with and without conflicts.
- Related: at-9oi (bounding the change buffer); this change removes the largest source of bursts that problem describes.
