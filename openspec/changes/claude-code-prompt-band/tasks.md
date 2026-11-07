# Tasks

## 1. The shared line

- [ ] 1.1 In `claude-code/types/index.d.ts`, add the `Band` type `{ line; isActive; isPaused }` and the `band` key (`Shaped<Band | null>`) to `PluginState`. In `claude-code/hooks/replay.ts`, add `bandOf(deck, cwd)`: `null` before the first recorded change; else the line (`Agent Typewriter`, then `typing <name> #<n>`, `paused · <name> #<n>`, `paused · next <name> #<n>`, the too-large wording, or `up to date · <name> #<n>`, then ` · <k> queued` when any wait), `isActive` (a change typed or any waiting) and `isPaused`. Unit-test in `test/claudeCodeReplay.test.ts` every scenario of *The band and the status entry share one line*, a file outside the working directory, and `isActive` for typing, paused mid-change, cued, queued while paused, and caught up. Verify with `npm test`.

## 2. The band

- [ ] 2.1 In `claude-code/hooks/register.tsx`, add the `band` atom (`band-1`, default `null`) and write it in `flush` when its JSON changes. Add the `AbovePrompt` render hook: pass on the terminal, on `hasSurvey`, when `band` is `null` or not active, or when `$.ui.panes()` lists the pane placed; else draw the line (cut at the end) and Buttons `band:pause` (`p`, Pause/Resume), `band:skip` (`l`) and `band:open` (`o`, primary). Pause goes through `act`, Skip to latest through `move`, Open pane through `$.ui.open` with a toast of `openedText` when it is not placed. Add observe-only `ui.close`, `ui.open`, `session.attach` and `session.detach` hooks that invalidate `ui.render`. Add plugin tests in `claude-code/tests/band.test.tsx` for every scenario of *A band above the prompt while the pane is out of view*, *The band's controls* and *Band hotkeys*, plus: no band on the terminal surface, the band after a reload with the pane closed, and Open pane left unplaced showing the toast. Verify with `npm run check:claude-code`.
- [ ] 2.2 In `claude-code/README.md`, describe the band, when it shows, its controls and hotkeys, and that VS Code shows no band. Verify by reading the section.

## 3. The status entry

- [ ] 3.1 In `register.tsx`, keep `live.hasTerminal` from `$.session.surfaces()` in `session.start`, `session.attach` and `session.detach`. In `flush`, call `$.ui.status(line)` when the line changed since the last call and no terminal is attached, and `$.ui.status(undefined)` when one is; the attach and detach hooks set or clear it at once. Add plugin tests in `claude-code/tests/band.test.tsx` for every scenario of *A status entry carries playback state* and *The status entry stays off the terminal*, and that a terminal-only session sets no status entry. Verify with `npm run check:claude-code`.
- [ ] 3.2 In a local desktop session and a VS Code session with the plugin loaded (`claude --plugin-dir claude-code`), check where the status entry shows, and that the band shows in the desktop app with the pane closed. Write in `claude-code/README.md` which surfaces show the status entry. Verify by reading the section.

## 4. Integration

- [ ] 4.1 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-prompt-band --strict`. All pass.

## Workflow follow-up

- Add the band (pane closed, typing and paused) and the status entry to at-o3z.28's desktop check.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.18 after the merge.
