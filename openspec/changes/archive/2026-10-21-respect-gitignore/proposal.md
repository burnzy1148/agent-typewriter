# Proposal

## Why

The default `exclude` list guesses at generated and dependency folders (`dist`, `out`, `build`, `node_modules`, logs). A repository's `.gitignore` already says exactly which files are not source, and agents regularly touch ignored files (build output, caches, `.env`), which then clutter the replay. Users want to opt into "watch what git would track" without hand-copying `.gitignore` into globs (bead at-kbn.3).

## What Changes

- New setting `agentTypewriter.respectGitignore` (default `false`). When on, paths git ignores in the watched folder are not recorded, on top of the existing extension, exclude, and include filters.
- "Ignored" means what git reports: `.gitignore` files at any level, `.git/info/exclude`, and the user's global excludes file. Files git tracks are never treated as ignored, even when they match an ignore pattern, the same as in git.
- Files created later are checked too, so a new `debug.log` matching `*.log` is skipped.
- Editing a `.gitignore` while watching re-applies the rule without a restart; turning the setting on or off while watching applies immediately, like other filter changes.
- Git is only read. Without git, or in a folder outside a git repository, the setting has no effect and the output channel says so once.
- The setting can be set in the repository settings file like any other.

## Capabilities

### New Capabilities
- `path-filtering`: which workspace paths are recorded. This change adds the gitignore requirements; filters that already exist are not restated.

### Modified Capabilities
None.

## Impact

- New `src/gitIgnore.ts`: read-only `git ls-files --others --ignored --exclude-standard --directory` and `git check-ignore`, with pure parsing and matching, unit-tested with an injected runner.
- `src/recorder.ts`: an ignored-path check alongside `PathFilter` in baseline capture, the watcher handler, `matches`, and `refreshFilter`; `.gitignore` changes trigger a refresh.
- `src/config.ts`, `package.json`, `schemas/agent-typewriter.schema.json`, `src/repoSettings.ts`: the new setting.
- `src/extension.ts`: `respectGitignore` changes call `refreshFilter`.
- README: Filtering section.
- Integration section in the git-repository test workspace.
