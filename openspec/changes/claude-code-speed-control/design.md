# Design

## Context

- The pane's transport (`claude-code/hooks/register.tsx`) is four Buttons: From start (`r`), Pause/Resume (`p`), Finish current (`f`), Skip to latest (`l`). The hotkeys the bead asks for already ship under *Playback hotkeys*; this change adds no delta for them.
- `tick(deck, opts)` in `claude-code/hooks/replay.ts` types `charsPerMinute / 60 × TICK_MS / 1000` code units per 50 ms tick, carrying fractional credit, and waits between changes by counting `deck.hold` down from `HOLD_TICKS` (20 ticks, 1 s). at-o3z.16 plans a second count, an 8-tick beat before a long deletion lands.
- The VS Code player computes `min(maxSpeedup, 1 + catchUpFactor × timeline.pendingCount()) × manualSpeed` and divides every sleep by it (`src/player.ts`, `speedMultiplier`). `PLAYBACK_NUMBERS` in `src/playbackSettings.ts` (at-o3z.7, in `core.mjs`) holds the defaults: `catchUpFactor` 0.5, `maxSpeedup` 8. `Timeline.pendingCount()` already counts the followed lane only, excluding the change being typed.
- The engine's desktop and VS Code element tables carry `Select` (`key`, `label`, `options`, `value`, `onSelect`); mobile's does not.
- Queue: at-o3z.16, .15, .18 and .6 implement before this one. .15 bumps `saved` and `listing`, .16 bumps `view`, .6 brings the extension's pacing and catch-up into the plugin through `src/typingSteps.ts`, with a manual speed factor fixed at 1.

## Goals / Non-Goals

**Goals:**
- The chosen speed enters as .6's manual factor, the one place the playback speed is formed.
- No change to the `saved`, `view` or `listing` shapes, so this lands after .15 and .16 without another bump.

**Non-Goals:**
- The remote surfaces (at-o3z.31): Buttons for mobile, a 10-a-second write.
- A plugin option for the default speed. Catch-up and its constants are .6's.

## Decisions

**Speeds are 0.5, 1, 2 and 4.** The mockup's cycle and the bead's range. The extension's quick pick offers 0.5, 1, 1.5, 2, 3, 5; four choices fit a Select and the mobile Buttons later. Option values are the strings `'0.5'`, `'1'`, `'2'`, `'4'`, labels `0.5×` to `4×`, Select `label="Speed"`, `key="speed"`. A stored value that is not one of the four reads as 1.

**A `pace` atom (`pace-1`) holds `{ speed, catchUp, isCatchingUp }`.** `speed` is the person's pick; `catchUp` and `isCatchingUp` are derived each flush, like `view`. Load reads `speed` back. A separate atom, as `grouping` is, keeps `saved` (.15's `saved-5`) and `view` (.16's `view-2`) untouched. Alternative: a `speed` member in `saved`. Rejected: it would force a `saved-6` on top of .15 and couple a view preference to the playback log.

**The chosen speed is at-o3z.6's manual factor.** at-o3z.6 (`claude-code-shared-typing-steps`, implemented before this) computes the playback speed as `catchUpSpeed(pending) × manual` in the shared `src/typingSteps.ts`, with `manual` fixed at 1, and divides every wait (the pause between changes, the read pause, the file-switch beat, .16's preview beat) by it. This change only feeds `live.speed` in as `manual`, so typing and every wait scale together without a second code path. Alternative: scale the budget and tick counts in `tick` here. Rejected: it would duplicate what .6's steps already do and drift.

**Catch-up is .6's.** The chip calls .6's `catchUpSpeed` with `pendingCount()` (the followed lane, excluding the change typed) for the factor it shows; no catch-up function or requirement is added here. *Catch-up speed* in .6's delta is the requirement the chip refers to.

**The chip shows the catch-up factor, not the total.** The Speed control already shows the person's pick; the chip says why typing is faster than that. Shown when typing, not paused, and `pendingCount() ≥ 3` (the bead's threshold; catch-up itself applies from one queued, as in the extension). Label: `catching up ${n}×` with `n` rounded to one decimal and a trailing `.0` dropped (`2.5×`, `8×`). The mockup's fixed `1.5×` was a placeholder.

**Placement.** Same transport row: the four Buttons, then the Select, then the chip, as the mockup draws it. The row already wraps in the pane's Box; nothing else moves, so the code rows count is unchanged.

**No Select, no control.** The render hook checks `'Select' in elements` from `$.ui.resolve(e)` and leaves the control out where it is missing, so a future mobile render can't throw. at-o3z.31 draws Buttons there.

**A pick is not a move.** Changing the speed doesn't seek, clear .16's pinned tab, or bring a scrolled list back. It goes through `act`-style handling: update `live.speed`, write `pace`, redraw.

## Risks / Trade-offs

- [.6's shape differs from its design when it lands] → Task 1.1 rebases onto it first and finds where the manual factor enters; the specs here don't depend on .6's internals.
- [4× with catch-up 8× = 32× on a 1000 cpm base types ~27 chars per tick] → Within `MAX_STEPS_PER_TICK`; large insertions are still shown at once by the existing rule.
- [A remote surface that later carries Select redraws at 10 a second] → Speed holds in typed characters per second regardless; smoothness is at-o3z.31's.

## Migration Plan

New atom with a default; an older plugin's state has no `pace` and reads as 1×. No change to stored change texts.
