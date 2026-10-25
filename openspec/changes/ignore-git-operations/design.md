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

Each checkout keeps the index entries (mode, blob, stage per path) as of the last settled operation. When an operation settles, the recorder re-reads `git ls-files -s -z` and diffs: the changed paths are those added, removed, or whose blob, mode or stage set changed. A flushed write is git's when its path is in an operation's changed set, it was written inside that operation's time span, and the file agrees with the new index: clean against it at stage 0 (`git diff --name-only`, which compares content), unmerged (conflicted), or gone from both the index and disk (removed). A stage-0 blob must also be no newer than the file: git writes a file from a blob that already exists (or that a merge has just made), while `git add` and `commit -a` make the blob from the file after it was written. The blob's age is the mtime of its loose object; a packed object is old. This keeps an agent's edit that is staged and committed before the recorder reads it from passing as git's.

A conflict needs one more rule, because a resolution can reuse a blob that is already packed (`checkout --theirs`, or text identical to one side): a path that was conflicted at the previous look and is not now was resolved by whoever wrote it, and is not a candidate. The exception is an operation whose new reflog entries throw the conflicts away (`reset`, as `merge --abort` and `cherry-pick --abort` write; `rebase (abort)`; `checkout`), where git rewrites the files itself.

A removal is timed by the mtime of the directory the file left (or the nearest one above it that still exists, since git removes a directory it emptied), not by when the watcher reported it. That separates git removing a file from an agent deleting one that an operation only unstaged (`reset HEAD~1`) or a stash pop restored. A removed path also counts only if it was already gone when the operation was read.

Spans can overlap (a pop right after a push, or an edit committed right after an operation), so the newest operation whose span holds the write and that touched the path decides; an older one never claims a path a newer one declined.

Alternatives: a time window alone ("anything written while `index.lock` exists") swallows agent writes during a commit or during VS Code's background `git status`, which takes the lock too. Content alone ("file matches the index") swallows an agent that writes a file back to its committed text. Diffing `ORIG_HEAD..HEAD` misses conflicted merges (HEAD does not move), aborts, and repositories without reflogs. The index diff covers all of them the same way.

### 2. Only ref and state changes start an operation

An operation is detected when one of these changed since the last look: in the checkout's own git directory `HEAD`, `ORIG_HEAD`, `logs/HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, `rebase-merge/`, `rebase-apply/`; in the common directory the ref `HEAD` names (loose file, `packed-refs`, or `reftable/tables.list`), `refs/stash` and `logs/refs/stash`. A change to `index` alone never starts one. That keeps background status refreshes, `git add`, discards and `checkout --ours/--theirs` (all index-only) out, which is what the spec asks for, and means most index rewrites cost nothing. A refresh reads every HEAD reflog entry added since the previous one (the bytes past `logs/HEAD`'s old size), since several commands can finish within one debounce. A commit moves refs but writes no working-tree files, so when every new entry is a commit (including amend and merge commits) no removal is git's, which covers a file an agent deletes and then commits. Files such a refresh keeps stay guarded by blob age, so `merge --squash` followed by its commit is still recognized. The label comes from the state file that appeared (`MERGE_HEAD` is a merge, and so on), since a stopped merge writes no reflog entry, else from the newest new entry. Without `logs/HEAD` (reftable, or reflogs off) git is asked for the newest entry with `git reflog -n1 --format=%gs`.

### 3. Markers are stat'ed at flush time, not watched

Before recording a write, `flush()` stats the markers of the write's checkout (cached for a few milliseconds so a burst of flushes shares one look). Watching `.git` was rejected: `files.watcherExclude` can hide it, the watcher can coalesce a short-lived `index.lock` create and delete into nothing, and Windows reports seconds late. A stat at flush time sees the state git leaves on disk whatever the watcher did.

### 4. Waiting for the operation to settle

Git holds `index.lock` while it rewrites the working tree, so a write git made is flushed either while the lock exists or after git has updated the index. If `index.lock` exists, the flush takes a `ReorderBuffer.hold()` at the write's time and polls every 100 ms until the lock is gone, for at most 10 s; a stale lock past that cap stops the wait and the write is classified with what is on disk then. The hold is taken only once the classification has to wait (lock, grace or refresh), so an answer from a stat alone orders exactly as before; it lasts at most the lock wait plus git's 30 s timeout. If `index` changed since the last look but no ref marker has yet (git updates `HEAD` just after releasing the index), the flush waits one 250 ms grace and looks again. Neither wait happens when the index is unchanged, so ordinary agent edits pay nothing beyond the stat.

### 5. One refresh per operation, shared by its writes

The refresh after an operation runs once per checkout (a keyed single-flight, like `KeyedSerial`): `ls-files -s`, the index diff, `git diff --name-only --relative -z` (content-compared, unlike plumbing `diff-files`, so racily clean files are not dirty) and the loose-object age of each blob for agreement, and the stash step below. It produces an operation record of the paths git vouches for, existing or removed, and a span. The span starts at the later of the previous state and 10 s before the earliest changed marker (or when `index.lock` was first seen), less `CAPTURE_SKEW_MS`. It ends at the latest marker mtime git wrote (refs, state files, index) plus 50 ms: git writes the working tree before them on the same clock, so an agent's resolution written right after a conflict falls outside it. A marker that disappeared counts by its directory's mtime, which the removal stamped: a stash pop restores untracked files after the index and drops `refs/stash` last. Records are kept for one minute so late flushes of the same operation (Windows watcher lag) still find them. An agent write after the span records; one inside it that does not match git's result is dirty and records.

### 6. Stash tracking

The checkout state keeps the `refs/stash` commit. When the stash ref or its reflog changed during an operation: a new top entry is a push, and its paths (`git diff-tree -r --name-only` against the stash commit's first parent, plus its untracked parent when present) count as changed for agreement against the index; a top entry that went away is a pop, and the old commit's paths count as git's when written inside the span, without the index-agreement check, since a pop leaves its edits unstaged. `git stash apply` changes no ref and so is not detected, as the spec says. The stash ref lives in the common directory, so a push in one worktree is attributed only to the checkout whose own markers also changed in the same span.

### 7. Baselines after a skipped write

`flush()` already stores the new snapshot before deciding; a skipped write keeps that and records nothing, with a trace note. A file without a snapshot that had a git baseline gets its baseline pointed at the new index blob when it agrees with stage 0 (no memory cost), otherwise an in-memory snapshot within the budget. Skipped deletes drop the snapshot and any git baseline. One output-channel line per operation says how many writes were skipped, e.g. `Skipped 40 files written by git (merge) in <lane>`.

### 8. Where the check sits in `flush()`

After the own-save decision and before every recording path: `record()` for creates, modifies and deletes, `holdDelete()` in chosen worktrees, and rename pairing. A git checkout that moves a file therefore records neither half, and no held delete waits for a create that will never be recorded. The checks that a chosen worktree is being removed still run first.

### 9. Git directory per checkout

The checkout's own git directory comes from its `.git` (a directory, or a file whose `gitdir:` line `gitdirOf` parses); the common directory is already on the scope (`commonDir`). A folder outside git, or a scope with `repo` false, skips classification. When `runGit` fails with `isGitUnavailable`, classification turns off for the session with one output-channel message, the same pattern as git baselines. Any other git failure is logged once per checkout: at start the checkout records everything; during a refresh that operation goes unrecognized (its writes record) and the new marker state is kept, so git is not run again until a marker changes. With `gitBaselines` off the recorder still runs `ls-files -s` once per checkout for the initial index state, since this setting is separate.

## Risks / Trade-offs

- [The index-entry map costs memory on large repositories, roughly 100 bytes per tracked file] → Store a short digest of each entry rather than the line; drop the map when the setting is off or recording stops.
- [An agent write landing inside an operation's span, to a path the operation changed, with exactly git's resulting text, is skipped] → It changes nothing the next recorded change does not already show; accepted.
- [A long operation holds later changes in the reorder buffer for up to 10 s] → Only while `index.lock` exists; the cap bounds it, and a stale lock costs one 10 s delay per flush burst, not a stall.
- [The ref `HEAD` points to may be packed or in reftable, or the reflog disabled] → Several markers per operation kind; `ORIG_HEAD` and the state files cover merges, resets and rebases without reflogs.
- [Filesystems with coarse mtimes (1-2 s) blur spans] → Attribution still needs the index diff and agreement, so blur mostly misses a skip. Not always: a write to a conflicted path in the same mtime tick as the stop is skipped, since a conflicted entry has no content check. Accepted; the modern default filesystems (APFS, NTFS, ext4) stamp in nanoseconds.
- [Operations that all finish inside one debounce collapse into one refresh] → `git stash && git merge feature && git stash pop` run together leaves the stash list as it was and git drops the popped commit, so the pop is not seen and its edits record; likewise a conflict that is stopped, resolved and committed before any read records nothing of the stop. Reading every new reflog entry handles the common sequences (a squash merge and its commit); the rest record, the safe side. A `pull` between a stash and a pop usually takes longer than the debounce.
- [`git rebase --skip` writes no entry of its own] → The skipped conflict's file reads as a resolution and records.
- [A resolution, or an agent edit, whose text equals an existing packed blob and that is committed within the same span as an operation] → Only the conflict rule above catches the common case; the rest is skipped. Rare and accepted.

## Migration Plan

New setting, on by default; no stored data changes. Rollback is turning `agentTypewriter.ignoreGitOperations` off, which restores the previous recording exactly.

## Open Questions

- The 100 ms poll, 250 ms grace and 10 s cap are starting values; tune them against the integration tests on Windows.
