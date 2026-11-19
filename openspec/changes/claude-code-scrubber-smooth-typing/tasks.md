# Tasks

## 1. Groundwork

- [ ] 1.1 Rebase onto `claude-code-extension` with at-o3z.15, .6 and .17 merged. Spike surface module imports: a throwaway `claude-code/hooks/probe.tsx` that imports `./surface.ts`, drawn by a `<Client>`, through `claude plugin validate claude-code` and a `claude plugin test` mount on `desktop`. Record the outcome in design.md (*Imports in a surface module are checked first*) and delete the probe. If imports are refused, extend `scripts/build-claude-code.mjs` to bundle each surface module into a committed `.mjs` that CI checks for staleness, and note it in CLAUDE.md's Shared core section. Verify with `npm run build:claude-code` and `npm run check:claude-code`.
- [ ] 1.2 Add `scrollSteps`, `centeredTop` and `SCROLL_FRAME_MS` from `./src/scroll` to `CORE_ENTRY`, and update the bundle header. Run `npm run build:claude-code` and commit `core.mjs` and `core.d.mts`. Verify with `npm test` (the bundle freshness check).
- [ ] 1.3 Create `claude-code/hooks/surface.ts` (no engine or Node imports): `layoutScrubber`, `hitTest`, `revealPlan`, `frameAt`, `holdTop`. Make `replay.ts`'s `frame()` call `frameAt` with the re-centred top. Unit-test every rule in design.md's *The scrubber is one row of cells*, *Smooth typing spreads a tick's insertion over frames* and *The code window holds still, then eases* in `test/claudeCodeSurface.test.ts`. Verify with `npm test`.

## 2. Hooks module

- [ ] 2.1 In `replay.ts`, keep `seq` and `typed` on each view write (`typed` only when the tick's edits were inserts contiguous at the caret). Add `neighbour(deck, by)` for Previous, Next, Left and Right, with first-change and last-change behaviour as specified. Make at-o3z.6's `inView` prefer the window posted by the code module. In `claude-code/types/index.d.ts`, add the `View` fields and take the next `view` tag. Unit-test in `test/claudeCodeReplay.test.ts`: `typed` for plain typing, for a deletion, for a mixed tick and for a change shown at once; `neighbour` at both ends and across lanes; `inView` with a posted window. Verify with `npm test`.
- [ ] 2.2 In `register.tsx`, on the desktop, draw `<Client key="code" module="./codeView.tsx">` in place of `<Code>`, and `<Client key="scrubber" module="./scrubber.tsx" height={1}>` under the transport. Elsewhere, and for any module in `live.faulted`, draw the timer-driven code and Previous (`prev`) and Next (`next`) after Skip to latest. Add the `ui.message` hook on the pane, which validates `seek`, `step`, `key` and `window` posts and routes them through `move` or `act`, and the `ui.fault` hook, which records the module and invalidates. Verify with `npm run typecheck:claude-code`.

## 3. Surface modules

- [ ] 3.1 Write `claude-code/hooks/scrubber.tsx`: render from `layoutScrubber`; pointer drag, clamp, cancel band, click, hover readout; keys Left, Right, `r`, `p`, `f`, `l` posted. Add `claude-code/tests/scrubber.test.tsx` covering every scenario of *A scrubber under the transport on the desktop*, *The scrubber shows each change's state*, *A gap between turns on the scrubber*, *The scrubber fits the pane*, *Dragging the scrubber names a change without moving playback*, *Releasing the scrubber plays from the change* and *Keys on the scrubber and the code*. Verify with `npm run check:claude-code`.
- [ ] 3.2 Write `claude-code/hooks/codeView.tsx`: draw `frameAt` at its own top; reveal `typed` on a 16 ms `every` that stops when idle; hold, then ease with `scrollSteps`; post `window` once settled and on resize; forward `r`, `p`, `f`, `l`. Add `claude-code/tests/smooth.test.tsx` covering every scenario of *Typing shows character by character on the desktop*, *The code window holds still on the desktop* and *The code window scrolls smoothly on the desktop*, plus a skipped `seq` snapping and no render-loop unmount over a long reveal. Verify with `npm run check:claude-code`.
- [ ] 3.3 In `claude-code/tests/`, mount the same pane on `vscode` and assert no `Client`, plus every scenario of *Previous and Next where there is no scrubber*. Fake `ui.fault` for each module on `desktop` and cover *The desktop falls back when a surface module fails*, including a reload trying again. Verify with `npm run check:claude-code`.

## 4. Docs and checks

- [ ] 4.1 In `claude-code/README.md`, describe the scrubber (drag, release, cancel, keys), smooth typing and scrolling on the desktop, and Previous and Next elsewhere. Verify by reading the section.
- [ ] 4.2 In a local desktop session with `claude --plugin-dir claude-code`, check the scrubber drag and release, a cancel, a reveal at 4×, a scroll to a distant edit, and whether the frame clock throttles in a background window. Answer design.md's open question. Add the scrubber and smooth typing to at-o3z.28's desktop check.
- [ ] 4.3 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code`, `npm run check:claude-code` and `openspec validate claude-code-scrubber-smooth-typing --strict`. All pass.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green.
- Do not merge; the maintainer merges. Close at-o3z.19 after the merge.
