# Design

## Context

`captureBaseline` lists files with `findFiles` (limit 20000), keeps those passing the filter, truncates to 5000, then reads each into `snapshots: Map<uri, {text, eol}>`. `flush` treats a file with no snapshot as baseline-only. See proposal.md for why that loses agent edits.

## Goals / Non-Goals

**Goals:**
- Exact before text for every clean tracked file, with no per-file memory, when the user opts in.
- Predictable coverage without git: a size budget, newest files first.
- Every git interaction is read-only, and a missing or broken git never breaks recording.

**Non-Goals:**
- Submodules and nested repositories. Their files fall back to in-memory snapshots.
- Using VS Code's Git extension API. It isn't guaranteed to be active, and it can't apply filters to a blob.
- Re-checking git state while watching. Baselines are classified at start and on toggle only.

## Decisions

### 1. Git access in `src/gitBaseline.ts`

Calls go through `execFile('git', args, { cwd, maxBuffer })`, never a shell, and every command runs with `--no-optional-locks` so git never rewrites `.git/index`. Per workspace folder:

1. `git ls-files -s -z` gives tracked entries `mode sha stage\tpath`. Only stage 0 and regular-file modes (100644, 100755) are kept.
2. `git ls-files -m -z` lists files modified in the working tree against the index. Those are excluded. A file whose stat info is stale may show up here even though its content is unchanged. That only means it gets a memory snapshot instead, which is safe.
3. Every other entry is clean: its index blob equals its disk content after filters, so it gets `{ path, sha }`.

Both commands run with the folder as cwd and print folder-relative paths. `git status` is not used because its paths are relative to the repo root, and joining those onto a root that git spells differently from VS Code breaks on Windows (8.3 short names such as `RUNNER~1`). If the process cannot start (ENOENT, EACCES, or a timeout), git is unavailable: a session flag turns git baselines off until the next start or toggle, and one line is logged. Any other failure means the folder isn't a repo, so it gets no git baselines.

At first change, `git cat-file --filters --path=<path> <sha>` returns the content with the repo's eol and smudge filters applied, which is what is on disk. The result is decoded like `readText`, with the same size and binary checks.

The parsers (`parseLsFiles`, `parsePathList`, `classifyClean`) are pure and unit-tested. Process calls are injected so the logic is testable without git.

*Alternative considered:* `git show HEAD:path`. HEAD can differ from the index for staged files, and HEAD moves if the agent commits. Using the index blob sha avoids both problems.

### 2. Two baseline stores in the recorder

`snapshots` stays as is. A new `gitBaselines: Map<uri, GitBaseline>` sits beside it.

In `flush`, when `snapshots` has no entry and `gitBaselines` does, the recorder loads it, deletes it, and uses the result as `previous`. A load failure is logged and the file is treated as having no baseline. Own-save, reorder and delete handling then work unchanged on `previous`. A deleted file with a git baseline is loaded too, so the delete replays correctly.

### 3. Memory budget and selection order

`selectWithinBudget(candidates: {key, size, mtime}[], budgetBytes)` is pure. It sorts by mtime descending and takes files while the running size stays within the budget, skipping any single file over the budget. `captureBaseline` stats the non-git candidates in batches to get size and mtime, then reads only the selected ones. The `findFiles` limit is removed. The existing `maxFileSizeKB` check still applies per file.

### 4. Live toggling

`extension.ts` calls `recorder.refreshBaselines()` when `gitBaselines` or `baselineBudgetMB` changes. Every stored baseline, whether an in-memory snapshot or a git blob of a clean file, equals the file's current disk text, because the recorder replaces a file's snapshot with the disk text on each change. So the refresh drops all baselines of files with no pending debounce burst and runs `captureBaseline` again:
- **Turning off:** files are re-read from disk within the budget.
- **Turning on:** clean tracked files move to git baselines, and the rest stay in memory.
- **Budget change:** selection runs again.

Files mid-change keep their current baseline.

### 5. Settings

- `agentTypewriter.gitBaselines`: boolean, default `true`. The description says it uses the `git` CLI when available and turns itself off otherwise.
- `agentTypewriter.baselineBudgetMB`: number, default `256`, minimum `0`. `0` means no in-memory baselines, which tests use.

## Risks / Trade-offs

- [Large repos: `ls-files` on 100k files take seconds] → They run once at start, under the existing "snapshotting files" progress indicator, and output is streamed into the parsers.
- [LFS files read without git-lfs installed come back as pointer text] → The before text would be the pointer. These are usually binary assets that the size and binary checks skip.
- [A file changed between `ls-files` and the watcher starting] → The watcher is created before baselines are captured, as today. A change in that gap loads a baseline that may already be stale, the same race as the in-memory path.
- [A `git` on PATH that is old or prompts] → Commands run with `GIT_TERMINAL_PROMPT=0` and a timeout. Any error falls back to in-memory baselines.

## Migration Plan

`gitBaselines` is on by default. In git repositories with git installed, clean tracked files stop using memory and first changes are replayed exactly. Elsewhere it turns itself off and only the budget replacing the 5000-file cap is new. 256 MB covers far more than 5000 typical source files. Setting it to `false` restores memory-only baselines.
