# Proposal

## Why

`src/player.ts` decides how each change is typed in the same code that sets VS Code selections, reveals ranges, applies edits and sleeps. `claude-code/hooks/replay.ts` re-implements part of those decisions and copies their constants (`BACKSPACE_MAX`, `MAX_ANIMATED_CHARS`, the caret rule, the default speed). It has no jitter, no indents put in at once, no punctuation or thinking pauses, no catch-up and no read pause, so the pane types like a metronome and the two frontends drift further apart with every change to either. One pure source of typing steps that both frontends apply keeps them typing alike, and lets one fuzz test guard every frontend.

## What Changes

- **A shared typing-steps generator.** A new pure module, `src/typingSteps.ts`, turns one change into the steps a person would make: show the file, wait out the read pause, put the caret somewhere, bring a line into view, select, delete, insert, replace the whole text, wait. It makes every typing decision the player makes today: where the caret starts and the 24-character backspace rule; backspacing or selecting and deleting; putting a new line's indent in at once; characters per tick; delays with jitter; pauses after line breaks and punctuation and the occasional thinking pause; the `maxAnimatedChars` cutoff; whole-file deletes; when the read pause applies; the file-switch delay; walking the caret with arrow keys or clicking; and dividing every wait by the speed, catch-up included. It reads the live speed, settings, caret, viewport and finish-now state through a small host interface, and takes its random numbers as a parameter. It joins the `core.mjs` bundle.
- **The player applies the steps.** `Player` keeps everything that is VS Code's: opening and reopening mirrors, putting a reverted mirror back, renames, applying edits, smooth scrolling against visible ranges, the deletion preview and added-text flash decorations, pausing, interrupting, and finishing now. The VS Code extension's behavior does not change; its unit and integration tests guard that.
- **The plugin applies the steps on its timer.** The pane gains the extension's pacing with the extension's default settings: jittered delays, indents at once, pauses after line breaks and punctuation, occasional thinking pauses, a beat when the caret reaches an edit, a beat with the text selected before a long deletion, arrow-key caret walks to nearby edits, the read pause before the view leaves what was just typed, the file-switch delay, and catch-up speed while changes wait. *Superseded in implementation: the pane draws no selection; a long deletion is held for the beat with its lines drawn removed (design.md, Corrected in implementation).*
- **One fuzz test for every frontend.** The planner fuzz test also runs each random change through the steps, with finish-now pressed at random points, and checks that the steps reproduce the after text exactly.
- The plugin's copies of `BACKSPACE_MAX`, `MAX_ANIMATED_CHARS`, `DEFAULT_CHARS_PER_MINUTE` and its caret rule go; it reads them from the shared modules.

Out of scope, and kept possible:
- New plugin options. The plugin keeps `charsPerMinute` and `naturalOrder`; the other pacing settings take the extension's defaults (`PLAYBACK_NUMBERS`, `DEFAULT_READ_PAUSE_SECONDS`). Exposing more is a later change.
- A manual speed control and the catching-up chip in the pane (at-o3z.17). The steps already read a speed multiplier, so at-o3z.17 only has to set its manual part.
- Smooth scrolling and easing in the pane (at-o3z.19). The pane still jumps; the read pause comes before the jump.
- Moving the shared modules into a `src/core/` folder. The neutral-platform bundle already refuses a shared module that imports `vscode` or a Node built-in.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: typing follows the VS Code extension's pace (jitter, indents, punctuation and thinking pauses, a beat before each edit); long deletions are selected for a beat before they go; the caret walks to nearby edits; the read pause, the file-switch delay and catch-up speed apply; the typing speed requirement accounts for catch-up. After at-o3z.16 archives, its deletion beat takes the shared selection beat's length. *Superseded in implementation: the pane draws no selection; a long deletion is held for the beat with its lines drawn removed (design.md, Corrected in implementation).*

The VS Code extension's capabilities (`typing-pace`, `edit-navigation`, `change-highlighting`, `authoring-order`) do not change.

## Impact

- `src/typingSteps.ts` (new): `typingSteps()`, the `TypingStep` and `TypingHost` types, `caretBeforeHunk()`, and the constants it owns (`BACKSPACE_MAX`, `ARROW_MAX_KEYS`, `TICK_HZ`, the beats).
- `src/player.ts`: `typeHunk`, `navigate`, `deleteText`, `typeText`, `delayAfter`, `humanize` and `cps` give way to one loop that applies steps; `scrollTo`'s animation, `ready`, `edit`, `sleep`, `moveMirror` and the decorations stay.
- `scripts/build-claude-code.mjs`: `typingSteps`, `caretBeforeHunk`, `readPauseLeft`, `baseCharsPerMinute` and the constants join `CORE_ENTRY`; `claude-code/hooks/core.mjs` and `core.d.mts` are rebuilt.
- `claude-code/hooks/replay.ts`: `Playback` holds a step generator, the time owed to the current wait, and the selection *(superseded in implementation: no selection; see design.md, Corrected in implementation)*; `keystroke`, `settle`, the credit model and `isLongDeletion` go; `tick` applies steps against the time since the last tick; `playOptions` resolves the shared settings.
- `claude-code/hooks/register.tsx`: tells the deck how many code rows the pane drew, so the steps know what is in view.
- `test/typingSteps.test.ts` (new), `test/planner.test.ts` (fuzz over the steps), `test/claudeCodeReplay.test.ts` (pace, read pause, catch-up, seeded randomness), and the existing player and integration tests unchanged.
- `claude-code/README.md`: the pane types at the extension's pace.
