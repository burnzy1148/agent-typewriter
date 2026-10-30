# Design

## Context

`claude-code/hooks/register.tsx` records every `Edit` and `Write` call. It opens the pane unasked on the first recorded change, opens it on `/typewriter`, and draws the same tree on whatever surface asks. Before the tool runs it reads the file (up to 1 MB), and again after. Each change's texts go to `$.state`, up to 20,000,000 characters a session.

What the engine (2.1.309 types, checked on 2.1.312 by spike at-o3z.10) says about surfaces:

- `$.session.surfaces()` lists every surface the session draws on: `terminal` first under the REPL, then remote ones as they attach. It is empty in a `-p` run, under the SDK before a client attaches, and in cloud sessions. In the desktop app and in Claude Code's VS Code extension it holds `desktop` or `vscode`.
- Surfaces attach and detach during a session (`session.attach`), so the list can change after `session.start`.
- A `ui.render` hook gets `e.surface` for each render. `$.ui.open` has no per-surface option: an open pane is placed by every surface that places panes, and a terminal places one unasked from 144 columns.
- Remote Control viewers of a terminal session (claude.ai, the mobile app) draw nothing. In practice, then, a REPL session's surfaces are `['terminal']` and nothing else.

## Goals / Non-Goals

**Goals:**
- A terminal-only session costs nothing: no file reads, no stored text, no pane.
- The behaviour in the desktop app and VS Code does not change.
- Whether a session is terminal-only is decided when it matters, so a surface attaching later is honoured.

**Non-Goals:**
- Telling the person anything when no surface draws at all (at-o3z.23).
- Stopping the playback timer in terminal-only sessions. With nothing recorded it has nothing to do.

## Decisions

### Terminal-only means a non-empty surface list holding only `terminal`

`isTerminalOnly` is true when `$.session.surfaces()` is non-empty and every entry is `terminal`. It is asked on each `Edit` and `Write` call before anything is read, and again when `/typewriter` runs.

Alternatives:
- **`session.start`'s `e.surface`**: rejected. It is fixed when the session starts and misses surfaces that attach later. It also names only the first surface.
- **The docs' "in the app" test, `surfaces().some(s => s !== 'terminal')`**: rejected. It is false for an empty list too, so cloud and `-p` sessions would stop recording. What to do where nothing draws is at-o3z.23's and at-o3z.24's decision, and the spike found recording works there. Keeping the empty case as it is leaves that open.

### Terminal-only sessions do not record

When the check is true, the `Edit` and `Write` hooks call `next(e)` and return its result untouched, before any `$.fs` call. Recording never affects the tool call either way.

Alternative: record anyway, in case a surface that draws attaches later. Rejected. Remote Control viewers do not draw, so no such surface exists today. Recording would cost two reads per edit and up to 20M characters of `$.state` in every terminal session of everyone who installed the plugin. If a drawing surface ever attaches, recording starts from that edit; earlier edits in the session are not replayed. The spec says so through "Session edits are recorded".

### The pane's render passes through on the terminal

The `Pane` render hook returns `next(e)` when `e.surface === 'terminal'`, so the plugin draws nothing there. Under the current check this happens only in a session that also draws elsewhere, since terminal-only sessions never open the pane.

Alternative: draw a one-line pointer to the extension inside the terminal pane. Rejected, because the decision is that the plugin draws nothing in the terminal. `/typewriter` already carries the pointer.

### `/typewriter` answers with a pointer

In a terminal-only session the command returns `{ text }` without calling `$.ui.open`. The text: "Agent Typewriter for Claude Code doesn't replay in the terminal. To watch Claude's edits typed out, use the Agent Typewriter extension for VS Code (https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter), or run Claude Code in the desktop app."

### Tests answer `$.session.surfaces()`

`claude-code/tests/world.ts` hooks `session.surfaces` and answers from a list the test sets, `['desktop']` by default to match `start()`'s default surface. The pane tests stop asking the terminal surface for a drawing. New tests cover:
- a terminal-only Edit: nothing recorded, nothing read, no open;
- `/typewriter` in a terminal-only session;
- a session drawing on both the terminal and the desktop: recorded, drawn on the desktop, the terminal render passing through;
- an empty list: still recorded.

## Risks / Trade-offs

- **A mixed session may show an empty pane frame in a wide terminal.** `$.ui.open` cannot leave out a surface, and the frame is the engine's to draw. → No session mixes the terminal with a drawing surface today (spike at-o3z.10). If one ever does, revisit with whatever per-surface placement the engine offers then.
- **`surfaces()` may be empty in the desktop app or VS Code before their client attaches.** → An empty list keeps recording, so an early edit is never lost.
- **People who use the pane in a wide terminal lose it.** → The README and `/typewriter` point them to the VS Code extension. The plugin is in early access on the `claude-code-extension` branch, so few people are affected.

## Migration Plan

None. The change ships with the plugin's next commit on the branch. Rolling back means reverting the commit.

The change edits `register.tsx`, which PR #82 (at-o3z.5) also changes, so it is implemented on `claude-code-extension` after #82 merges.
