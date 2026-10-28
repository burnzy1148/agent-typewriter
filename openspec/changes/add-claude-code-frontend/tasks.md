# Tasks

## 1. Shared core bundle

- [x] 1.1 Add `scripts/build-claude-code.mjs`: esbuild bundles an entry re-exporting `planHunks`, `authoringOrder` (from `src/planner.ts`), `typingChunkEnd` and `backspaceStep` (from `src/typingChunks.ts`) with `--platform=neutral --format=esm --target=es2022`, the `diff` package included, to `claude-code/hooks/core.mjs` with a generated-file header. Add `npm run build:claude-code`. Verify the script exits non-zero when a test entry imports `vscode` or `node:fs`, and that `core.mjs` has no `require(`.
- [x] 1.2 Write `claude-code/hooks/core.d.mts` for the four exports and the `Hunk` type. Verify with `tsc` in 2.4.
- [x] 1.3 Add a "Shared core" note to `CLAUDE.md` (Architecture): which modules the plugin bundles, that they must not import `vscode` or Node, and that `npm run build:claude-code` must be rerun and committed after changing them. Verify by reading the rendered file.

## 2. Plugin skeleton and playback logic

- [x] 2.1 Create `claude-code/.claude-plugin/plugin.json` (`name: agent-typewriter`, description, `types`, `userConfig` with `charsPerMinute` number default 1000 and `naturalOrder` boolean default true), `claude-code/hooks/hooks.json`, and `claude-code/types/index.d.ts` declaring the `deck` state under `PluginState['agent-typewriter']`. Verify with `claude plugin validate claude-code` (no errors).
- [x] 2.2 Implement `claude-code/hooks/replay.ts`: the deck (`queue`, `playing`, `shown`, `isPaused`), `enqueue` (drops unchanged changes and the oldest past 200 waiting), `tick(deck, { charsPerMinute, naturalOrder })` with fractional carry-over, `finish`, `skipToLatest`, the too-large skip (files over 1,000,000 bytes), and `windowAround(text, caret, rows, isTyping)`. Verify with `test/claudeCodeReplay.test.ts` in `npm test`: every change finishes on its after text (including a random before/after fuzz like the planner's), pause stops progress, `finish` and `skipToLatest` match their scenarios, 201 recorded leaves 200 waiting, an oversized change is skipped with a note, and natural order on/off changes typing order but not the result.
- [x] 2.3 Make `npm test`'s esbuild step resolve `claude-code/hooks/core.mjs` imports in that test (or import the shared modules from `src/` through an alias), so the test runs the same code the plugin ships. Verify `npm test` passes.
- [x] 2.4 Add `claude-code/tsconfig.json` (the engine's recommended options, including `claude-code/.claude-plugin/types` once laid) and an `npm run typecheck:claude-code` that type-checks the plugin against the engine types a session lays when it loads the plugin (no CLI command lays them, so this is a local check). Verify it passes after loading the plugin once.

## 3. Recording

- [x] 3.1 In `claude-code/hooks/register.tsx`, add `tool.call` hooks for `Edit` and `Write`. Each reads before (empty when missing), runs `next(e)`, skips on `deny` or `isError`, reads after, and enqueues `{ id: tool_use_id, path, before, after }`, with `.catch(($, e, next) => next(e))`. Verify with `claude-code/tests/recording.test.tsx` under `claude plugin test claude-code`: Edit and Write recorded, a subagent call (`agentId`) recorded, a denied call and an errored call not recorded, an unchanged file not recorded, a failing `fs.read` after the tool leaves the tool's result unchanged, and `Bash` not recorded.
- [x] 3.2 Confirm the plugin never writes: `claude plugin validate` lists no `$.fs.write` call. Note the result in the PR.

## 4. Pane, controls and options

- [x] 4.1 In `session.start`, register `/typewriter` and start the 50 ms `$.clock.every` timer that writes the deck through `update($, deck, tick)` only when `tick` moves it. Read `charsPerMinute` and `naturalOrder` from `options`, treating invalid speeds as 1000. Verify in `claude-code/tests/pane.test.tsx`: with the mocked clock, a recorded change is fully typed after the expected time at 1000 and at 3000 characters per minute.
- [x] 4.2 Draw the pane: file path relative to the session's `cwd` (absolute outside it), status (typing, paused or idle) and queued count, the empty-state text, the too-large note, and `Code` with `path`, `startLine` and the caret mark in a window sized from `props.scroll.bodyRows`. Verify in `pane.test.tsx` on `terminal`, `desktop` and `vscode`: mid-typing caret, final text equals after text, relative and absolute path naming, queued count, and line numbers for an edit deep in a long file.
- [x] 4.3 Add Pause/Resume, Finish current and Skip to latest buttons. Verify in `pane.test.tsx` by pressing each and checking the Playback controls scenarios.
- [x] 4.4 Ask to open the pane (unasked) on the first recorded change only, leaving placement to the engine, and always from `/typewriter`. Verify in `pane.test.tsx` that `ui.open` is called on the first change and not on later ones, and that the command opens it.
- [x] 4.5 Verify state across reloads: a test seeding `deck` with the `deck-2` shape continues it, and one seeding an untagged value starts fresh.

## 5. CI and docs

- [ ] 5.1 Add a `claude-code` job to `ci.yml` on Ubuntu: `npm ci`, run `npm run build:claude-code` and fail on `git diff --exit-code claude-code/hooks/core.mjs`, then `npm run check:claude-code` (`claude plugin validate` and `claude plugin test` from a pinned `@anthropic-ai/claude-code` through `npx`, which need no login). Verify the job passes on the PR.
- [x] 5.2 Confirm `npm run package` still produces a `.vsix` without `claude-code/` (`.vscodeignore` is an allow-list). Verify with `unzip -l` on the built `.vsix`.
- [x] 5.3 Add `claude-code/README.md`: what the plugin does, that it replays only the session's own `Edit` and `Write` calls, its options, and how to try it from a checkout (`claude --plugin-dir claude-code`). Add the plugin's commands to `CLAUDE.md` (Commands) and a short section to `CONTRIBUTING.md`.
- [x] 5.4 Manually check the plugin in the Claude Code desktop app and a terminal: run a session with `--plugin-dir claude-code`, have Claude create and edit a file, and confirm the pane types both changes, the controls work, and changing `charsPerMinute` in `/config` takes effect. Note the Claude Code version in the PR.

## Workflow follow-up

- Archive this change on the PR branch once CI is green, then close at-o3z.1 after the merge.
- at-o3z.2 publishes the plugin (marketplace file, release, plugin directory submission).
