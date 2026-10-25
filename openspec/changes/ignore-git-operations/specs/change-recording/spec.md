# Spec Delta

## ADDED Requirements

### Requirement: Git operations are not recorded
With `agentTypewriter.ignoreGitOperations` on, a write SHALL NOT be recorded when a git operation that brings in content from a commit made it: merge, pull, checkout or switch of a branch or commit, rebase, cherry-pick, revert, or reset to another commit. A write is git's only when that operation changed the path's index entry and the file agrees with the new entry. The written text SHALL become the file's baseline.

#### Scenario: Fast-forward merge
- **WHEN** recording is on and the user runs `git merge feature`, which fast-forwards and rewrites 40 files
- **THEN** no change is recorded for any of the 40 files
- **AND** an agent's next edit to one of them is recorded with the merged text as its before text

#### Scenario: Branch switch
- **WHEN** the user runs `git switch other`, which changes, adds and removes files
- **THEN** no create, modify, delete or rename is recorded for those files

#### Scenario: Pull with a merge commit
- **WHEN** the user runs `git pull` and git merges the fetched commits into the checkout
- **THEN** no change is recorded for the files the merge wrote

#### Scenario: Rebase
- **WHEN** the user runs `git rebase main` and git applies three commits, rewriting files at each step
- **THEN** no change is recorded for the files any step wrote

#### Scenario: Chosen worktree
- **WHEN** a sibling worktree is recorded in its own lane and the user merges a branch in that worktree
- **THEN** no change is recorded in that lane for the files the merge wrote

### Requirement: Conflicted files are baselines and their resolutions are recorded
When a merge, rebase, cherry-pick, revert or pull stops on conflicts, the text git writes into each conflicted file SHALL become its baseline without being recorded. A later write that resolves the conflict SHALL be recorded as a modify from the conflicted text to the resolved text, under the same own-save rule as any other write. Aborting the operation SHALL count as a git operation.

#### Scenario: Agent resolves a merge conflict
- **WHEN** `git merge feature` stops with a conflict in `a.ts` and an agent then rewrites `a.ts` without the conflict markers
- **THEN** no change is recorded for the merge's write of `a.ts`
- **AND** one modify is recorded for the agent's write, whose before text has the conflict markers and whose after text is the resolved file

#### Scenario: User resolves in an editor
- **WHEN** `ignoreOwnSaves` is on, a merge stops with a conflict in `a.ts`, and the user resolves it in a VS Code editor and saves
- **THEN** no change is recorded for the save
- **AND** an agent's next edit to `a.ts` is recorded with the user's resolved text as its before text

#### Scenario: Choosing a side
- **WHEN** a merge stops with a conflict in `a.ts` and the user runs `git checkout --theirs a.ts`
- **THEN** a modify of `a.ts` from the conflicted text to the chosen side is recorded

#### Scenario: Merge aborted
- **WHEN** a merge stops with conflicts and the user runs `git merge --abort`
- **THEN** no change is recorded for the files the abort restores

#### Scenario: Rebase continues after a conflict
- **WHEN** an agent resolves a rebase conflict and runs `git rebase --continue`, and git applies the remaining commits
- **THEN** the resolution is recorded, and no change is recorded for the files the remaining commits wrote

### Requirement: Stash push and pop are not recorded
With `agentTypewriter.ignoreGitOperations` on, `git stash push` SHALL NOT record its writes that return files to the index, and `git stash pop` SHALL NOT record its writes to the paths the popped stash recorded. Their written text SHALL become the files' baselines.

#### Scenario: Stash, pull, pop
- **WHEN** the user has unstaged edits to `a.ts`, runs `git stash`, `git pull` and `git stash pop`
- **THEN** no change is recorded for `a.ts` or any file the pull wrote
- **AND** an agent's next edit to `a.ts` is recorded with the popped text as its before text

#### Scenario: Stash with untracked files
- **WHEN** the user runs `git stash -u` with an untracked `notes.ts`, then `git stash pop`
- **THEN** neither the removal nor the return of `notes.ts` is recorded

### Requirement: Edits during a git operation are recorded
A write whose path the operation did not change in the index, or whose text does not agree with git's result, SHALL be recorded as usual, even when it lands while a git operation runs. Git activity that changes no index entry, such as a `git status` refreshing the index, SHALL NOT keep any write from being recorded.

#### Scenario: Agent edits while the user merges
- **WHEN** an agent writes `b.ts` while `git merge feature` runs, and the merge does not touch `b.ts`
- **THEN** the agent's change to `b.ts` is recorded

#### Scenario: Background status refresh
- **WHEN** an agent writes `a.ts` back to its committed text and VS Code's git extension then refreshes the index
- **THEN** the agent's change to `a.ts` is recorded

#### Scenario: Agent overwrites a merged file
- **WHEN** a merge rewrites `a.ts` and an agent writes different text to `a.ts` before the recorder reads it
- **THEN** a modify of `a.ts` is recorded, with the agent's text as its after text

### Requirement: Discards and stash apply are recorded
Writes that return working-tree edits to the index without changing the index entry, such as `git restore <path>`, `git checkout -- <path>` or `git reset --hard` to the current commit, SHALL be recorded like any other edit. So SHALL the writes of `git stash apply`, which leaves the stash in place.

#### Scenario: Restore a file
- **WHEN** an agent edits `a.ts` and then runs `git restore a.ts`
- **THEN** the edit and the restore are both recorded, and replaying them ends with the committed text

#### Scenario: Stash apply
- **WHEN** the user runs `git stash apply`
- **THEN** the files it writes are recorded as changes

### Requirement: Git operation setting
The setting `agentTypewriter.ignoreGitOperations` SHALL default to on and SHALL apply while recording without a restart. With it off, outside a git repository, or when git cannot run, every write SHALL be recorded as before this requirement, and recording SHALL NOT fail. When git cannot run, the output channel SHALL say once that git operations are recorded.

#### Scenario: Setting off
- **WHEN** `ignoreGitOperations` is off and the user runs `git merge feature`
- **THEN** each file the merge wrote is recorded as a change

#### Scenario: Folder is not a repository
- **WHEN** the workspace folder has no git repository
- **THEN** every write is recorded as before

#### Scenario: Git becomes unavailable
- **WHEN** running `git` fails because it is not found while a write is being classified
- **THEN** the write is recorded
- **AND** the output channel says, once, that git operations are recorded because git is unavailable

#### Scenario: Turned on while recording
- **WHEN** `ignoreGitOperations` is turned on while recording and the user then switches branches
- **THEN** no change is recorded for the files the switch wrote
