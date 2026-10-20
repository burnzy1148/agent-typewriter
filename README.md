# Agent Typewriter

Watch Claude Code (or any agent, script, or teammate) write code as if a person were typing it.

Agent Typewriter ignores *how* a file was edited. It watches the workspace for changes on disk, records every change in order with its full before and after text, and replays each one into a side-by-side replay editor at human speed. When the agent touched three files, playback flips between those three tabs in the same order.

Your real files are never modified by the extension. Replay happens in mirror documents (`agent-typewriter:/src/foo.ts`) that get proper syntax highlighting from the file extension.

## Install

```
code --install-extension agent-typewriter-0.1.0.vsix
```

Or in VS Code: Extensions view, `...` menu, **Install from VSIX...**.

## Use

1. Open your project folder.
2. Run **Agent Typewriter: Start Watching** (Command Palette, the status bar item, or the **Agent Typewriter** panel in the Explorer).
3. Let Claude Code work. The replay editor opens beside your current editor and starts typing.

Set `agentTypewriter.autoStart` to `true` to start watching whenever the workspace opens.

## How it works

```
disk write ──► watcher ──► debounce ──► diff vs snapshot ──► timeline (ordered buffer)
                                                                   │
                                     replay editor ◄── player ◄────┘
```

- **Snapshots.** On start, every matching file is snapshotted. When a file changes, the new text is compared with its snapshot and the event stores both sides. The before side is fixed at record time, so a sequence like A, B, A replays correctly even when playback is minutes behind.
- **Timeline buffer.** Events are kept in order (default 500, `historyLimit`). The playback cursor moves through them independently of recording, so you can replay the whole buffer or start from any event.
- **Diff planning.** Changes are planned line by line, then refined word by word, so renaming one variable retypes only that token. Whole new lines are typed as lines. Leading indentation appears instantly the way an editor auto-indents. Short deletions are backspaced; longer ones are selected and then deleted.
- **Catch-up.** Agents write far faster than people type. Speed is `base x (1 + catchUpFactor x queued)` capped at `maxSpeedup`, so playback accelerates when it falls behind and relaxes when it catches up. Changes larger than `maxAnimatedChars` are applied instantly.
- **Mirror editors.** Each file gets one mirror tab, saved quietly after every change so closing a tab never prompts.

## The panel

**Explorer > Agent Typewriter** lists recorded changes, newest first, with their state (pending, typing, played) and line counts.

- Click an entry to see its diff.
- Inline **Replay From Here** restarts playback at that change.
- Title bar: start/stop, pause/resume, finish current change instantly, skip to latest, replay entire buffer. The `...` menu has filters, speed, and clear.

## Filtering

Three settings combine. A path must pass all of them:

| Setting | Default | Meaning |
|---|---|---|
| `agentTypewriter.extensions` | `[]` (any) | Allow-list of extensions, e.g. `["ts", "java", "md"]` |
| `agentTypewriter.include` | `["**/*"]` | Workspace-relative globs. A pattern without `/` (like `*.ts`) matches the file name anywhere |
| `agentTypewriter.exclude` | `.git`, `node_modules`, `dist`, `out`, `build`, `target`, lock files, logs | Exclude always wins |

Shortcuts:

- **Set Watched Extensions...** prompts for a list like `ts tsx java`.
- Right-click files or folders in the Explorer: **Watch Only This** replaces the include list with your selection; **Add to Watch Filter** adds to it.
- **Reset Filters** restores the defaults.

Filter changes apply immediately while watching; newly matching files are snapshotted right away.

## Settings

| Setting | Default | |
|---|---|---|
| `charsPerSecond` | 35 | Base typing speed |
| `jitter` | 0.6 | Rhythm unevenness, 0 to 1 |
| `catchUpFactor` | 0.5 | Speed added per queued change |
| `maxSpeedup` | 8 | Cap on automatic catch-up |
| `maxAnimatedChars` | 6000 | Bigger changes are applied instantly |
| `fileSwitchDelayMs` | 600 | Pause when flipping to another file |
| `debounceMs` | 200 | Writes to one file inside this window merge into one change |
| `maxFileSizeKB` | 512 | Larger files are ignored |
| `historyLimit` | 500 | Changes kept for replay |
| `ignoreOwnSaves` | true | Skip changes you saved from a VS Code editor |
| `viewColumn` | beside | Replay in a column beside you, or in the active column |

**Set Playback Speed...** also offers a session multiplier (0.5x to 5x) on top of the base speed.

### A note on `ignoreOwnSaves`

Claude Code in a terminal writes straight to disk, which is what this extension expects. If an agent instead applies edits through VS Code's own editor buffers and then saves (some IDE integrations do, especially with auto-accept), those saves look like yours and get skipped. Turn `ignoreOwnSaves` off in that case.

## Limits

- Text files only. Binary files and files over `maxFileSizeKB` are skipped. Line endings are normalized to LF in the replay.
- The replay is a reconstruction, not a recording. It shows each change as a person would plausibly type it, not the agent's literal edit sequence (which is always an atomic write anyway).
- Changes to a file that had no snapshot (only possible when more than 5000 files match) start recording from that file's second change. Narrow the filters if you see this in the **Agent Typewriter** output channel.
- A rename shows up as a delete plus a create.

## Develop

```
npm install
npm test          # planner fuzz test, timeline and filter unit tests
npm run it        # integration tests in a real headless VS Code (needs xvfb on Linux)
npm run package   # typecheck, test, bundle, produce the .vsix
```

Press F5 with this folder open to launch an Extension Development Host.
