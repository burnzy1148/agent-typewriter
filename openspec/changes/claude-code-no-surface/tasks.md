# Tasks

## 1. Base

- [ ] 1.1 When the orchestrator hands over the plugin implementation slot, rebase this branch onto `origin/claude-code-extension`. Re-read `/typewriter` and the first-change open in `claude-code/hooks/register.tsx`, since earlier at-o3z beads may have moved them. Verify `npm test` and `npm run check:claude-code` pass before any change.

## 2. Test world

- [ ] 2.1 In `claude-code/tests/world.ts`, add an `openAnswer` field (default `{ isPlaced: true }`) that the `ui.open` hook returns, and a `ui.log` hook that pushes each line into a new `logs: string[]`. Verify `npm run check:claude-code` passes with no test changed.

## 3. `/typewriter`

- [ ] 3.1 In `register.tsx`, add the `NO_SURFACE` text and its shared pointer sentence from design.md, and make `/typewriter` answer from `$.ui.open`'s result: placed → "Agent Typewriter pane opened."; `reason` starting `no-surface` → `NO_SURFACE`; any other unplaced reason → the fallback naming the reason and the pointer. Add plugin tests for the no-surface answer (surfaces `[]`; answer has no "opened" and names the desktop app and VS Code; `opens` holds the pane id) and for another reason (answer holds the reason). Keep the desktop and terminal-only tests passing. Verify with `npm run check:claude-code`.

## 4. First change

- [ ] 4.1 Make the first-change open handle its answer without blocking the tool call: on `isPlaced: false` with a `no-surface` reason, `$.ui.log(NO_SURFACE)`; swallow a rejection. Add plugin tests: first Edit with surfaces `[]` and a no-surface answer records the change and logs `NO_SURFACE` once, and a second Edit logs nothing more; an unplaced width-floor answer logs nothing; a rejecting `ui.open` leaves the tool result unchanged and the change recorded. Verify with `npm run check:claude-code` and `npm run typecheck:claude-code` (engine types present; see CONTRIBUTING.md).

## 5. Docs

- [ ] 5.1 Update `claude-code/README.md`: in the cloud paragraph (line 30 today), say that in such a session `/typewriter` and the first change tell you the pane can't be shown and point to a local session; in "The pane" (line 78 today), say what `/typewriter` answers where nothing can show the pane. Verify with `grep -n -i "cloud\|/typewriter" claude-code/README.md` that every mention agrees with the new requirements.

## 6. Integration

- [ ] 6.1 Run `npm run typecheck`, `npm test`, `npm run check:claude-code`. Then load the plugin with `claude --plugin-dir claude-code -p "/typewriter"` and check the answer is the no-surface text, not "opened". If a cloud environment with the plugin on `CLAUDE_CODE_PLUGIN_DIRS` is at hand, run `/typewriter` and have Claude edit a scratch file there, and note whether the reply and the transcript notice show in claude.ai/code; otherwise record the unchecked `ui.log` question on at-o3z.24.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and run `/review-cycle` until the code lens approves.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.23 after the merge.
