# Agent Typewriter for Claude Code

Watch the edits Claude makes in your session replayed as human-like typing, in a pane beside the conversation. Each change is typed out from the file's old text to its new text: lines are deleted and retyped in steps, a new block gets its opening and closing lines before its body, and the pane follows the caret through the file.

This is the Claude Code edition of [Agent Typewriter](https://agent-typewriter.com), the VS Code extension. It uses Claude Code's plugin API for function hooks and panes, which is in early access and may change between Claude Code releases. It needs Claude Code 2.1.309 or later.

## What it replays

- Every `Edit` and `Write` the session runs, including those its subagents run.
- Only changes that succeed. A refused or failed call is not replayed.
- Only this session's changes. Files changed by `Bash`, by other programs, or by you are not replayed, and nothing carries over to the next session.

The plugin never writes a file. It reads the file before the tool runs and again after.

Files larger than 1 MB are not typed. The pane names them and moves on.

## The pane

The pane opens by itself on the first change, where Claude Code can dock it beside the conversation: in the desktop app, or in a wide terminal. Anywhere else, run `/typewriter` to open it.

It shows the file being typed (by its path in your project), the lines around the caret with line numbers and syntax highlighting, and whether playback is typing, paused or idle with how many changes are queued. Its buttons:

- **Pause** / **Resume**: stop typing where it is, and carry on from there.
- **Finish current**: show the current change done and start the next one.
- **Skip to latest**: finish every queued change and show the last one.

## Options

Set them in `/config`:

| Option | Default | |
| --- | --- | --- |
| Typing speed (`charsPerMinute`) | 1000 | Characters per minute. |
| Natural authoring order (`naturalOrder`) | on | Type a new block's opening and closing lines before its body. Off types top to bottom. |

## Trying it from a checkout

From the repository root:

```bash
claude --plugin-dir claude-code
```

Then ask Claude to create or edit a file. See [CONTRIBUTING.md](../CONTRIBUTING.md) for building, testing and type-checking the plugin.

## License

MIT, as for the rest of the repository. `hooks/core.mjs` includes the [diff](https://github.com/kpdecker/jsdiff) package (BSD-3-Clause).
