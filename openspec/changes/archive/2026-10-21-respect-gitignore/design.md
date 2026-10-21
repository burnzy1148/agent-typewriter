# Design

## Context

`PathFilter` (`src/filter.ts`) is a pure, synchronous glob check used by the recorder in `captureBaseline`, `schedule` (each watcher event), `matches`, and `refreshFilter`. The recorder already runs read-only git through `runGit` in `src/gitBaseline.ts` for baselines. Paths are folder-relative (`relPathOf`), and git run with the folder as its working directory reports folder-relative paths too.

## Goals / Non-Goals

**Goals:**
- Match git's own notion of ignored, including nested `.gitignore`, `.git/info/exclude`, global excludes, and "tracked files are never ignored".
- Keep the per-event check synchronous for paths already known, and cheap for new ones.

**Non-Goals:**
- Parsing `.gitignore` ourselves.
- Watching `.git/info/exclude` or the global excludes file for changes. They are re-read on the next start or filter change.
- Hiding ignored files from the timeline view of already-recorded changes. Only future recording is affected.

## Decisions

### Ask git instead of parsing `.gitignore`
A matcher library (for example `ignore`) would be synchronous for every path, but it needs a new dependency and re-implementing git's layering: nested files, `info/exclude`, `core.excludesFile`, negation across levels, and the tracked-file exception. Git already does all of that, and the extension already depends on it optionally.

### Snapshot at capture, `check-ignore` for unknown paths
- At start and at every filter refresh, per folder, run `git ls-files --others --ignored --exclude-standard --directory -z`. It lists ignored untracked files, and collapses wholly ignored directories to one `dir/` entry, so `node_modules/` costs one line, not thousands. A path is ignored if it is in that list or under a listed directory. Baseline capture skips those paths, and the watcher handler drops their events synchronously.
- A file that is not in the snapshot and has no baseline (new since the snapshot, or skipped by the budget) gets one `git check-ignore -q -- <path>` before it is recorded or baselined. Exit 0 means ignored, and the path is added to the snapshot so later events stay synchronous; exit 1 means not ignored. Files that have a baseline were already checked.

Alternative considered: `check-ignore --stdin` for every baseline candidate. It needs the full candidate list piped through git on each refresh and does not collapse directories.

### `.gitignore` edits trigger a refresh
The recorder's existing `**/*` watcher sees `.gitignore` writes. When the setting is on, a `.gitignore` event schedules `refreshFilter()` after a short debounce, independent of whether `.gitignore` itself passes the filters. `refreshFilter` re-snapshots ignored paths, drops baselines that are now ignored, and captures baselines for paths that are no longer ignored, the same as for a glob change.

### Where the check lives
`src/gitIgnore.ts` holds the pure `IgnoredPaths` (`has(relPath)`), the parser, and `listIgnored` / `checkIgnored` with an injectable `GitRunner`, matching `gitBaseline.ts`. The recorder combines `PathFilter.matches` and `IgnoredPaths.has` in one private `passes(uri)`, used everywhere `filter.matches(relPathOf(uri))` is used today. `PathFilter` stays pure and git-free.

### No git, no effect
`listIgnored` returns `unavailable` (git cannot run) or `not-repo`, like `listCleanTracked`. Either way that folder gets an empty `IgnoredPaths` and one log line per recording session, and `checkIgnored` is not called for it.

### Default off
The bead asks for an option, and turning it on changes what existing users see recorded. The README suggests turning it on with an empty or shorter `exclude`.

## Risks / Trade-offs

- [`ls-files --others --ignored` walks untracked directories, which is slow in huge repos] → It runs only at start and on filter refresh, not per event, and only when the setting is on.
- [A new file's first event waits for one git process] → Only for files with no baseline and no snapshot entry; the result is cached.
- [Changes to `.git/info/exclude` or the global excludes file are not seen until the next refresh] → Documented in the README.
- [A refresh runs while a change is being read] → The same as glob filter changes today: that one change may be recorded or skipped under the old rules.
