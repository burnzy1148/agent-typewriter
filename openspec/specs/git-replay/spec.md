# git-replay Specification

## Purpose
Types out work that was never watched, such as a branch or a pull request, by building the timeline from a git commit range, with each change's before and after text read from history and the repository only read.

## Requirements

### Requirement: Replay a commit range as typing
The Replay Git Commits command SHALL build the buffer from the commits of a git range in a workspace folder's repository, oldest first, with one change per changed file per commit. A change's before text SHALL be the file as it was in the commit's parent and its after text the file as it is in the commit, both read from git.

#### Scenario: Replay a branch
- **WHEN** branch `feature` has two commits on top of `main`, the first changing `src/a.ts` and adding `src/b.ts`, the second changing `src/a.ts` again, and the user replays `main..feature`
- **THEN** the buffer holds a modify of `src/a.ts`, a create of `src/b.ts`, and a modify of `src/a.ts`, in that order
- **AND** the second `src/a.ts` change starts from the text the first one ended with

#### Scenario: Working tree differs from history
- **WHEN** `src/a.ts` has uncommitted edits on disk and the user replays a range that changes it
- **THEN** each change's before and after text is the committed text, not the text on disk

#### Scenario: Single commit
- **WHEN** the user enters one commit instead of a range
- **THEN** only that commit's changes are replayed

### Requirement: Change kinds and paths
A file added by a replayed commit SHALL be a create, a removed file a delete, a file git detects as renamed a rename, and any other changed file a modify. Only files inside the workspace folder SHALL be replayed, and each SHALL replay into the same mirror document as a recorded change to that file in the folder's own checkout (with the folder's label in front of the path in a multi-root workspace).

#### Scenario: Folder below the repository top
- **WHEN** the workspace folder is `repo/pkg` and a replayed commit changes `repo/pkg/src/a.ts` and `repo/README.md`
- **THEN** the buffer holds one change, to `src/a.ts`

#### Scenario: Multi-root workspace
- **WHEN** folders `api` and `web` are open and the user replays a commit in `api` that changes `src/a.ts`
- **THEN** the change plays into the mirror named `api/src/a.ts`, the same one a recorded change to that file uses

### Requirement: Git renames replay as renames
Renames SHALL be detected at git's default similarity. A rename whose old or new path the filters leave out SHALL replay as a create of the new path or a delete of the old one, and a rename without a content change SHALL still be replayed.

#### Scenario: Renamed file
- **WHEN** a replayed commit runs `git mv src/a.ts src/b.ts`
- **THEN** the buffer holds one rename from `src/a.ts` to `src/b.ts`

#### Scenario: Renamed out of the filters
- **WHEN** the filters record `*.ts` and a replayed commit renames `src/a.ts` to `src/a.txt`
- **THEN** the buffer holds a delete of `src/a.ts`

### Requirement: Choose the range
The command SHALL let the user pick a workspace folder when more than one is open, then offer: the current branch's commits that are not on the default branch, another local or remote-tracking branch's commits that are not on the default branch, the last commit, and a range typed in git's revision syntax. Input starting with `-` SHALL be refused.

#### Scenario: Pull request branch
- **WHEN** the pull request branch `origin/fix` is fetched but not checked out and the user picks it
- **THEN** the commits of `origin/fix` that are not on the default branch are replayed, and HEAD does not change

### Requirement: Default branch
The default branch SHALL be the remote's default branch when git knows it, else the first of `origin/main`, `origin/master`, `main`, `master` that exists.

#### Scenario: Remote default branch
- **WHEN** `origin/HEAD` points at `origin/develop`
- **THEN** "This branch" replays `origin/develop..HEAD`

#### Scenario: Not a repository
- **WHEN** the chosen folder is not in a git repository
- **THEN** an error says so and the buffer is unchanged

#### Scenario: Invalid range
- **WHEN** the user enters a range git cannot resolve
- **THEN** an error shows git's reason and the buffer is unchanged

#### Scenario: Empty range
- **WHEN** the range holds no commits with replayable changes
- **THEN** a message says there is nothing to replay and the buffer is unchanged

### Requirement: What is skipped
Merge commits SHALL be skipped. Only regular files SHALL be replayed; symbolic links and submodules SHALL be skipped. Paths the watch filters leave out, binary files, and files larger than `agentTypewriter.maxFileSizeKB` on either side of a change SHALL be skipped, as SHALL a change whose before and after text are equal. The completion message SHALL say how many changes and commits were skipped and why.

#### Scenario: Filtered path
- **WHEN** `agentTypewriter.extensions` is `["ts"]` and a replayed commit changes `src/a.ts` and `notes.txt`
- **THEN** only the `src/a.ts` change is in the buffer

#### Scenario: Merge from the default branch
- **WHEN** a pull request branch merged `main` into itself and the user replays the branch's commits
- **THEN** the merge commit adds no changes, and the branch's own commits are replayed

### Requirement: Git LFS and shallow clones
Git LFS pointers SHALL be skipped rather than typed, and their content SHALL NOT be downloaded. In a shallow clone, the commits at the clone's boundary SHALL be skipped, because their parents are missing.

#### Scenario: Git LFS file
- **WHEN** a replayed commit changes a file stored in Git LFS
- **THEN** that change is skipped and counted, and no LFS content is downloaded

#### Scenario: Shallow clone
- **WHEN** the repository is a shallow clone and the range reaches its oldest commit
- **THEN** that commit is skipped instead of replaying every file as created

### Requirement: Replay replaces the buffer and starts playing
Replaying SHALL replace the buffer, after asking when the buffer is not empty. When watching, replaying SHALL stop watching so that live edits do not mix into the replayed history, and the confirmation SHALL say so. After replaying, every change SHALL be pending and playback SHALL start at the first one. When the range holds more changes than `agentTypewriter.historyLimit`, the user SHALL get the same choice as when loading a session file: raise the limit or keep only the newest changes.

#### Scenario: Replay starts playing
- **WHEN** the user picks a range and the replay is built
- **THEN** playback starts at the first replayed change without a separate resume

#### Scenario: Replay while watching
- **WHEN** the extension is watching with recorded changes in the buffer and the user replays a range and confirms
- **THEN** watching stops, the buffer holds only the replayed changes, and playback starts at the first one
- **AND** the changes are typed in commit order, each mirror ending with the file's text in the range's last commit that changed it

#### Scenario: Declined
- **WHEN** the buffer is not empty and the user declines the confirmation
- **THEN** the buffer, playback and watching are unchanged

### Requirement: Scripted replay
The command SHALL accept a range (and optionally a workspace folder) as an argument, which skips the pickers and the confirmation and keeps the newest changes within `agentTypewriter.historyLimit`. A scripted replay SHALL start paused at the first change unless the argument asks it to play.

#### Scenario: Scripted replay
- **WHEN** a script runs the command with the range `main..feature` and no request to play
- **THEN** the buffer holds the replayed changes and playback is paused at the first one

### Requirement: The repository is only read
Replaying SHALL NOT change the repository or the user's files: no checkout, fetch, commit or ref update, no change to HEAD, the index, or the working tree. Changes SHALL be typed only into mirror documents.

#### Scenario: Partial clone
- **WHEN** the repository is a partial clone that lacks some old file contents and the user replays a range that needs them
- **THEN** nothing is fetched (with git 2.44 or later), and the changes whose contents are missing are skipped and counted as unreadable

#### Scenario: Repository untouched
- **WHEN** the user replays a range and playback types every change
- **THEN** HEAD, the branches, the index and every file in the working tree are as they were before the replay
