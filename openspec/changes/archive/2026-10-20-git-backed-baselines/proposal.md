# Proposal

## Why

On start, the recorder reads every matching file into memory so it knows each file's before text when the first change lands. It stops at 5000 files, and which files miss out depends on search order. A file without a snapshot has its first change captured only as a baseline and never replayed, so in large repos agent edits are silently missing from replay (bead at-net.5).

## What Changes

- New setting `agentTypewriter.gitBaselines` (default `true`). When on, files that git reports as tracked and unmodified are not read into memory. The recorder remembers each file's git blob, and on its first change reads the before text from the watched workspace's git repository.
- Git use turns itself off where git can't help: if the `git` command is not installed or cannot run, git-backed baselines are skipped for the whole session with one log line, and a folder outside a git repository uses memory only. Users can also turn the setting off.
- Files that are modified or untracked are snapshotted in memory as today.
- The 5000-file cap is replaced by a memory budget, `agentTypewriter.baselineBudgetMB` (default 256). In-memory snapshots are taken most recently modified first until the budget is spent, so the files an agent is likely to touch next are the ones covered.
- Turning `gitBaselines` on or off while watching takes effect immediately. Turning it off converts git-backed baselines to in-memory snapshots, within the budget.
- Git is only read (`ls-files`, `cat-file`). The extension never changes the watched repository.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-recording`: adds requirements for baseline coverage (memory budget instead of a file cap), optional git-backed baselines, read-only git use, and live toggling. Existing requirements are unchanged.

## Impact

- `src/recorder.ts`: baseline capture goes through a budget and an optional git-backed path. `flush` loads a git baseline the first time a file without an in-memory snapshot changes.
- New `src/gitBaseline.ts`: runs `git` with `child_process`, plus pure parsers for `ls-files -s -z` and `ls-files -m -z` output, unit-tested.
- `src/config.ts`, `package.json` and README: the two new settings. The README line about the 5000-file limit is replaced.
- `src/extension.ts`: reacts to changes of the two settings while watching.
- `it/runTest.ts` and `it/suite.ts`: the integration workspace becomes a git repository, and new sections cover git-backed first changes and toggling.
- Optional use of the user's `git` command-line tool. Without it, the extension behaves as with `gitBaselines` off.
