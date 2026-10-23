# Design

## Context

The recorder turns settled writes into `NewChangeEvent`s with before and after text captured at record time, and the player types whatever the timeline holds. Load Session from File (at-dqb.2) already replaces the buffer with events from elsewhere through `Timeline.restore`, starting paused. `src/gitBaseline.ts` has the read-only git plumbing: `runGit` (concurrency limit, `--no-optional-locks`, a clean git environment) and `readBlob` (`cat-file --filters` with the folder's prefix). A git replay is one more producer of events: it reads history instead of watching the disk, and hands the events to the timeline the way a loaded session does.

## Goals / Non-Goals

**Goals:**
- Before and after text come from git objects only; the working tree, index, HEAD and refs are never touched.
- The producer is VS Code-free and testable against real temporary repositories, like `gitBaseline.ts`.
- Recording and playback stay decoupled: the replay only fills the timeline.

**Non-Goals:**
- GitHub pull request lookup by number. It needs network access and a token, and the PR's commits are often not local, so it would need a fetch, which writes objects and refs. A fetched or checked-out PR branch is covered by the branch pick or a typed range. Follow-up bead.
- Showing each change's commit in the panel. `ChangeEvent` has no field for it, and adding one bumps the session format, which the rename lane (at-kbn.2) is doing now. Commit subjects go to the output channel for now. Follow-up bead.
- Rename detection. Renames replay as a delete and a create (`--no-renames`). Once at-kbn.2 adds a rename kind, git renames can map onto it.
- A separate timeline or session for replays. The replay uses the one buffer, as loaded sessions do.

## Decisions

### 1. `src/gitReplay.ts`

- `resolveRange(input)`: splits on whitespace, refuses an empty input and any token starting with `-` (it would be read as an option), and turns a single plain revision (no `..`, `^`, `@{`) into `<rev>^!`, git's "this commit only".
- `listCommits(folder, revs, run)`: `git rev-list --reverse --topo-order --no-merges --format=%H %ct %s <revs> --`. The trailing `--` makes git read every token as a revision. `rev-list` prints a `commit <sha>` header line before each formatted line, so lines are read in pairs. Commit time becomes the change's `time`.
- `commitChanges(folder, sha, run)`: `git diff-tree -r -z --raw --no-renames --no-commit-id --root --relative <sha>` in the folder. `--relative` keeps only paths under the folder and makes them folder-relative, so a workspace folder that is a subdirectory of its repository works like the recorder's relative paths. A side counts only when its mode is a regular file (`100644`, `100755`): absent or non-regular before → create, absent or non-regular after → delete, neither regular → skipped.
- `buildReplay(folder, revs, options, run)`: for each commit and each changed path that passes `options.filter`, reads both blobs with `readBlob` (filters applied, as on checkout), skips blobs over `options.maxBytes` or binary, decodes with `options.decode` (default `decodeBytes`), normalizes line endings and records the eol like the recorder does, and counts lines with `countChanges`. Blobs are cached by sha and path for the run, since a file's after blob is the next change's before blob. Reports `skipped` counts (filtered, binary, too large, unreadable) and the commits read. Takes an optional `isCancelled` checked between commits.
- `defaultBase(folder, run)`: `symbolic-ref -q refs/remotes/origin/HEAD`, else the first of `origin/main`, `origin/master`, `main`, `master` that `rev-parse --verify -q <ref>^{commit}` resolves.
- `listBranches(folder, run)`: `for-each-ref --format=%(refname:short) refs/heads refs/remotes`, without `*/HEAD`.
- Errors from git become a `GitReplayError` with git's `fatal:` line, so the user sees "bad revision 'x'" rather than a command line.

*Alternative considered:* `cat-file --batch` for blobs. One process instead of one per blob, but the batch form only applies filters with a path per line on newer git, and the per-blob form is already proven in `readBlob`. The cache and the eight-process limit keep it fast enough for pull-request-sized ranges.

### 2. Merge commits

`--no-merges` skips them, as `git log -p` shows no diff for a merge. A merge of `main` into a PR branch would otherwise replay everyone else's work. The next commit's before text is its parent (the merge), so a file can jump between changes; the player already snaps a mirror to a change's before text before typing.

### 3. Recording while replaying

The replay stops watching. A live edit appended after replayed history would start from the disk text, not from the history's last after text, so the mirror would jump, and history and live edits would be indistinguishable in the panel. The confirmation says watching will stop; Start Watching resumes recording afterwards and appends to the buffer as usual. The alternative of pausing the recorder and resuming after playback adds state for a case (watching an agent while reviewing a PR in the same window) that is better served by stopping.

### 4. Command in `src/extension.ts`

`agentTypewriter.replayGit(arg?: { range: string; folder?: string })`:
1. Folder: the only folder, else `showWorkspaceFolderPick`. With `arg.folder` (a folder URI string or name), that folder.
2. Range: with `arg.range`, that range. Otherwise a quick pick of: "This branch" (`<base>..HEAD`, shown when HEAD has commits not on the base), "A branch..." (pick a local or remote-tracking branch, range `<base>..<branch>`), "Last commit" (`HEAD^!`), and "Enter a range...".
3. Build with a cancellable progress notification. Filters come from the folder's `PathFilter` settings (include, exclude, extensions); `maxFileSizeKB` applies; `files.encoding` for the file decides decoding.
4. Nothing to replay → information message. Otherwise, interactively, a modal: "Replay N change(s) from M commit(s)? This replaces the K recorded change(s) and stops watching." (parts shown only when they apply).
5. The history limit choice from Load Session, factored into a shared helper.
6. Stop watching, pause, `timeline.restore`, `player.interrupt()`, `player.forgetPlaybackMirror()`, log each commit's short sha and subject, and a status bar message with counts.

The `arg` form skips the pickers and the confirmation, and keeps the newest changes within `historyLimit` with a warning, like loading a session from a URI.

### 5. Events

`uri` is the folder URI joined with the path, `relPath` the folder-relative path (the mirror's path, as for recorded changes), `time` the commit time in milliseconds. Events get seqs 1..n for `Timeline.restore`, which renumbers them.

## Risks / Trade-offs

- [Long ranges spawn many git processes] → Blob cache, the shared concurrency limit, a cancellable progress notification, and the commit count in the confirmation.
- [`cat-file --filters` runs the repository's configured smudge filters, such as Git LFS] → Same as git baselines today; it is what a checkout would show. The filters run on blobs only and do not touch the working tree.
- [A typed range is passed to git] → Tokens starting with `-` are refused and `--` ends the revisions, so input cannot become an option or a path.
- [Commit times are not monotonic after a rebase] → `time` is informational; order comes from `--topo-order --reverse`.
