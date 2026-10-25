---
title: Getting started
description: Install Agent Typewriter and watch your first agent run replayed as typing.
---

Agent Typewriter ignores *how* a file was edited. It watches the workspace for changes on disk, records every change in order with its full before and after text, and replays each one into a side-by-side replay editor at human speed. When the agent touched three files, playback flips between those three tabs in the same order.

Your real files are never modified by the extension. Replay happens in mirror documents (`agent-typewriter:/src/foo.ts`) that get proper syntax highlighting from the file extension.

## Install

From the Visual Studio Code Marketplace: search for **Agent Typewriter** in the Extensions view, or run

```sh
code --install-extension burnzy1148.agent-typewriter
```

To install a build from a [GitHub release](https://github.com/burnzy1148/agent-typewriter/releases) or a CI artifact instead, download the `.vsix` and run `code --install-extension agent-typewriter-<version>.vsix`, or use the Extensions view, `...` menu, **Install from VSIX...**.

## Use

1. Open your project folder.
2. Run **Agent Typewriter: Start Watching** (Command Palette, the status bar item, or the **Agent Typewriter** panel in the Explorer).
3. Let Claude Code work. The replay editor opens beside your current editor and starts typing.

Set `agentTypewriter.autoStart` to `true` to start watching whenever the workspace opens.

## Next steps

- [How it works](/docs/how-it-works/): what is recorded and how it is replayed.
- [The panels](/docs/panels/): pause, seek and change speed.
- [Filters](/docs/filtering/): choose which files are recorded.
- [Replaying git history](/docs/git-history/): type out a branch or pull request that was never watched.
