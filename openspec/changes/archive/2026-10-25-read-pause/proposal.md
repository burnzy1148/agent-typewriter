# Proposal

## Why

Replay moves on from a block of code almost as soon as it is typed. It waits 400 ms before scrolling to an off-screen edit, and on a file switch it shows the new tab at once, then waits 600 ms there. Either way the viewer loses what was just typed before they can read it. The waits should give time to read before the view leaves the block, and be long enough to matter.

## What Changes

- New `agentTypewriter.readPauseSeconds` (default 1.5, 0 to 15): before the view leaves what replay just typed, replay waits until at least that long has passed since its last edit to a mirror. The view leaves when it scrolls or jumps to an off-screen edit in the same file, or when replay switches to another file's mirror (including the move half of a rename, and a change in another lane's file).
- Time already passed counts: idle time waiting for the next change, and time spent paused. A change that arrives long after the last one switches without any extra wait.
- The read pause is divided by the playback speed multiplier, like the waits it replaces.
- On a file switch the read pause comes before the new tab is shown, so the old file stays in view while it runs. The existing `fileSwitchDelayMs` keeps its job, a beat on the new tab before typing, with its default raised from 600 to 1000 ms and a 0 to 15000 ms range.
- No read pause before an edit already in view, for the first change played, after a seek, replay from, skip to next, skip to latest, catch up, clear, following another lane by hand, or loading a session, or once finish current is pressed.
- The read pause applies whether or not `smoothScroll` is on. `smoothScroll` only chooses between scrolling and jumping. **BREAKING**: with `smoothScroll` off, an off-screen edit now waits for the read pause before the jump; set `readPauseSeconds` to 0 for the old behavior.
- `agentTypewriter.scrollPauseMs` is deprecated. In any settings layer that sets it but not `readPauseSeconds`, its value (divided by 1000) stands in for `readPauseSeconds`, the same way `charsPerSecond` stands in for `charsPerMinute`. The output channel notes the deprecation once.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `edit-navigation`: the pre-scroll pause becomes the read pause, which also runs before file switches and with smooth scrolling off and counts time already passed; the file-switch delay's default and range are specified; `scrollPauseMs` is deprecated in favor of `readPauseSeconds`.

## Impact

- `src/player.ts`: one read-pause step called before a file switch (in `play()` and the rename path) and before bringing an off-screen edit into view in `scrollTo`, tracking when replay last edited a mirror and in which playback epoch. `sleep()` loses its 5 s cap, which would cut a 15 s wait short.
- `src/config.ts`: `readPauseSeconds` with the per-layer `scrollPauseMs` stand-in; `fileSwitchDelayMs` default and clamp. `src/extension.ts`: the deprecation note.
- `src/repoSettings.ts`, `package.json`, `schemas/agent-typewriter.schema.json`: the new setting, `scrollPauseMs` marked deprecated, the new `fileSwitchDelayMs` default and range.
- Unit tests for settings resolution, the `Settings` objects in the recorder tests, and `it/suite.ts`, whose other tests need the read pause off so they don't each wait 1.5 s.
- README settings table and CHANGELOG.
- Bead `at-2i9.9`.
