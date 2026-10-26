# Proposal

## Why

With `autoRecordWorktrees` on, every new worktree of a recorded repository gets its own lane. That includes short-lived review checkouts, such as `.claude/worktrees/review-mr-203` or a temp-dir checkout under `/var/folders/.../T/`. Files a review tool writes into them after creating them (a `git apply` of the PR diff, copied files) are recorded as changes, and auto-follow jumps to those lanes. A headless reproduction on `develop` showed both. Only the user knows which of their tools make throwaway checkouts, so they need a way to say so that doesn't depend on any one tool's naming.

## What Changes

- New setting `agentTypewriter.autoIgnoreWorktrees`: a list of glob patterns, default empty.
  - A pattern matches a worktree's path. A pattern without a slash matches the worktree's directory name, so `review-*` covers any worktree whose directory starts with `review-`.
  - A pattern starting with `branch:` matches the worktree's branch instead. A detached worktree has no branch, so it never matches a `branch:` pattern.
  - The folder's own checkout is never matched.
- **Auto-record skips matching worktrees.** A matching new worktree gets no lane, and the output channel says which pattern matched. A worktree that auto-record added stops recording once it matches, for example after the setting changes or the worktree switches to a matching branch. Its recorded changes stay.
- **Auto-follow never moves to a matching worktree's lane.** This holds even when the user recorded it by hand. The user can still follow it by hand.
- **Recording by hand is unaffected.** Choose Checkout and the Checkouts view's boxes record a matching worktree like any other.
- **A Checkouts view action** on a worktree row, "Don't Auto-Record Worktrees Like This", opens an input box prefilled with a suggested pattern. The suggestion is the row's directory name with its last numbered part replaced by `*`, for example `review-mr-*` or `tmp.*`. Accepting it adds the pattern to the workspace setting.
- The setting applies without a restart and can be set in `.agent-typewriter.json`.

Out of scope:
- Hiding auto-recorded worktrees until they record a change (at-kbn.6). That covers worktrees no pattern names.
- Any built-in default patterns.
- Regex patterns. Globs match the existing `include` and `exclude` settings and can't fail to compile.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `checkout-lanes`: auto-record and auto-follow honor ignore patterns, a new requirement defines how patterns match worktrees, and the lane settings requirement gains the new setting.

## Impact

- `src/worktrees.ts` (or a new pure module): pattern parsing and matching against a worktree's path and branch, plus suggesting a pattern from a path.
- `src/recorder.ts`: `autoRecord()` skips matching worktrees and stops auto-added lanes that come to match. The recorder remembers which lanes auto-record added this session. The common-dir watcher also watches `worktrees/*/HEAD` so branch switches are seen. The recorder exposes which lanes are ignored.
- `src/autoFollow.ts` and `src/lanes.ts`: `autoFollowTarget` skips ignored lanes.
- `src/checkoutsView.ts`, `src/extension.ts`: the new row action and command, plus wiring the setting.
- `src/config.ts`, `src/repoSettings.ts`, `schemas/`, `package.json`, `README.md`: the setting, its repo-file kind, the JSON schema and the docs.
- Tests: unit tests for matching and suggestions, recorder tests for auto-record skipping and stopping, an auto-follow test, and an integration test built from the review-worktree reproduction.
