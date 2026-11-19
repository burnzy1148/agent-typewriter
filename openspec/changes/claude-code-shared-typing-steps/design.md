# Design

## Context

See proposal.md, Why.

`Player.play()` (`src/player.ts`) types one change through `typeHunk`, `navigate`, `scrollTo`, `deleteText` and `typeText`. Each interleaves a decision (how many characters next, how long to wait, backspace or select, walk or click) with a VS Code call (`ready`, `edit`, `selection`, `revealRange`, `sleep`). The decisions read live state at the moment they are made: `this.settings()`, the speed (`catchUp × manualSpeed`, where catch-up follows `timeline.pendingCount()` as changes arrive), `finishNow`, the editor's caret and its `visibleRanges`. Every wait goes through `sleep`, which returns at once once finish now is pressed and is capped at 15 s.

The plugin's deck (`claude-code/hooks/replay.ts`) types with `keystroke`/`settle` on a 50 ms timer, spending a per-tick budget of characters (`credit`). A long deletion is one keystroke that ends its tick. `finish` drops `playing` and shows the after text with the caret at `finalCaret`.

The shared bundle (`scripts/build-claude-code.mjs`, `CORE_ENTRY`) is built for a neutral platform and fails on a `vscode` or Node import. `caretPath.ts`, `typingChunks.ts`, `pace.ts`, `readPause.ts` and `planner.ts` are already pure.

In flight and landing before this change (the plugin slot is serialized): at-o3z.16 adds `Playback.preview`, an 8-tick (400 ms) beat before a long deletion that draws its lines as `-` rows, and moves `view` to diff rows; at-o3z.15 passes `now` (`$.clock.now()`) into `tick` and plays the followed lane; at-o3z.18 adds a band and touches none of this. at-o3z.17 (after this change) adds a manual speed control and a catching-up chip.

## Goals / Non-Goals

**Goals:**
- One function owns every typing decision; both frontends only apply its steps.
- The VS Code player's observable behavior is unchanged: same edits, same caret moves, same waits drawn from the same distributions, same responses to pause, finish now, interrupt and settings changes.
- Decisions keep reading live state at the moment they are made, as today.
- The fuzz test checks the steps, with finish now pressed at random, reproduce the after text.

**Non-Goals:**
- Identical random sequences between the old and the new player. The distributions are the same; the order of draws may differ.
- Moving renames (`moveMirror`) into the steps. Only the VS Code extension sees renames; their read pause, file-switch delay and 500 ms beat stay in the player.
- Changing how either frontend finishes now, scrolls, decorates, or recovers a mirror the user changed.

## Decisions

### A lazy generator over a host, not a precomputed list

```ts
function* typingSteps(change: TypingChange, start: TypingStart, host: TypingHost, random: () => number): Generator<TypingStep>

interface TypingChange { before: string; after: string; kind: 'create' | 'modify' | 'delete'; languageId?: string }
interface TypingStart { switching: boolean; jump: boolean }   // another file was shown before; the first edit is jumped to (file switch, rename)
interface TypingHost {
  settings(): TypingSettings;                                // PlaybackSettings + charsPerMinute, read live
  speed(): number;                                           // catch-up × manual, read live
  finishing(): boolean;                                      // finish now pressed
  caret(): number;                                           // LF offset of the caret now
  inView(first: number, last: number): boolean | undefined;  // lines all in view; undefined when there is no viewport
}
```

The frontend pulls one step, applies it (awaiting a wait), and pulls the next. Because a generator runs only when pulled, every decision is made right after the previous step was applied: the same moment the player makes it today. A settings change, a new queued change (catch-up), finish now, a user scroll during a read pause, or a caret the user moved all take effect from the next step, as now.

Alternative: return an array with waits in base milliseconds and divide by the speed when applying. Rejected: the arrow walk and the read pause depend on the viewport and caret at the time, finish now changes which edits come next, and settings changes would need the list rebuilt mid-change.

Alternative: a callback-driven typer that calls `host.edit()`/`host.sleep()`. Rejected: async callbacks would make the plugin's synchronous tick awkward and hide the steps from the fuzz test.

### The steps

```ts
type TypingStep =
  | { kind: 'readPause' }                                    // wait until the read pause has passed since the last edit
  | { kind: 'show' }                                         // bring the change's file up, holding its before text
  | { kind: 'caret'; at: number }                            // put the caret at an LF offset (an arrow press or a click)
  | { kind: 'reveal'; at: number; scroll: boolean }          // bring the line of `at` into view; scroll: may animate (after a read pause)
  | { kind: 'mark'; from: number; to: number; oneStep: boolean } // text about to be deleted; from === to clears; oneStep: it goes in one step
  | { kind: 'select'; from: number; to: number }
  | { kind: 'delete'; from: number; to: number }             // leaves the caret at `from`
  | { kind: 'insert'; at: number; text: string }             // leaves the caret after the text
  | { kind: 'replace'; text: string }                        // the whole text at once (too large, or the rest after finish now)
  | { kind: 'added'; from: number; to: number }              // a hunk's text is all typed (or the whole text was replaced): for highlights
  | { kind: 'wait'; ms: number };                            // already divided by the speed, at most 15 000
```

The generator keeps its own copy of the text, applying its edit steps, so line lookups (`caretPath`, "at line start") need nothing from the host. The player's `expected` and the generator's text stay equal because the player applies every edit step and nothing else.

`mark` and `added` are hints for decorations; a frontend may ignore them. `reveal` with `scroll: false` is "center if outside the viewport"; with `scroll: true` it comes after a `readPause`, and the frontend checks again whether the line is in view (the user may have scrolled meanwhile), then smooth-scrolls or jumps as its own `smoothScroll` setting says. Smooth scrolling stays with the frontend.

### What the generator decides, mapped from today's player

- **Start**: with `start.switching`, `readPause` before `show`, then `wait fileSwitchDelayMs / speed` after it.
- **Whole-file delete** (`kind: 'delete'`): `select` all, `mark` all, `wait 500 / speed`, `delete` all, clear the mark.
- **`maxAnimatedChars`**: if the planned hunks insert more, `replace` with the after text and `added` over all of it.
- **Hunks** (`planHunks`, `authoringOrder` with `naturalOrder`): for each, if `host.finishing()`, bring its offset into view with a click (`reveal`, `caret`) and stop; otherwise type it. After the loop, `replace` with the after text when the text differs (only after finish now).
- **Caret start** (`caretBeforeHunk`, exported): end of a deletion of at most `BACKSPACE_MAX` (24) characters without a line break, else the hunk's offset.
- **Navigate**: walk when the hunk is not the first after a jump, `arrowNavigation` is on, not finishing, and `host.inView(caret line, target line)`. Bring the target line into view: no viewport, finishing, or the first edit after a jump → `reveal scroll:false`; already in view → nothing; otherwise `readPause` then `reveal scroll:true`, except a move that `continues` within a block typed outside in, which reveals at once. Then one `caret` + `wait humanize(1000 / arrowKeysPerSecond) / speed` per key from `caretPath(…, ARROW_MAX_KEYS)`, stopping if finishing, then the final `caret` and `reveal scroll:false`.
- **Beat before the edit**: `mark` the deletion if any, `wait humanize(220) / speed`.
- **Backspace** (short single-line deletion): steps of `backspaceStep(…, round(cps × 1.6 / TICK_HZ))`, each a `delete`, a shrinking `mark`, and `wait humanize(step × 1000 / (cps × 1.6))`, stopping if finishing; the rest goes as below.
- **Select and delete** (long, multi-line, or the rest after finish now): `select`, unless finishing `wait humanize(380) / speed` and `select` again (the text may have been put back), then `delete`; clear the mark.
- **Typing**: while text remains, finishing → `insert` the rest and stop (no `added`); at a line start, the leading indent as one `insert` with no wait; else a chunk to `typingChunkEnd(…, round(cps / TICK_HZ))`, `insert`, `reveal scroll:false` after a chunk with a line break or the first chunk, and `wait delayAfter(chunk)`: humanized per-character time, plus 2–(2 + 4·jitter) characters after a line break, up to 1.5 after `; { } ,`, and with probability 0.04·jitter after a line break a thinking pause of 300–1000 ms / speed. After the last chunk, `added` over the hunk.
- `humanize(ms) = max(0, ms × (1 + 0.8·jitter × (2·random() − 1)))`; `cps = baseCharsPerMinute(languageId, charsPerMinute, languageSpeeds) / 60 × speed`.

`BACKSPACE_MAX`, `ARROW_MAX_KEYS` and `TICK_HZ` (60) move from the player into `typingSteps.ts`. A shared `catchUpSpeed(pending, settings) = min(maxSpeedup, 1 + catchUpFactor × pending)` goes in `pace.ts`; both frontends multiply it by their manual speed.

### Finish now: the generator compresses, the frontend drains

The generator reads `host.finishing()` and makes the same compressed edits the player makes today (bring the next edit into view and replace the rest; insert the rest of a hunk at once; delete the rest of a deletion without its beat). Waits are still yielded; skipping them is the frontend's job, and the player's `sleep` already returns at once while `finishNow` is set. So the player's finish now is unchanged.

The plugin keeps its own finish: `finish()` drops the generator and shows the after text with the caret at `finalCaret`, as today. Its host's `finishing()` is always false. Finish now's compressed path is still covered for every frontend by the fuzz test, which presses it at random.

### The player becomes a step applier

`play()` keeps the rename branch, `setPlaybackPath`, `liveRelPath`/`expected` bookkeeping, `showMirror`, `store` and the final `setText` for the line ending. Between them it runs:

```ts
for (const step of typingSteps(change, { switching, jump }, host, Math.random)) {
  if (!(editor = await this.ready(relPath, editor, epoch))) return;   // pause, reopen, put text back
  await this.apply(step, …);   // caret → selection; reveal → revealRange or scrollTo's animation; edits → this.edit; wait → this.sleep; readPause → this.readPause; mark → previewDelete; added → flashRange unless highlightAdditions
  if (!this.live(epoch)) return;
}
```

`readPause` and `show` steps are applied before `ready()` (the mirror may not be shown yet), as today. The host reads `this.settings()`, `this.speedMultiplier(s)`, `this.finishNow`, the editor's caret (as an LF offset) and `inView` over `visibleRanges` (undefined when there are none). `scrollTo` keeps only its animation and the "already in view after the pause" check. `typeHunk`, `navigate`'s decisions, `deleteText`, `typeText`, `delayAfter`, `humanize` and `cps` go.

### The plugin applies steps against tick time

`Playback` loses `hunk`, `deleted`, `typed` and `credit`, and gains `steps` (the generator), `owed` (ms left of the current wait), and `selection`. It keeps `hunks` for `finalCaret`. `tick(deck, opts, now)`:

- adds `TICK_MS` to a budget carried from the last tick;
- pulls and applies steps: an edit changes `text` and `caret`; `caret` moves the caret; `select`, `mark` and `added` set or clear what the view may draw; `reveal` does nothing (the pane's frame already follows the caret); `show` sets `shown` to the change's before text, keeping the caret when the path is unchanged; a `wait` spends the budget or leaves `owed` and ends the tick; `readPause` ends the tick while `readPauseLeft(lastEditAt, now, readPauseSeconds, speed) > 0`;
- stops after `MAX_STEPS_PER_TICK` steps, and draws once.

Waits are measured in tick time, so a paused deck (which does not tick) holds a wait where it is and resumes the rest. The read pause is measured in wall time from the `now` at-o3z.15 passes in, so time paused or idle counts, as the extension's does. `lastEditAt` is set by every edit and by `finish()`, and cleared by `seek`, `replayFromStart`, `skipToLatest` and `restore`, so no read pause follows a jump (spec: No read pause after a jump in playback). `start.switching` is true when a change was played since the last reload and its path (`fileKey`) differs; `start.jump` is the same, matching the player, where the first edit after a file switch is clicked.

The plugin's host: `settings()` from `playOptions`; `speed()` = `catchUpSpeed(pendingCount of the lane played, settings) × manual` (manual is 1 until at-o3z.17); `finishing()` false; `caret()` the playback caret; `inView` against the window `frame()` would draw for the shown text, caret and `deck.codeRows`, which `register.tsx` sets each time it draws the code view (undefined before the pane has drawn, so no arrow walks and no off-screen read pause until then). Random numbers come from `deck.random`, `Math.random` unless a test sets a seeded one.

`shownBefore` (a change cued while paused, and after a reload) puts the caret at `caretBeforeHunk` of the first hunk, so the cued caret is where typing starts. `HOLD_TICKS` after a change shown at once stays, as the spec's "about a second later" requires.

### The deletion beat after at-o3z.16

at-o3z.16's `preview` ticks give way to the steps: the pane draws a deletion's lines as `-` rows while a `mark` with `oneStep` is up. That covers the beat when the caret arrives (about 220 ms) and the beat while the text is selected (about 380 ms), both varied and divided by the speed. A backspaced deletion (`oneStep: false`) still draws no rows, as at-o3z.16 has it. This changes .16's "Lines are shown red before a deletion removes them" from a fixed 400 ms that ignores speed to about 600 ms divided by speed, matching how long the extension previews a deletion. Task 1.1 adds that MODIFIED block once .16 has archived.

### Plugin settings

`playOptions` resolves `resolvePlaybackSettings(recordGetter(options))` and `resolveReadPauseSeconds([options])`, and keeps its own `charsPerMinute` check (a value that is not a positive number is 1000, where `resolveCharsPerMinute` would clamp it to 1). `userConfig` keeps its two options, so the rest take `PLAYBACK_NUMBERS`' defaults; declaring more is a later change. The plugin passes no `languageId`, so `languageSpeeds` never applies.

### Bundle

`CORE_ENTRY` adds `typingSteps`, `caretBeforeHunk`, `BACKSPACE_MAX`, the step and host types from `./src/typingSteps`, `catchUpSpeed` and `baseCharsPerMinute` from `./src/pace`, and `readPauseLeft` from `./src/readPause`. `caretPath.ts` comes in through `typingSteps.ts`. The header comment lists the new source files.

## Risks / Trade-offs

- [A subtle reordering changes VS Code behavior] → The player has no unit test of its own; the integration suite (`it/`, `npm run it`) and the unit tests of what it uses (`scroll`, `caretPath`, `typingChunks`, `readPause`, `pace`) run unchanged; new `typingSteps` unit tests pin each mapping above against a scripted host with a seeded random. Any integration test that needs editing is a behavior change and is a review finding.
- [`ready()` puts the text back between steps while the generator holds its own copy] → It puts it back to `expected`, which equals the generator's text by construction. The step applier asserts this in tests.
- [The pane's frame re-centres on the caret, so an arrow walk scrolls the view one line per press] → Acceptable for now; at-o3z.19's smooth view can hold the frame still while the caret stays within it.
- [After at-o3z.16, `view` holds diff rows, so `-` rows take room the window check does not count] → `inView` counts the rows the pane drew, `-` rows included, through `codeRows`; at worst an edit near the edge is judged off-screen and gets a read pause.
- [A plugin test that counted exact ticks now depends on random delays] → The deck takes a seeded random; tests assert totals within the jitter bounds or with jitter 0 through a test-only settings override.
- [Throttled plugin timers stretch waits] → As today. The read pause, measured in wall time, does not stretch.

## Migration Plan

No stored shape changes: `saved`, `view` and `listing` keep their tags, since `Playback` is module memory. The extension ships the refactor with no setting or behavior change. Rollback is reverting the PR; the bundle is rebuilt from the reverted sources.

## Open Questions

- Whether the 220 ms arrival beat reads well in the pane without a selection or mark to show. Tuning it is a constant in one place and changes no requirement other than its number.
