# Design

## Context

See proposal.md for why. Today `Recorder.schedule()` debounces each watcher event and `flush()` reads the file and records it against its snapshot or git baseline; nothing in that path knows about git. The path filter drops everything under `.git`, and `files.watcherExclude` may hide it too. The recorder already runs read-only git through `runGit` (`--no-optional-locks`) for git baselines, ignored paths and worktree listing, and it already tracks per-checkout scopes (lanes) with their common git directory. The `ReorderBuffer` can hold a change's place in write order while its outcome is undecided (`hold()`), which `flush()` already uses for the own-save wait.

The player shows each change's before text in the mirror before typing it, so a write that is not recorded leaves no inconsistency: the next recorded change for that file starts from its own before text.

## Goals / Non-Goals

**Goals:**
- Attribute a write to git only from git's own state, so agent edits are never swallowed by timing alone.
- No dependence on watcher events from inside `.git`.
- Cost of zero git calls per write when no git operation has happened; one batch of calls per operation otherwise.
- Same behavior in every lane, including chosen linked worktrees.

**Non-Goals:**
- Recognizing discards back to the index or `git stash apply` (see the spec).
- Submodule checkouts (a separate repository inside the checkout); their files record as before.
- Skipping work done by `git worktree add`, which checkout-scope already handles.

## Decisions

### 1. A write is git's when the operation changed its path in the index and the file agrees

Each checkout keeps the index entries (mode, blob, stage per path) as of the last settled operation. When an operation settles, the recorder re-reads `git ls-files -s -z` and diffs: the changed paths are those added, removed, or whose blob, mode or stage set changed. A flushed write is git's when its path is in an operation's changed set, it was written inside that operation's time span, and the file agrees with the new index: not listed by `git diff-files` (stage 0, content matches), unmerged (conflicted), or gone from both the index and disk (removed).

Alternatives: a time window alone ("anything written while `index.lock` exists") swallows agent writes during a commit or during VS Code's background `git status`, which takes the lock too. Content alone ("file matches the index") swallows an agent that writes a file back to its committed text. Diffing `ORIG_HEAD..HEAD` misses conflicted merges (HEAD does not move), aborts, and repositories without reflogs. The index diff covers all of them the same way.

### 2. Only ref and state changes start an operation

An operation is detected when one of these changed since the last look: in the checkout's own git directory `HEAD`, `ORIG_HEAD`, `logs/HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, `rebase-merge/`, `rebase-apply/`; in the common directory the ref `HEAD` names (loose file, `packed-refs`, or `reftable/tables.list`), `refs/stash` and `logs/refs/stash`. A change to `index` alone never starts one. That keeps background status refreshes, `git add`, discards and `checkout --ours/--theirs` (all index-only) out, which is what the spec asks for, and means most index rewrites cost nothing.

### 3. Markers are stat'ed at flush time, not watched

Before recording a write, `flush()` stats the markers of the write's checkout (cached for a few milliseconds so a burst of flushes shares one look). Watching `.git` was rejected: `files.watcherExclude` can hide it, the watcher can coalesce a short-lived `index.lock` create and delete into nothing, and Windows reports seconds late. A stat at flush time sees the state git leaves on disk whatever the watcher did.

### 4. Waiting for the operation to settle

Git holds `index.lock` while it rewrites the working tree, so a write git made is flushed either while the lock exists or after git has updated the index. If `index.lock` exists, the flush takes a `ReorderBuffer.hold()` at the write's time and polls every 100 ms until the lock is gone, for at most 10 s; a stale lock past that cap stops the wait and the write is classified with what is on disk then. If `index` changed since the last look but no ref marker has yet (git updates `HEAD` just after releasing the index), the flush waits one 250 ms grace and looks again. Neither wait happens when the index is unchanged, so ordinary agent edits pay nothing beyond the stat.

### 5. One refresh per operation, shared by its writes

The refresh after an operation runs once per checkout (a keyed single-flight, like `KeyedSerial`): `ls-files -s`, the index diff, `git diff-files --name-only -z -- <changed paths>` for agreement, and the stash step below. It produces an operation record of the paths git vouches for, existing or removed, and a span. The span starts at the later of the previous state and 10 s before the earliest changed marker (or when `index.lock` was first seen), less `CAPTURE_SKEW_MS`. It ends at the latest marker mtime git wrote (refs, state files, index) plus 50 ms: git writes the working tree before them on the same clock, so an agent's resolution written right after a conflict falls outside it. Records are kept for one minute so late flushes of the same operation (Windows watcher lag) still find them, and when spans overlap (a pop right after a push) the newest wins. An agent write after the span records; one inside it that does not match git's result is dirty and records.

### 6. Stash tracking

The checkout state keeps the `refs/stash` commit. When the stash ref or its reflog changed during an operation: a new top entry is a push, and its paths (`git diff-tree -r --name-only` against the stash commit's first parent, plus its untracked parent when present) count as changed for agreement against the index; a top entry that went away is a pop, and the old commit's paths count as git's when written inside the span, without the index-agreement check, since a pop leaves its edits unstaged. `git stash apply` changes no ref and so is not detected, as the spec says. The stash ref lives in the common directory, so a push in one worktree is attributed only to the checkout whose own markers also changed in the same span.

### 7. Baselines after a skipped write

`flush()` already stores the new snapshot before deciding; a skipped write keeps that and records nothing, with a trace note. A file without a snapshot that had a git baseline gets its baseline pointed at the new index blob when it agrees with stage 0 (no memory cost), otherwise an in-memory snapshot within the budget. Skipped deletes drop the snapshot and any git baseline. One output-channel line per operation says how many writes were skipped, e.g. `Skipped 40 files written by git (merge) in <lane>`.

### 8. Where the check sits in `flush()`

After the own-save decision and before every recording path: `record()` for creates, modifies and deletes, `holdDelete()` in chosen worktrees, and rename pairing. A git checkout that moves a file therefore records neither half, and no held delete waits for a create that will never be recorded. The checks that a chosen worktree is being removed still run first.

### 9. Git directory per checkout

The checkout's own git directory comes from its `.git` (a directory, or a file whose `gitdir:` line `gitdirOf` parses); the common directory is already on the scope (`commonDir`). A folder outside git, or a scope with `repo` false, skips classification. When `runGit` fails with `isGitUnavailable`, classification turns off for the session with one output-channel message, the same pattern as git baselines. With `gitBaselines` off the recorder still runs `ls-files -s` once per checkout for the initial index state, since this setting is separate.

## Risks / Trade-offs

- [The index-entry map costs memory on large repositories, roughly 100 bytes per tracked file] → Store a short digest of each entry rather than the line; drop the map when the setting is off or recording stops.
- [An agent write landing inside an operation's span, to a path the operation changed, with exactly git's resulting text, is skipped] → It changes nothing the next recorded change does not already show; accepted.
- [A long operation holds later changes in the reorder buffer for up to 10 s] → Only while `index.lock` exists; the cap bounds it, and a stale lock costs one 10 s delay per flush burst, not a stall.
- [The ref `HEAD` points to may be packed or in reftable, or the reflog disabled] → Several markers per operation kind; `ORIG_HEAD` and the state files cover merges, resets and rebases without reflogs.
- [Network or virtual filesystems with coarse mtimes blur spans] → Spans are widened by `CAPTURE_SKEW_MS`, and attribution still needs the index diff, so blur can only miss a skip, never swallow an unrelated edit.

## Migration Plan

New setting, on by default; no stored data changes. Rollback is turning `agentTypewriter.ignoreGitOperations` off, which restores the previous recording exactly.

## Open Questions

- The 100 ms poll, 250 ms grace and 10 s cap are starting values; tune them against the integration tests on Windows.
