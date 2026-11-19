# Proposal

## Why

The Claude Code pane types out only the edits the session makes while it runs. Work that was never watched, such as a branch someone pushed or a pull request under review, can be replayed in the VS Code extension (`git-replay`) but not beside the conversation in Claude Code. The at-o3z.8 mockup's Mapping board carries git replay over as `/typewriter replay main..HEAD` and `/typewriter pr 123`, reading git (and `gh` for a pull request) and typing the range in a lane of its own. The pieces are in place: at-o3z.5 put the plugin's changes in the shared `Timeline`, at-o3z.15 gives the pane lanes, and the engine's `$.process.run` runs git and gh on the host.

## What Changes

- **`/typewriter replay [range]`.** Reads the commits of a range in git's revision syntax from the repository holding the session's working directory, oldest first, one change per changed file per commit, with before and after text read from git, as `git-replay` does for the extension. With no range, it replays the current branch's commits that are not on the default branch, the extension's "This branch". A single commit replays that commit. Input starting with `-` is refused.
- **`/typewriter pr <number>`.** Asks `gh` for the pull request's head commit and commits and replays those commits, merges skipped. It takes a number, `#number` or a pull request URL. Nothing is fetched: when the head commit is not in the local repository, the answer says so and names the `git fetch` the person can run themselves.
- **Read only.** Every git and gh call runs through `$.process.run` and reads: no checkout, fetch, commit or ref update, no change to HEAD, the index or the working tree, no lazy fetch in a partial clone, no Git LFS download. The plugin still writes no file.
- **What is replayed and skipped.** Files inside the session's working directory only, named as the pane names any file. Adds, deletes and renames keep their kind. Merge commits, symbolic links, submodules, binary files, files over 1,000,000 bytes, Git LFS pointers, a shallow clone's boundary commits and blobs git cannot read are skipped, and the answer says how many and why. The plugin has no path filters, so none apply.
- **Its own lane.** The replay's changes go in a lane of their own, labeled with the range or `PR #123`, beside the session's lanes, which keep recording. Starting a replay opens the pane, follows the replay's lane and starts typing its first change. The lane counts as finished, so once it plays out it gives way to a lane with changes queued, as a finished subagent's does. A new replay replaces the earlier replay's lane.
- **In the list.** Grouped by turn, each replayed commit is a chapter of its own, headed by its short hash and subject, with a count and Play commit. Grouped by file, replayed changes join their files' groups. A replayed row shows its change's kind (`Add`, `Modify`, `Delete`, `Rename`) where a recorded row shows its tool. A replayed change's caption is its commit's subject. Replayed changes have no call in the conversation, so no Show in conversation, ↗ or chip.
- **Limits and reload.** Replayed changes share the buffer's limits; a range larger than them keeps its newest changes that fit, and the answer says how many were loaded. Replayed changes, their lane and their commits survive a plugin reload within the session.
- **Shared history reader.** The extension's commit-range logic moves into a pure module the plugin bundle shares, so both read history the same way.

Out of scope:
- Fetching a pull request's commits, for either frontend. at-dqb.4 decides the extension's side; this change takes "only replay what is already local" for the plugin.
- Pickers for a folder, branch or range: the plugin takes the range as text.
- Replaying into a terminal session, which is left to the VS Code extension.
- Changing the extension's `git-replay` behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for `/typewriter replay` and `/typewriter pr`, the default range, choosing a pull request's commits, what is replayed and skipped, the repository only being read, the replay's lane, a replay starting playback, commit chapters, replayed rows and captions, replays within the limits, and replays surviving a reload. Modifies *The plugin never writes files* (it also reads git history), *Pane lists the session's changes* (a replayed row shows its kind), *The changes list is grouped by turn* and *Changes outside a known turn* (replayed commits have chapters of their own), and *Show in conversation from the pane* (only for changes a call made).

## Impact

- New `src/gitHistory.ts`: the pure part of `src/gitReplay.ts` (range parsing, `rev-list` and `diff-tree` parsing, rename and skip rules, building the changes), behind a small reader interface; `src/gitReplay.ts` becomes its Node adapter with unchanged behavior. It joins `CORE_ENTRY` in `scripts/build-claude-code.mjs`, and `claude-code/hooks/core.mjs` and `core.d.mts` are rebuilt.
- New `claude-code/hooks/git.ts`: the plugin's reader over `$.process.run`, the default base, and the pull request lookup through `gh`.
- `claude-code/hooks/replay.ts`: replayed changes (kind `delete` and `rename`, `fromPath`, `commit`), the replay lane, commit chapters, row labels, `savedOf`/`savedFrom`.
- `claude-code/hooks/register.tsx`: `/typewriter` subcommands and their answers, an `argumentHint`, a replay in flight, drawing commit chapters and replayed rows.
- `claude-code/types/index.d.ts`: `SavedChange` gains `fromPath` and `commit`; `Saved` and `Listing` take new tags after at-o3z.15's.
- Tests in `claude-code/tests/` and `test/`; `claude-code/README.md`.
- Lands after at-o3z.15 (lanes), and after .16, .6, .17, .18 and .20 in the plugin queue; see design.md.
