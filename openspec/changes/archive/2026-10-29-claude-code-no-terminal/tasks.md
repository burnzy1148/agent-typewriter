# Tasks

## 1. Base

- [x] 1.1 Once PR #82 (at-o3z.5) is merged, rebase this branch onto `origin/claude-code-extension`. Verify `git log` shows #82's merge below this change's commit and `npm test` passes.

## 2. Surfaces in the tests

- [x] 2.1 In `claude-code/tests/world.ts`, hook `session.surfaces` to answer from a `surfaces` list on the world, `['desktop']` by default, that a test can set. Verify `npm run check:claude-code` still passes, with no test changed yet.

## 3. Terminal-only sessions

- [x] 3.1 In `claude-code/hooks/register.tsx`, add `isTerminalOnly($)`, true when `$.session.surfaces()` is non-empty and every entry is `terminal`. Make the `Edit` and `Write` hooks return `next(e)` untouched when it is true, before any `$.fs` call. Add plugin tests: in a terminal-only session an Edit and a Write record nothing (`saved` stays empty, no `text` written), read nothing (`reads` empty), open nothing (`opens` empty), and the tool result is unchanged; with an empty surface list an Edit is still recorded. Verify with `npm run check:claude-code`.
- [x] 3.2 Make `/typewriter` in a terminal-only session return the pointer text from design.md without calling `$.ui.open`. Add a plugin test that checks the answer names the VS Code extension and `opens` stays empty, and keep the existing `/typewriter` test for the desktop. Verify with `npm run check:claude-code`.

## 4. Nothing drawn on the terminal

- [x] 4.1 Make the `Pane` render hook return `next(e)` when `e.surface === 'terminal'`. In `claude-code/tests/pane.test.tsx`, drop `terminal` from `SURFACES` and move the assertions that ask the terminal (the outside-the-project name and the too-large note) to `desktop`. Add a test for a session whose surfaces are `['terminal', 'desktop']`: an Edit is recorded and typed out on the desktop, and mounting the pane on the terminal finds none of the plugin's elements. Verify with `npm run check:claude-code` and `npm run typecheck:claude-code` (the engine types must be present; see CONTRIBUTING.md).

## 5. Docs

- [x] 5.1 Update `claude-code/README.md`. In line 15, the plugin turns on for the desktop app and VS Code and stays out of terminal sessions. Drop the "Terminal session" install bullet (line 21); the shell command covers it. Line 23 says what a terminal session does (records nothing, draws nothing, `/typewriter` points to the extension). In line 77, the pane opens by itself where Claude Code docks it, as in the desktop app, and otherwise on `/typewriter`. Verify with `grep -n -i terminal claude-code/README.md` that the only terminal mentions left are the line-23 pointer and the auto-update step, which needs `/plugin` in a terminal session.
  - PR #85 had already reworded line 15 and moved the lines down by six. Line 21 still names the terminal, as one of the places that share installed plugins, which stays true.

## 6. Integration

- [x] 6.1 Run the full checks: `npm run typecheck`, `npm test`, `npm run check:claude-code`. Then load the plugin with `claude --plugin-dir claude-code` in a terminal: run `/typewriter` and have Claude edit a scratch file. Verify the answer points to the extension and no pane appears. If the desktop app is at hand, check that a local desktop session still opens and types out the pane.
  - Done with the pinned 2.1.309 CLI: `/typewriter` in a terminal session answered with the pointer. The edit run was skipped: the terminal was 120 columns, under the 144 where the pane docks unasked, so it could not show a difference; the plugin tests cover it. The desktop app check was not run.

## Workflow follow-up

- Record the change on the bead (`bd update at-o3z.22 --spec-id openspec/changes/claude-code-no-terminal`) and remove its `needs-spec` label.
- Open a PR into `claude-code-extension`, turn on Auto-fix, and wait for CI to be green.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.22 after the merge.
