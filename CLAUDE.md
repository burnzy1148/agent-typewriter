# Agent Typewriter

A VS Code extension that watches files change on disk and replays each change as human-like typing.

## Commands

- `npm test`: unit tests plus a fuzz test of the planner.
- `npm run it`: integration tests in a real headless VS Code. Needs xvfb on Linux.
- `npm run package`: builds the .vsix.

## Architecture

- `src/planner.ts`: diffs before/after text into ordered hunks to type, each offset relative to the text after earlier hunks.
- `src/timeline.ts`: ordered, bounded buffer of recorded change events with a playback cursor and seek.
- `src/recorder.ts`: watches the workspace, keeps file snapshots, and records each settled write as a before/after event.
- `src/player.ts`: consumes the timeline in order and types each change into its mirror editor.
- `src/mirrorFs.ts`: in-memory filesystem behind the `agent-typewriter:` mirror documents that replay is typed into.
- `src/filter.ts`: decides which workspace paths get recorded (extension allow-list, exclude globs, include globs).
- `src/timelineView.ts`: tree view listing recorded changes and their played/playing/pending state.
- `src/config.ts`: reads and updates the `agentTypewriter.*` settings.
- `src/extension.ts`: activation; wires recorder, timeline, player, mirror filesystem, view, and commands together.

## Rules that must not break

- The extension never writes to the user's real files. Replay only happens in `agent-typewriter:` mirror documents.
- A change's "before" text is captured when the change is recorded, never when it is played.
- Applying `planHunks` to the before text must reproduce the after text exactly. The fuzz test guards this.
- Recording and playback stay decoupled through the `Timeline`.

## Workflow

- beads holds the roadmap and OpenSpec holds feature definitions. See AGENTS.md for beads usage.
- Pick work with `bd ready --exclude-type epic`, then claim it with `bd update <id> --claim`.
- Each feature bead becomes one OpenSpec change: explore, then propose. Record the change name on the bead with `bd update <id> --spec-id openspec/changes/<name>`. Then apply, then archive, then `bd close`.
- Implementation tasks live in the change's `tasks.md`, not as beads. Anything new discovered during implementation becomes a bead with `--deps discovered-from:<id>`.
- Remove the `needs-spec` label once a change is proposed.
