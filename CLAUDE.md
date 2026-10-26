# Agent Typewriter

A VS Code extension that watches files change on disk and replays each change as human-like typing.

## Commands

- `npm test`: unit tests plus a fuzz test of the planner.
- `npm run it`: integration tests in a real headless VS Code. Needs xvfb on Linux.
- `npm run package`: builds the .vsix.
- `npm run dev` / `npm run build` in `site/`: the docs site (separate npm project; run `npm install` there first).

## Architecture

- `src/planner.ts`: diffs before/after text into ordered hunks to type, each offset relative to the text after earlier hunks.
- `src/timeline.ts`: ordered buffer of recorded change events, bounded by count and by text size, with a playback cursor and seek.
- `src/changeText.ts`: holds each change's before/after text, in memory until it is saved, then read back from the log through a small cache.
- `src/persistence.ts`: saves the timeline as an append-only log per lane in workspace storage (segment files plus a small state file), with recovery from torn writes and migration from the old one-file format.
- `src/recorder.ts`: watches the workspace, keeps file snapshots, and records each settled write as a before/after event.
- `src/player.ts`: consumes the timeline in order and types each change into its mirror editor.
- `src/mirrorFs.ts`: in-memory filesystem behind the `agent-typewriter:` mirror documents that replay is typed into.
- `src/filter.ts`: decides which workspace paths get recorded (extension allow-list, exclude globs, include globs).
- `src/timelineView.ts`: tree view listing recorded changes and their played/playing/pending state.
- `src/config.ts`: reads and updates the `agentTypewriter.*` settings.
- `src/extension.ts`: activation; wires recorder, timeline, player, mirror filesystem, view, and commands together.
- `site/`: the agent-typewriter.com docs site (Astro + Starlight), deployed to Firebase Hosting from `main` by `.github/workflows/site.yml`. Its settings page is generated from `package.json`.

## Rules that must not break

- The extension never writes to the user's real files. Replay only happens in `agent-typewriter:` mirror documents.
- A change's "before" text is captured when the change is recorded, never when it is played.
- Applying `planHunks` to the before text must reproduce the after text exactly. The fuzz test guards this.
- Recording and playback stay decoupled through the `Timeline`.

## Workflow

- OpenSpec holds feature definitions. Specs in `openspec/specs/` describe current behavior; archived changes in `openspec/changes/archive/` are design history.
- Each feature or behavior change is one OpenSpec change: explore, propose, apply, archive. The `/opsx:*` commands and `openspec-*` skills in `.claude/` drive each step. Fixes that do not change specified behavior need no change.
- Implementation tasks live in the change's `tasks.md`.
- Work lands through a PR to `develop`, the default branch, squash-merged. CI runs typecheck, unit tests, and integration tests on Ubuntu and Windows. Archive the OpenSpec change on the PR branch before merging, once its tasks are done and CI is green, so the updated specs land on `develop` with the code.
- `main` is the release branch. The Release workflow (`.github/workflows/release.yml`) first bumps the version through a `bump/v<version>` PR into `develop` and tags its merge `v<version>`, then promotes that tagged commit through a `release/v<version>` PR into `main`, merged with a merge commit, never squashed. The merge to `main` publishes the tag. No sync from `main` back into `develop` is needed. Never commit to `main` directly.
- Maintainers may keep personal workflow notes (issue tracker, review automation) in `CLAUDE.local.md`, which is gitignored.
