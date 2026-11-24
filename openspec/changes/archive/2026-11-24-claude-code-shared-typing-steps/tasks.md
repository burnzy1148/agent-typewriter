# Tasks

## 1. Rebase onto the in-flight plugin changes

- [x] 1.1 Rebase onto `claude-code-extension` once at-o3z.16, .15 and .18 have merged. Add a MODIFIED block to `specs/claude-code-replay/spec.md` for at-o3z.16's archived *Lines are shown red before a deletion removes them*: the lines show as removed while the deletion is marked (the beat when the caret arrives and the beat it is held, together about 600 ms divided by the playback speed; see design.md, Corrected in implementation: no selection state in the plugin), Pause holds it, Finish current or a seek skips it, and a backspaced deletion gets none. Copy the requirement whole and keep its other scenarios. Verify with `openspec validate claude-code-shared-typing-steps --strict`.

## 2. The shared generator

- [x] 2.1 Add `catchUpSpeed(pending, settings)` to `src/pace.ts` with unit tests in `test/pace.test.ts` (no queue, a few, the cap, `catchUpFactor` 0). Verify with `npm test`.
- [x] 2.2 Add `src/typingSteps.ts`: `typingSteps(change, start, host, random)`, the `TypingStep`, `TypingHost`, `TypingChange`, `TypingStart` and `TypingSettings` types, `caretBeforeHunk`, and `BACKSPACE_MAX`, `ARROW_MAX_KEYS`, `TICK_HZ`, with every decision in design.md's mapping. It imports only the planner, `typingChunks`, `caretPath` and `pace`. Verify with `npm run typecheck`.
- [x] 2.3 Add `test/typingSteps.test.ts` with a scripted host and a seeded random: caret start for a short, a long and a multi-line deletion; backspace steps and their shrinking marks; select, beat, reselect, delete; indent inserted at once with no wait; chunk size from `cps / TICK_HZ`; line-break, punctuation and thinking pauses within their bounds and divided by the speed; jitter 0 gives exact waits; `maxAnimatedChars` replaces at once with `added`; a whole-file delete; read pause and file-switch wait only with `switching`; `readPause` before an off-screen reveal but not for an in-view one, a `continues` move, no viewport, or the first edit after a jump; arrow walk only when both lines are in view and within 24 keys; finish now before a hunk, mid-backspace, mid-select beat and mid-typing; a speed or settings change taking effect from the next step. Verify with `npm test`.
- [x] 2.4 In `test/planner.test.ts`, run both fuzz loops' changes through `typingSteps` with a host whose `finishing()` turns true at a random step, `inView` answers at random, and `naturalOrder` on and off; apply the edit steps to the before text and assert the result equals the after text, and that no step's offset is out of range or splits a surrogate pair. Verify with `npm test`.

## 3. The player applies the steps

- [x] 3.1 In `src/player.ts`, replace `typeHunk`, `deleteText`, `typeText`, `delayAfter`, `humanize`, `cps` and `navigate`'s decisions with one step-applying loop and a host over the player's state, as design.md describes. Keep `moveMirror`, `scrollTo`'s animation, `ready`, `edit`, `sleep`, decorations and the final `setText`. Use `catchUpSpeed` in `speedMultiplier`. Verify with `npm run typecheck`, `npm test` and `npm run it`, with no integration test edited.

## 4. The plugin applies the steps

- [x] 4.1 Add `typingSteps`, `caretBeforeHunk`, `BACKSPACE_MAX`, the step and host types, `catchUpSpeed`, `baseCharsPerMinute` and `readPauseLeft` to `CORE_ENTRY` in `scripts/build-claude-code.mjs`, update its header, and run `npm run build:claude-code`. Commit `core.mjs` and `core.d.mts`. Verify with `npm run typecheck:claude-code`.
- [x] 4.2 In `claude-code/hooks/replay.ts`, make `playOptions` resolve the shared settings and read pause (keeping its own `charsPerMinute` check), drop the copied constants, give `Playback` the generator, `owed` and `isAtOnce` (see design.md, Corrected in implementation: no selection state in the plugin), give `Deck` `lastEditAt`, `lastPath`, `drawn` and `random`, and rewrite `tick(deck, opts, now)` to apply steps against tick time. `finish` sets `lastEditAt`; `seek`, `replayFromStart`, `skipToLatest` and `restore` clear it. `shownBefore` uses `caretBeforeHunk`. Replace at-o3z.16's `preview` ticks with drawing `-` rows while a `oneStep` mark is up. Verify with `npm run typecheck:claude-code`.
- [x] 4.3 In `claude-code/hooks/register.tsx`, set `deck.drawn` to the lines `frame()` reports whenever the code view draws playback's file (see design.md, Corrected in implementation: what is in view in the plugin). Verify with `npm run typecheck:claude-code`.
- [x] 4.4 Update `test/claudeCodeReplay.test.ts` to a seeded random, and add tests for every scenario of the delta's requirements: the pace, the beat before each edit, the caret moves, the read pause (off-screen edit, file switch, late change, after Finish current, none after a pick), the file-switch delay, catch-up, the long-deletion beat held by Pause, and the typing speed. Keep the existing scenarios passing. Verify with `npm test`.
- [x] 4.5 In `claude-code/README.md`, say the pane types at the extension's pace, with its defaults for everything but `charsPerMinute` and `naturalOrder`. Verify by reading the section.

## 5. Integration

- [ ] 5.1 Run `npm run typecheck`, `npm test`, `npm run it`, `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-shared-typing-steps --strict`. All pass.
- [ ] 5.2 In a local desktop session with the plugin loaded (`claude --plugin-dir claude-code`), watch a multi-file turn type: jittered rhythm, indents at once, the read pause before a file switch and an off-screen edit, arrow walks, the deletion beat, and catch-up with a backlog. Note anything that reads wrong as a bead `--deps discovered-from:at-o3z.6`.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.6 after the merge.
