# Agent Typewriter for Claude Code

Watch the edits Claude makes in your session replayed as human-like typing, in a pane beside the conversation. Each change is typed out from the file's old text to its new text: lines are deleted and retyped in steps, a new block gets its opening and closing lines before its body, and the pane follows the caret through the file.

This is the Claude Code edition of [Agent Typewriter](https://agent-typewriter.com), the VS Code extension. It uses Claude Code's plugin API for function hooks and panes, which is in early access and may change between Claude Code releases. It needs Claude Code 2.1.309 or later.

## Install

Until the plugin is merged into `develop`, it is only on the testers' branch, and the commands below fail with "Marketplace file not found". Use `burnzy1148/agent-typewriter#claude-code-extension` wherever this section says `burnzy1148/agent-typewriter`:

```bash
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#claude-code-extension
```

From a shell:

```bash
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter
```

That adds this repository as the `agent-typewriter` marketplace and installs the plugin for your user account. The desktop app, Claude Code's VS Code extension and the terminal share the plugins and marketplaces you add, so it doesn't matter which one you install from.

Without a shell:

- **VS Code:** type `/plugins` in the Claude Code panel to open **Manage plugins**, add `burnzy1148/agent-typewriter` on the **Marketplaces** tab, then install Agent Typewriter from the **Plugins** tab.
- **Desktop app:** once the marketplace is added, Agent Typewriter is in the plugin browser: click **+** next to the prompt box and choose **Add plugins** (or **Plugins**, then **Browse plugins**).

Agent Typewriter is made for the desktop app's local sessions and Claude Code's VS Code extension. A desktop app or phone attached to another session by Remote Control doesn't show its pane. In an interactive session in a terminal, the plugin stays out of the way: it records nothing and draws nothing, and `/typewriter` points you to the [Agent Typewriter extension for VS Code](https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter), which types out the same edits from disk. A `claude -p` run or an SDK script draws nowhere, so the plugin still records its edits, but nothing shows them.

Use it in a local session. Cloud sessions (claude.ai/code, the mobile app, and the desktop app's cloud sessions) don't load plugins installed on your machine or turned on in a repository's settings. A cloud environment that loads it some other way, such as by naming its folder in `CLAUDE_CODE_PLUGIN_DIRS`, records the session's edits, but no client draws the pane for a cloud session yet.

### Which version you get

The repository's branches are the plugin's channels:

- `burnzy1148/agent-typewriter` follows `develop`, the default branch: the plugin as it is merged, ahead of releases.
- `burnzy1148/agent-typewriter#main` follows released versions only. It has the plugin from the first stable release that includes it.
- `burnzy1148/agent-typewriter#claude-code-extension` is for testers until the plugin is merged into `develop`, as above.

Any branch that has the marketplace works the same way, such as a pull request's branch you want to try.

The plugin has no version number of its own: its version is the commit you installed, as `claude plugin list` shows it. Mention it when you report a problem.

### Updating

Claude Code doesn't update plugins from this marketplace by itself. To update now, from a shell:

```bash
claude plugin marketplace update agent-typewriter
claude plugin update agent-typewriter@agent-typewriter
```

Then start a new session. Every new commit on the branch you follow counts as an update, so some updates change nothing in the plugin.

To have Claude Code update it for you, turn on auto-update for the marketplace in a terminal session: run `/plugin`, open **Marketplaces**, select `agent-typewriter` and choose **Enable auto-update**.

### Switching branches

Every branch registers as the same `agent-typewriter` marketplace, so remove it before adding another. Removing it uninstalls the plugin and forgets its options.

```bash
claude plugin marketplace remove agent-typewriter
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#main
```

## What it replays

- Every `Edit` and `Write` the session runs, including those its subagents run.
- Only changes that succeed. A refused or failed call is not replayed.
- Only this session's changes. Files changed by `Bash`, by other programs, or by you are not replayed, and nothing carries over to the next session.

The plugin never writes a file. It reads the file before the tool runs and again after.

Files larger than 1 MB are not typed: the pane names them and moves on. A change that adds more than 6,000 characters, such as a generated file, is shown finished at once instead of typed, as in the VS Code extension. Long deletions go in one step; short ones are backspaced.

## The pane

The pane opens by itself on the first change, where Claude Code can dock it beside the conversation, as in the desktop app. Anywhere else, run `/typewriter` to open it; in a terminal session it points you to the VS Code extension instead.

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

Changing an option reloads the plugin. It keeps the session's recorded changes, played and queued, and the change being typed starts over.

## Working on the plugin

To run your own checkout instead of an installed copy, from the repository root:

```bash
claude --plugin-dir claude-code
```

Then ask Claude to create or edit a file. For that session, the checkout takes the place of an installed Agent Typewriter. See [CONTRIBUTING.md](../CONTRIBUTING.md) for building, testing and type-checking the plugin.

## License

MIT, as for the rest of the repository. `hooks/core.mjs` includes the [diff](https://github.com/kpdecker/jsdiff) package (BSD-3-Clause).
