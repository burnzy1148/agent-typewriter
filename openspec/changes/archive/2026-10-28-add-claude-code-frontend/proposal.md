# Proposal

## Why

Agent Typewriter only runs in VS Code, but many people now watch their agent work in Claude Code itself: in a terminal, the desktop app, or Claude Code's VS Code panel. Claude Code plugins can now hook tool calls and draw a pane beside the chat, and a prototype showed a pane typing out a session's edits works in the desktop app. This change adds Claude Code as the first frontend besides VS Code, sharing the planner and typing logic so replay looks the same in both.

## What Changes

- **A Claude Code plugin** in a new `claude-code/` folder of this repository: a plugin manifest and a function-hooks module, built on the engine's early-access plugin API.
- **Recording from tool calls.** The plugin records each `Edit` and `Write` the session makes, including those in its subagents. It captures the before text when the tool call starts and the after text once the tool succeeds. Refused or failed calls record nothing. Changes made outside the session (by hand, by other tools, by `Bash`) are not recorded.
- **A replay pane.** Recorded changes are typed out, in order, into an "Agent Typewriter" pane, which shows the file's name, a window of its text around a moving caret, and the playback status. It works on every Claude Code surface that draws panes: the terminal, the desktop app and the VS Code extension.
- **Playback controls** in the pane: play or pause, finish the current change, and skip to the latest. A `/typewriter` command opens the pane.
- **Settings** as plugin options: typing speed in characters per minute and natural authoring order, with the same defaults as the VS Code extension.
- **Shared core.** The plugin reuses `src/planner.ts` and `src/typingChunks.ts` unchanged, bundled into the plugin by a new build script. Modules the plugin uses must not depend on VS Code or Node, and a check enforces this.
- The plugin never writes files. It only reads the files the session's tools changed.

Out of scope:
- Publishing the plugin through a marketplace or the Claude plugin directory, and releasing it (at-o3z.2).
- Recording changes made outside the session, including `Bash` writes and `NotebookEdit`.
- Keeping recorded changes after the session ends, lanes, seeking, the changes list, highlights, and git replay.
- Other frontends.

## Capabilities

### New Capabilities

- `claude-code-replay`: how the Claude Code plugin records the session's file edits and replays them as typing in a pane, with its controls and settings.

### Modified Capabilities

None. The VS Code extension's behavior does not change.

## Impact

- New `claude-code/` folder: `.claude-plugin/plugin.json`, `hooks/hooks.json`, the hooks module and its playback logic, a state contract in `types/`, and plugin tests.
- New build script that bundles the shared modules and the `diff` package into the plugin. It runs as an npm script, and CI checks that the committed bundle is up to date.
- `package.json`: scripts to build, validate and test the plugin. The VS Code `.vsix` must not include `claude-code/`.
- CI: a job that type-checks, validates and tests the plugin with a pinned `@anthropic-ai/claude-code` CLI from npm.
- `CLAUDE.md` and `CONTRIBUTING.md`: the plugin's folder, its commands, and the shared-core rule.
- Depends on Claude Code's function-hooks plugin API, which is early access and may change between Claude Code releases.
