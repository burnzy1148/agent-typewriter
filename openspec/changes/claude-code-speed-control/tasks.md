# Tasks

## 1. Rebase onto at-o3z.6

- [ ] 1.1 Rebase onto `claude-code-extension` after at-o3z.6 (`claude-code-shared-typing-steps`) has merged, and find where its manual speed factor (fixed at 1) and `catchUpSpeed` enter playback. Verify with `npm test` passing on the rebased branch.

## 2. Playback at a speed

- [ ] 2.1 In `claude-code/hooks/replay.ts`, add `SPEEDS` (0.5, 1, 2, 4), `speedOf(value)` (anything else is 1), and `catchUpLabel(factor)` (`catching up 2.5×`, `catching up 8×`). Pass the chosen speed to playback as .6's manual factor, so it multiplies typing and divides every wait. Add `paceOf(deck, speed)` returning `{ speed, catchUp, isCatchingUp }`, `catchUp` from .6's `catchUpSpeed(pendingCount())`, `isCatchingUp` true while typing, not paused, with three or more queued. Unit-test in `test/claudeCodeReplay.test.ts` every scenario of *A speed control on the transport* (rate), *The speed applies to every wait* and *A catching-up chip* (`paceOf` and the label), and that `planHunks` still reproduces the after text at 4× with catch-up. Verify with `npm test`.

## 3. The pane

- [ ] 3.1 In `claude-code/types/index.d.ts`, add the `Pace` type and the `pace` key (`Shaped<Pace>`) to `PluginState`. In `claude-code/hooks/register.tsx`, add the `pace` atom (`pace-1`, default `{ speed: 1, catchUp: 1, isCatchingUp: false }`), keep `live.speed` (read back from `pace` on load through `speedOf`), pass it to playback as the manual factor, and write `pace` in `flush` when its JSON changes. On the transport row, after Skip to latest, draw `<Select key="speed" label="Speed">` with the four options and the chosen value where the surface carries Select; `onSelect` sets `live.speed`, writes `pace` and redraws, without seeking or going through `move`. End the row with the chip text when `isCatchingUp`. Add plugin tests in `claude-code/tests/speed.test.tsx` for every scenario of *A speed control on the transport*, *The chosen speed survives a reload*, *A catching-up chip* and *A surface without a Select draws no speed control*, and that picking a speed leaves a scrolled list where it is. Verify with `npm run check:claude-code`.
- [ ] 3.2 In `claude-code/README.md`, describe the Speed control, that catch-up speeds typing up when changes queue, and the chip. Verify by reading the section.
- [ ] 3.3 In a local desktop session and a VS Code session (`claude --plugin-dir claude-code`), check the Select draws and picks, and that the chip shows with three queued. Verify by the check's notes on the PR.

## 4. Integration

- [ ] 4.1 Run `npm run typecheck`, `npm test`, `npm run it`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-speed-control --strict`. All pass.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.17 after the merge. The remote part is at-o3z.31.
