# Tasks

## 1. The shared line

- [x] 1.1 In `claude-code/types/index.d.ts`, add the `Band` type `{ line; isActive; isPaused }` and the `band` key (`Shaped<Band | null>`) to `PluginState`. In `claude-code/hooks/replay.ts`, add `bandOf(deck, cwd)`: `null` before the first recorded change; else the line (`Agent Typewriter`, then `typing <name> #<n>`, `paused · <name> #<n>`, `paused · next <name> #<n>`, the too-large wording, or `up to date · <name> #<n>`, then ` · <k> queued` when any wait), `isActive` (a change typed or any waiting) and `isPaused`. Unit-test in `test/claudeCodeReplay.test.ts` every scenario of *The band and the status entry share one line*, a file outside the working directory, and `isActive` for typing, paused mid-change, cued, queued while paused, and caught up. Verify with `npm test`. *Superseded in implementation:* see design.md, *Corrected in implementation*: `bandOf(deck)` takes no `cwd`, so there is no working-directory test (the file is named by its last path segment, tested with either separator and with control characters); the line also ends with ` · <n> in other lanes` while other lanes wait; and `isActive` counts every lane.

## 2. The band

- [x] 2.1 In `claude-code/hooks/register.tsx`, add the `band` atom (`band-1`, default `null`) and write it in `flush` when its JSON changes. Add the `AbovePrompt` render hook: pass on the terminal, on `hasSurvey`, when `band` is `null` or not active, or when `$.ui.panes()` lists the pane placed; else draw the line (cut at the end) and Buttons `band:pause` (`p`, Pause/Resume), `band:skip` (`l`) and `band:open` (`o`, primary). Pause goes through `act`, Skip to latest through `move`, Open pane through `$.ui.open` with a toast of `openedText` when it is not placed. Add observe-only `ui.close`, `ui.open`, `session.attach` and `session.detach` hooks that invalidate `ui.render`. *Superseded in implementation:* no `ui.open` hook, because the plugin's own open never reaches it; each of the plugin's opens redraws through one helper instead (design.md, *Corrected in implementation*). Add plugin tests in `claude-code/tests/band.test.tsx` for every scenario of *A band above the prompt while the pane is out of view*, *The band's controls* and *Band hotkeys*, plus: no band on the terminal surface, the band after a reload with the pane closed, and Open pane left unplaced showing the toast. Verify with `npm run check:claude-code`.
- [x] 2.2 In `claude-code/README.md`, describe the band, when it shows, its controls and hotkeys, and that VS Code shows no band. Verify by reading the section.
- [x] 2.3 *Added in implementation (review round 1):* add tests that keep one drawn band across Open pane and across a surface attaching and leaving, and check that each fails with its redraw removed. Verify with `npm run check:claude-code`.

## 3. The status entry

- [x] 3.1 In `register.tsx`, keep `live.hasTerminal` from `$.session.surfaces()` in `session.start`, `session.attach` and `session.detach`. In `flush`, call `$.ui.status(line)` when the line changed since the last call and no terminal is attached, and `$.ui.status(undefined)` when one is; the attach and detach hooks set or clear it at once. Add plugin tests in `claude-code/tests/band.test.tsx` for every scenario of *A status entry carries playback state* and *The status entry stays off the terminal*, and that a terminal-only session sets no status entry. Verify with `npm run check:claude-code`.
- [x] 3.2 In a local desktop session and a VS Code session with the plugin loaded (`claude --plugin-dir claude-code`), check where the status entry shows, and that the band shows in the desktop app with the pane closed. Write in `claude-code/README.md` which surfaces show the status entry. Verify by reading the section. *Superseded in implementation:* looking at the desktop app and VS Code needs a person at both, so it moves to at-o3z.28's desktop check (see Workflow follow-up). The README says the band is desktop-only, because Claude Code raises it on the terminal and desktop alone, and that the status entry shows wherever Claude Code shows plugin status entries, never in a session that also runs in a terminal.

## 4. Integration

- [x] 4.1 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-prompt-band --strict`. All pass.

## Workflow follow-up

- Add the band (pane closed, typing and paused) and the status entry to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.18 after the merge.
