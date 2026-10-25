# Design

## Context

See proposal.md for the motivation and specs/edit-navigation/spec.md for the behavior.

Today `Player` has two waits:

- `scrollTo` sleeps `humanize(scrollPauseMs) / speedMultiplier` before scrolling to an off-screen edit, but only while `smoothScroll` is on.
- `play()` and `moveMirror()` show the next file's mirror first, then sleep `fileSwitchDelayMs / speedMultiplier`.

Both are fixed waits counted from the moment replay reaches that point, so idle time before the change arrived doesn't count. `sleep()` also caps every wait at 5 s.

Every text change the player makes to a live mirror goes through `Player.edit()`. Every control that moves playback (seek, replay from, skip, skip to latest, catch up, clear, follow by hand, load session) calls `interrupt()` or `snapToLatest()`, and both bump `epoch`. Auto-follow moves to another lane only after the followed lane has been quiet for a while, and does not interrupt.

## Goals / Non-Goals

**Goals:**
- One read-pause step, used at the three places the view leaves typed text: the off-screen scroll or jump, the file switch in `play()`, and the rename path.
- The settings logic is vscode-free and unit-tested, as `pace.ts` is.

**Non-Goals:**
- Read pauses before edits already in view. The caret walk and the per-hunk 220 ms beat stay as they are.
- Changing how a scroll itself moves. The scroll speed and the one-second cap are untouched.

## Decisions

### Count from the last edit, scoped to the playback epoch
`Player` records `lastEditAt` (`Date.now()`) and `lastEditEpoch` in `edit()` after each successful edit. `readPause(epoch)` works out `target = readPauseSeconds * 1000 / speedMultiplier(s)` and `left = target - (Date.now() - lastEditAt)`, and sleeps in steps of at most 100 ms, working `left` out again after each one, until it reaches 0. Re-checking means a speed, catch-up or setting change during the pause applies to what is left, and a slow speed is not capped by `sleep()`. It does nothing when `lastEditEpoch !== epoch`. That one check covers every "jump in playback" case in the spec, because each of them bumps the epoch, and so does the first change ever played (`lastEditEpoch` starts at -1). Auto-follow's handoff keeps the epoch, so it gets a read pause. Its quiet period has usually used the read pause up already, so the handoff shows no extra wait.

Alternative: a fixed wait, like today. Rejected because the user wants idle time to count, so live recording has no dead air.

Alternative: key the skip off `lastRelPath === undefined`. Rejected because a seek doesn't clear `lastRelPath`, so the first change after a seek would still pause.

### Time paused counts, but the pause holds the switch
`sleep()` already keeps counting while playback is paused, so paused time counts toward the read pause without extra work. After the sleep, `readPause` calls `whilePaused(epoch)`. That way a pause pressed during the read pause keeps the old file in view, instead of showing the new tab and then holding.

### Read pause before the switch, file-switch delay after
In `play()`, when `switching && lastRelPath !== undefined`, replay awaits `readPause(epoch)` before `setPlaybackPath`/`showMirror`. It returns if the change is no longer live. The existing `fileSwitchDelayMs` sleep stays after `showMirror`. `moveMirror()` does the same before showing the old path. The trade-off: during the read pause the timeline already shows the next change as playing while the old mirror is still in view.

Alternative: wait in `loop()` before `timeline.begin()`. Rejected because pause, seek and finish-current handling all live in `play()`. Waiting in the loop would duplicate them, and would leave nothing marked as playing during the wait.

### Off-screen edits wait whether or not smoothScroll is on
`scrollTo` becomes:
1. Jump without waiting when `!smooth`, when there is no viewport, or once finish current is pressed.
2. Return when the edit is in view.
3. Otherwise `readPause(epoch)`, then `ready()`, then jump if `smoothScroll` is off, or scroll as today.

The `smooth` flag already marks the first edit after a file switch and the first change played as "no read pause".

### No jitter on the read pause
The old scroll pause was humanized. The read pause is a floor ("at least N s since the last edit"), so random spread would only make it harder to predict and to test. Typing keeps its jitter.

### sleep() caps at 15 s instead of 5 s
The 5 s cap would cut a longer file-switch delay short. The new cap is the settings' maximum, 15 s, so a slow manual speed (down to 0.1x) can't stretch the file-switch delay past it; the spec states this limit. The read pause waits in short steps, so the cap never shortens it.

### Renames count as a switch for the first edit
`moveMirror()` shows the new name's mirror and sets `lastRelPath` to it, so `play()` would see no switch and scroll to the first edit after a read pause on the new tab, where nothing was just typed. `play()` treats a change with `fromRelPath` as a switch when choosing `smooth` for its first hunk, so that edit is jumped to without a read pause.

### scrollTo looks at the view again after the pause
The pause can be long, and the user can scroll or resize the mirror during it. After the read pause `scrollTo` checks again whether the edit is in view, and takes the viewport height from the editor as it is then.

### Settings resolution in a vscode-free module
New `src/readPause.ts` holds:
- `resolveReadPauseSeconds(layers)`: for each layer in priority order (workspace, repository file, user), a valid `readPauseSeconds` wins, else a valid `scrollPauseMs / 1000` with `fromDeprecated: true`, else the next layer, else 1.5. The result is clamped to 0–15.
- `readPauseLeft(lastEditAt, now, seconds, speed)`: the ms still to wait.

`config.ts` feeds it from `cfg.inspect` and `repoValues`, the same way `resolveSpeed` does. `Settings` drops `scrollPauseMs` and gains `readPauseSeconds` and `readPauseFromDeprecatedSetting`. `fileSwitchDelayMs` becomes `num('fileSwitchDelayMs', 1000, 0, 15000)`. `extension.ts` gets a `noteDeprecatedReadPause` modeled on `noteDeprecatedSpeed`, run at activation and when `readPauseSeconds` or `scrollPauseMs` changes.

Alternative: rename in place and drop `scrollPauseMs`. Rejected because it would silently discard values users already set.

## Risks / Trade-offs

- [Integration tests slow down by about 1.5 s per file switch and off-screen edit] → The integration workspace sets `readPauseSeconds` to 0. The tests that cover the read pause set it themselves.
- [With `smoothScroll` off, off-screen edits now wait] → Called out as breaking in the CHANGELOG. `readPauseSeconds: 0` restores the old behavior.
- [A user who set `scrollPauseMs` to tune only scrolls now also gets that wait before file switches] → It's the same intent (time to read), so the value is honored for both, and the output channel note points to `readPauseSeconds`.
- [The next change shows as playing in the timeline while the old file is still in view] → Accepted. The wait is at most a few seconds at 1x, and the status row on the old mirror keeps showing until the switch.

## Migration Plan

No data migration. Users with `scrollPauseMs` set keep that value as their read pause until they set `readPauseSeconds`. Rolling back the release restores the old waits, and both settings stay in their files untouched.
