# Proposal

## Why

Agent Typewriter replays changes it watched happen. Work that already landed in git, such as a branch an agent pushed overnight or the commits of a pull request, cannot be replayed, because nobody was watching when it was written. Git already holds every commit's before and after text, so the extension can build the same timeline from history and type it out (bead at-dqb.3).

## What Changes

- New command **Replay Git Commits...** builds the buffer from a git commit range in a workspace folder: one change per file per commit, in commit order, oldest first. Each change's before text is the file in the commit's parent and its after text is the file in the commit, both read from git, never from disk.
- The command offers the current branch's commits that are not on the default branch, another branch's commits that are not on the default branch (a pull request branch that is fetched but not checked out), the last commit, or a range typed in git's syntax (`main..feature`, a single commit, `HEAD~5..HEAD`).
- Merge commits are skipped, as `git log -p` does. Only regular files are replayed. Paths the watch filters leave out (include, exclude, extensions), binary files, and files over `maxFileSizeKB` are skipped, and the result message says how many.
- The replay replaces the buffer after confirming, stops watching so live edits do not mix in, and starts paused at the first change, like Load Session from File. Larger ranges than `historyLimit` get the same raise-or-keep-newest choice.
- The repository is only read: no checkout, no fetch, no change to HEAD, the index, refs or the working tree. Changes are typed into mirror documents only.
- The command also takes a `{ range, folder }` argument that skips the pickers and the confirmation, for scripting and tests.

## Capabilities

### New Capabilities
- `git-replay`: building the buffer from a git commit range and how that interacts with recording and playback.

### Modified Capabilities
None.

## Impact

- New `src/gitReplay.ts`: lists a range's commits, reads each commit's file changes and blobs through the runner in `src/gitBaseline.ts`, and turns them into timeline events. No VS Code dependency.
- `src/extension.ts`: the command, its folder and range pickers, confirmation, and the history limit choice shared with Load Session.
- `package.json`: the command and its menu entry. README: a section on replaying git history.
- `test/gitReplay.test.ts`: unit tests on real temporary repositories. `it/gitReplay.ts` plus a launch in `it/runTest.ts`: replays a branch end to end and checks the repository is untouched.
- Out of scope: looking up a GitHub pull request by number (needs network access and a fetch, which writes to the repository), and showing each change's commit in the panel (needs a session format field; the rename lane is bumping the format now). Both become follow-up beads.
