# Design

## Context

The recorder treats each workspace folder as its root. It runs one `**/*` watcher per folder and enumerates baselines with `findFiles`. Filter paths come from `asRelativePath`, ownership from `getWorkspaceFolder`, and git calls (`listCleanTracked`, `listIgnored`, `readBlob`) run in the folder's path. Mirror documents are keyed by the event's `relPath`, which comes from `displayPathOf`. None of this knows about worktrees, so nested worktrees are watched like any other subdirectory, and a checkout outside the workspace can't be watched at all.

VS Code's minimum version is 1.85. Its `createFileSystemWatcher` accepts a `RelativePattern` whose base is a `Uri` outside the workspace. `findFiles` only searches workspace folders.

## Goals / Non-Goals

**Goals:**
- One rule for every folder: record one checkout root and exclude every other listed worktree nested under it.
- Keep the per-event check synchronous for paths already known.
- Make no change for folders without git or outside a repository.

**Non-Goals:**
- Recording several checkouts of one folder at once, or auto-following the most recently written worktree.
- Making the explorer commands (Watch Only This, Add to Watch) work on files inside an excluded worktree. They keep writing globs relative to the workspace folder.
- Finding repository settings in the chosen checkout. The workspace folder's `.agent-typewriter.json` keeps applying.
- Fixing double recording when a nested worktree is also open as its own workspace folder. That already happens today and is unchanged.

## Decisions

### Ask git for worktrees
`src/worktrees.ts` runs `git worktree list --porcelain -z` in the folder and parses `worktree`, `HEAD`, `branch`, and `detached` records. It uses an injectable `GitRunner` and returns `unavailable` / `not-repo` / `ok`, matching `gitIgnore.ts`. When `-z` is not supported (git older than 2.36), it retries without `-z` and splits on newlines. Paths are compared after `realpath` and, on Windows, case-folded, so `/private/tmp` vs `/tmp` and drive-letter case don't break nesting checks.

Alternative considered: treating any directory with a `.git` file as a checkout. That also catches submodules, which are part of the repository and must still be recorded.

### A checkout root per folder
The recorder keeps a `CheckoutScope` per workspace folder:
- `root`: the directory recorded.
- `own`: whether the root is the folder's own checkout.
- `label`: the worktree name, used in display paths.
- `nested`: other listed worktrees under `root`, as relative `dir/` prefixes.

When the folder is a subdirectory of its checkout (for example `repo/packages/app`), choosing another worktree keeps the same subpath (`other/packages/app`). Filters and globs then mean the same thing in either checkout.

Everything that now uses the workspace folder uses the scope instead:
- `rootOf(uri)` returns the scope with the longest root containing the URI, replacing `getWorkspaceFolder`.
- `relPathOf` becomes relative to that root, replacing `asRelativePath`.
- Git calls run in `root`.
- `passes(uri)` adds `nested.has(rel)` to the existing filter and gitignore checks.

For the folder's own checkout, `root` is the folder, so behavior matches today except for the nested exclusion.

### Watching and enumerating a chosen worktree
When `own` is true, the recorder keeps today's folder watcher and `findFiles`. Nested worktree prefixes are added to the `findFiles` exclude glob, so their files are never statted or snapshotted.

For another checkout, it watches `new RelativePattern(Uri.file(root), '**/*')`. Because `findFiles` can't search outside the workspace, it enumerates baseline candidates with a directory walk from `root` using `workspace.fs.readDirectory`. The walk prunes a directory when the exclude globs, gitignore snapshot, or nested-worktree prefixes rule out everything under it. A `dir/` probe against `PathFilter` checks the exclude globs. The rest of baseline capture, budget, and git baselines is unchanged.

Alternative considered: `git ls-files -co` for enumeration. It drops ignored files that the filters would otherwise record (ignored files are recorded unless `respectGitignore` is on), and it lists every file under an unexcluded `node_modules`.

### Display paths carry the worktree label
`displayPathOf` prefixes `label/` when `own` is false, after the existing multi-root folder prefix. This keeps mirror URIs, the timeline view, and persisted sessions distinct per checkout with no change to the player or mirror filesystem. The label is the worktree directory's basename. If two listed worktrees share a basename, the label adds the parent directory name (`parent-name`).

### Detecting worktrees added or removed
`git worktree add` writes `<path>/.git` (a file), then checks files out, and agents usually write right after. The folder watcher already sees those events. When the watcher reports a `.git` created below the root (not the folder's own), and it is a file whose `gitdir:` line points into a repository's `worktrees/` (as a linked worktree's does, unlike a clone's `.git` directory or a submodule's pointer into `modules/`), the recorder does two things:
1. Adds its directory to `nested` right away, so the checkout's file creates are dropped synchronously instead of being recorded as a burst of creates.
2. Schedules a debounced `refreshWorktrees()`, which re-lists worktrees, rebuilds `nested` (dropping the provisional prefix if git says it's a submodule or unrelated repository), drops baselines under new prefixes, and baselines anything newly un-excluded.

Removal is seen when the `.git` file is deleted. Watchers don't reliably report a removed root or its `.git` file (the integration run on macOS saw neither), so any delete under a chosen root also schedules a debounced check of whether the checkout's `.git` still exists. If it's gone, the same refresh runs. Deletes recorded while that checkout is gone are skipped, so removing a worktree doesn't replay its files as deleted. If the chosen worktree is gone, the scope falls back to the folder's own checkout with one log line.

Alternative considered: watching `<git-common-dir>/worktrees/`. It needs another watcher on a path the default excludes hide, and it fires after the checkout writes that need to be suppressed.

### Persisting the choice
`checkouts.json` in the extension's workspace storage maps each folder URI to the chosen worktree's absolute path. The folder's own checkout has no entry. A path is stored instead of a branch because branches move between worktrees and detached worktrees have none. `start()` resolves the stored path against the fresh worktree list and falls back if it's missing.

Alternative considered: `workspaceState`. It is flushed lazily, and the integration harness showed it never reached disk before the window closed, so a choice could be lost on a quick reload. The saved timeline uses a file in the same folder for the same reason. Without a folder there is no workspace storage, so choices last for the session only.

### Choosing and switching
`agentTypewriter.chooseCheckout` lists the folder's own checkout first, then other worktrees as `branch` (or `HEAD` short sha) with the path as detail. In multi-root workspaces it first asks for a folder among those in a repository. Choosing writes `checkouts.json`. If recording is on, it calls `recorder.setCheckout(folder, path)`, which follows the same path as `refreshFilter`:
- bump `baselineGen`
- drain held changes
- replace the folder's watcher
- clear that folder's baselines and ignore snapshot
- recapture

The timeline is untouched.

A second status bar item (`$(git-branch) <label>`) runs the command. It shows only when the folder's repository has more than one worktree. The timeline view description adds the label when a non-own checkout is recorded.

## Risks / Trade-offs

- [Recursive watching outside the workspace is heavier and honors `files.watcherExclude` differently] → Used only for a chosen non-own checkout. The integration test covers a sibling worktree on Ubuntu and Windows.
- [The directory walk is slower than `findFiles` on big trees] → It prunes excluded directories and runs only at start, switch, and refresh.
- [A `git worktree add` whose `.git` file event arrives after some checkout writes] → Those writes are still debounced (`debounceMs`). The provisional prefix is applied in `schedule`, so any burst not yet flushed is dropped in `flush` by re-checking `passes`. A write that already flushed is recorded as a create, the same race the gitignore change accepted.
- [Behavior change for users who watched nested worktrees from the main checkout] → README and changelog explain choosing the worktree instead.
- [`realpath` on every root and listed worktree] → Done once per list refresh, not per event.

## Migration Plan

No setting migration. On upgrade, nested worktrees stop being recorded until chosen. Rolling back is reverting the release; `checkouts.json` is then ignored.

## Open Questions

- Whether a later change should add an "all checkouts" option. It would need the worktree label on every event, which this design already provides.
