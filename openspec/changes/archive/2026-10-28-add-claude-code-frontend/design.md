# Design

## Context

Claude Code (2.1.309 and later) loads plugins that carry a function-hooks module: a TypeScript file exporting `register(on, options)`, run in an environment with no DOM and no Node. Everything outside the module goes through the engine interface `$` (`$.fs`, `$.clock`, `$.state`, `$.ui`). The API is early access. The pieces this change uses:

- `on('tool.call', { tool }, hook)` wraps a tool call. The hook runs before the tool, calls `next(e)` to run it, and sees the result.
- A pane is opened with `$.ui.open({ id, title })` and drawn by a `ui.render` hook on `{ component: 'Pane', requestId: id }`, using elements from `$.ui.resolve(e)`: `Box`, `Text`, `Button`, `Code` (highlighted source with optional line numbers).
- `$.state` holds named, versioned values for the session. They survive a module reload, and a write redraws the drawings that read them.
- `$.clock.every(ms, fn)` runs a timer until the module reloads.
- `userConfig` in `plugin.json` declares options. They show in `/config`, and a change reloads the module with the new `options`.
- `claude plugin validate <dir>` checks the manifest and module statically. `claude plugin test <dir>` runs `*.test.ts(x)` files against the engine with mocked `fs`, clock and UI.

A prototype mod built in this session used this API to record `Edit` and `Write` and type changes into a pane, reusing `planHunks`, `authoringOrder`, `typingChunkEnd` and `backspaceStep`. It worked in the desktop app. This design keeps its structure.

## Goals / Non-Goals

**Goals:**
- One source of truth for diffing and typing: the plugin calls the same modules as the VS Code extension, unchanged.
- The plugin installs from a git checkout with no build step at install time.
- Plugin checks run in CI next to the extension's.

**Non-Goals:**
- A general frontend abstraction or a separate npm package for the core. One more frontend does not justify either yet.
- Recording from the disk watcher, or sharing `recorder.ts`, `player.ts` or `timeline.ts` with the plugin.

## Decisions

### The plugin lives in `claude-code/` in this repository

```
claude-code/
  .claude-plugin/plugin.json     name "agent-typewriter", userConfig
  hooks/hooks.json               { "modules": ["./register.tsx"] }
  hooks/register.tsx             hooks: session.start, command.run, tool.call, ui.render
  hooks/replay.ts                pure playback stepping (deck, tick, finish, skip, window)
  hooks/core.mjs                 generated bundle of the shared modules (committed)
  hooks/core.d.mts               hand-written types for core.mjs
  types/index.d.ts               $.state contract
  tests/*.test.tsx               claude plugin test
```

The monorepo keeps one history, one PR flow and one place where shared modules change. A separate repository would need the core to be published or vendored. The publishing change (at-o3z.2) adds `.claude-plugin/marketplace.json` at the repository root, pointing at `./claude-code`.

### Shared modules are bundled into a committed `core.mjs`

`scripts/build-claude-code.mjs` runs esbuild on an entry that re-exports `planHunks`, `authoringOrder`, `typingChunkEnd` and `backspaceStep`, with `--platform=neutral --format=esm`. It bundles the `diff` package. The output is committed, because a marketplace install copies the plugin folder from git and runs nothing.

The engine statically checks how `$` and `on` are spelled in the hooks module. So only the code that never touches `$` is bundled, and the hooks module and `replay.ts` stay as source the engine reads directly.

- Alternatives considered: bundle the whole plugin into one file, but esbuild output can break the engine's static checks of `$` use. Or import `../../src/planner.ts` directly, but a plugin may only import files inside its own folder, and the `diff` package is in `node_modules`.
- CI runs the build and fails if `git diff --exit-code claude-code/hooks/core.mjs` shows a difference.

### The shared-core boundary is enforced by the bundle

`--platform=neutral` fails on an import of `vscode` or a Node built-in that a shared module pulls in, so the build doubles as the boundary check. `CLAUDE.md` names the shared modules and the rule. Adding a module to the entry is how a module joins the shared core.

### Recording wraps the tool call

For `Edit` and `Write`, the hook stats and reads the file (`''` when missing), runs `next(e)`, and does so again if the result has neither `deny` nor `isError`. A file over 1,000,000 bytes (by `$.fs.stat`) is never read; its change is queued without text and shown as too large. It enqueues `{ id: tool_use_id, path, before, after }` unless the two texts are equal. Each hook has a `.catch` that calls `next(e)`, so a failure in the plugin never blocks the tool. Subagent calls go through the same `tool.call` event (with `agentId`), so they are recorded without extra work.

- A `PostToolUse` command hook was the alternative. It runs after the tool, so it cannot read the before text, and it cannot draw a pane.
- Recording what the `Edit` input says (old and new string) was not chosen: `replace_all` and line endings make the file read the reliable source.

### Playback is a pure reducer driven by a timer

`replay.ts` holds the deck: `{ queue, playing?, shown?, isPaused, hold, recorded }`. `tick(deck, options)` advances by one tick's worth of keystrokes, and `finish` and `skipToLatest` jump ahead. Being pure, it is unit tested without the engine. A `$.clock.every(50)` timer calls it.

Characters per tick follow from `charsPerMinute`: `cpm / 60 * 0.05`. A tick types chunks until that budget is spent, so a chunk that stops at a newline does not cap the speed. Fractional remainders carry over between ticks so low speeds are exact. As in the extension's player, a deletion of at most 24 characters within one line is backspaced in steps, and a longer or multi-line one goes in one step; and a change that inserts more than 6,000 characters (the extension's `maxAnimatedChars` default) is shown finished at once, for about a second, instead of typed. Before and after texts are normalized to LF when recorded, as the extension's recorder does, so `authoringOrder` finds blocks in CRLF files.

- Alternative: animate inside a `Client` surface module with its own timers. That gives smoother frames on desktop, but a client module is per surface and harder to test. It stays open for later if redraw cost shows up.

### The deck lives in module memory; `$.state` holds what must outlive it

A first version kept the whole deck in one `$.state` value. Each queued change carries its file twice, and the engine refuses a value over 4,194,304 characters. So a few dozen edits to a mid-sized file made writes fail: changes were dropped silently, and a large change could stall playback for good. It also wrote the whole deck on every tick, and the timer, recording and button presses could interleave read-modify-write cycles.

Now the deck is a module variable. Hooks, the timer and button handlers run in one module environment, one at a time, so they mutate it directly with no version checks. `$.state` keeps three things:

- `text` (a family, member `<change id>:before` or `:after`): each waiting change's texts, written once when it is recorded and cleared when it finishes or is dropped. Each is at most 1,000,000 bytes, far under the per-value limit.
- `saved` (`Shaped<Saved>`): the waiting changes' ids and paths in order, with the change being typed first, and the count recorded. It is small and written only when a change is recorded, starts, finishes or is dropped.
- `view` (`Shaped<View>`): what the pane draws, cut to at most 120 lines around the caret and 400 columns around its column, with control characters replaced. It is written on ticks that change it.

On load (`session.start` runs again after every reload, including the one a changed option causes), the plugin rebuilds the deck from `saved` and `text`. The change that was being typed starts over. The total text waiting is capped at 20,000,000 characters as well as at 200 changes, so the memory and state a session holds stay bounded.

- Alternative: keep the deck in `$.state` but split its texts into a family. Every tick would still write the typed text, up to a megabyte, and the read-modify-write races remain.

### The pane draws a window around the caret

The `ui.render` hook reads only `view`. It keeps the rows that fit `props.scroll.bodyRows`, splices `▍` in at the caret while typing, and draws `Code` with `path` (for highlighting), `startLine` (for numbering) and `wrap="truncate-end"`. When the caret is past the pane's width, the lines are shifted left so it stays in view. The engine refuses a `Code` source holding control characters other than tab and newline, so `view` shows them as Unicode control pictures (U+2400 to U+241F, and U+2421 for DEL). The caret arithmetic uses the raw text. A view is at most 120 × 400 characters, under the engine's 100,000-character limit for a drawing.

The plugin asks to open the pane on the session's first recorded change, and never again by itself. An unasked `$.ui.open` is placed by the engine only where a pane docks without taking over (the desktop app, or a terminal from about 144 columns); elsewhere it waits undrawn until `/typewriter` asks for it. The engine owns that rule, so the plugin does not read the viewport. The prototype opened the pane at session start, before anything was recorded.

### Options

`plugin.json` `userConfig`: `charsPerMinute` (number, default 1000) and `naturalOrder` (boolean, default true), read from `options` in `register`. A changed option reloads the module, and the deck survives in `$.state`, so a new speed applies from the next tick.

### Tests and CI

- Unit tests of `replay.ts`, including that every change finishes on its after text, run in the existing `npm test` (node test runner).
- Plugin tests (`claude-code/tests/*.test.tsx`) run with `claude plugin test`. They mock `fs.read`, the clock and the tool, and mount the pane on `terminal`, `desktop` and `vscode`.
- A CI job on Ubuntu runs the build freshness check, then `claude plugin validate` and `claude plugin test` through `npx` with a pinned `@anthropic-ai/claude-code`. Neither needs a login.
- Type-checking the plugin (`tsc -p claude-code`) needs the engine's types, which Claude Code lays in `claude-code/.claude-plugin/types/` only when a session loads the plugin from its folder. No CLI command lays them, and the npm package does not ship them, so the type check is a local step, not a CI one. `replay.ts` is still type-checked in CI through the root `npm run typecheck`, since the unit test imports it.

## Risks / Trade-offs

- [The function-hooks API is early access and can change between Claude Code releases] → Pin the CLI version in CI, and bump it on purpose. Keep `$` use in `register.tsx` small so a change touches one file.
- [Redrawing the pane 20 times a second sends a new tree each tick] → Only the view window is written, only when it changed, and the engine folds redraws to at most 10 a second on remote surfaces. If it proves heavy, lower the tick rate or move animation into a client module.
- [`/clear` starts a new conversation without a `session.start`; whether `$.state` resets then is not documented] → Not handled. If the queue carries over, it only finishes playing what was recorded.
- [`claude plugin validate` and `test` might need a signed-in CLI in CI] → Both ran locally without a network login prompt. If CI needs credentials, run them in a step that is skipped without a secret, and keep the build, `tsc` and unit tests unconditional.
- [Concurrent edits to one file by parallel subagents could interleave before/after reads] → Accepted for now: each change is still internally consistent (before → after of one read pair).
- [`core.mjs` is a committed build artifact] → The CI freshness check catches a stale bundle. The file has a generated-file header.

## Open Questions

- Whether a merge that changes only `claude-code/` should skip the extension's checks and its `pre-v` tag (`scripts/ci-paths.mjs` treats it as an extension change today). Versioning and release are at-o3z.2's to settle. Until then the extra checks and tag are harmless, since tagging publishes nothing.

## Migration Plan

No migration. The VS Code extension does not change. The plugin is new and installs only by hand (`claude --plugin-dir claude-code`) until at-o3z.2 publishes it.
