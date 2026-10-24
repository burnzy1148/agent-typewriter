# Tasks

## 1. Lane policy (pure)

- [x] 1.1 Add `src/lanes.ts` with `MAX_LANES`, `ROTATE_IDLE_MS`, `AUTO_FOLLOW_IDLE_MS`, `colorSlot`, `rotationVictim`, `autoFollowTarget`, `laneLabel` and `defaultLanes` as in the design. Verify with new `test/lanes.test.ts` cases: remembered slot kept, lowest free slot, slots repeat past five, victim skips the followed and recently active lanes, no victim when all are busy, auto-follow picks the lane with the oldest pending change, labels in single- and multi-root, the first five folders chosen with the rest named

## 2. Timeline lanes

- [x] 2.1 Add `lane` to `ChangeEvent`, plus `LaneInfo`, `defineLane`, `setLaneRecording`, `lanes`, per-lane cursors, `followed`/`follow`, `laneEvents` and `pendingCount(lane)` to `Timeline`. The existing cursor API acts on the followed lane, and `begin`/`complete` advance the event's own lane. Verify that `test/timeline.test.ts` passes unchanged with a single lane, plus new two-lane cases: queued in the unfollowed lane, follow mid-change leaves it pending, seek and skip touch only the followed lane, `stateOf` per lane
- [x] 2.2 Make trimming, `droppedUnplayed`, `mirrorStates`, `latestStates(lane?)`, clears (with `lane`; a global clear writes one per lane) and `restore` (mapping every lane cursor) lane-aware, and remove empty, non-recording lanes on trim. Verify with two-lane unit cases for each, and a fuzz case in `test/timeline.test.ts` interleaving pushes in random lanes, follows, seeks and trims, asserting each lane's played changes are a prefix of its changes and the buffer never exceeds the limit
- [x] 2.3 Session format v3: `lanes`, `cursors`, `followed`, `lane` on events and clears, `SESSION_VERSION = 3`; `parseSession` reads v1/v2 as one lane `''` and rejects a v3 event naming an undeclared lane. Verify with `test/session.test.ts`: v3 round trip with two lanes, v2 file into one lane, undeclared lane refused, newer version refused. Update the session-format notes in the README

## 3. Persistence

- [x] 3.1 Replace `TimelineStore`'s first/last-seq JSON cache with a per-seq cache pruned on trim, keeping the 64M-char cap across lanes and the saved-file shape. Verify with `test/persistence.test.ts`: two-lane save/restore keeps cursors and the followed lane, appending one event re-encodes only that event (count calls through a spy), and the cap still leaves out the oldest

## 4. Choices file

- [ ] 4.1 Extend `CheckoutChoiceFile` and `CheckoutChoices` with sets per folder (reading the old single-path string), `followed` and color slots, keeping `get`/`set` as single-path shims. Verify with `test/worktrees.test.ts` cases: old file reads as one checkout, set round trip, followed and colors round trip, an unreadable file means nothing chosen

## 5. Recorder: a scope per checkout

- [ ] 5.1 Re-key `scopes`, `goneChecks`, `goneRefreshed`, `heldDeletes`, `deleteSettles` and `provisional` by lane id, with one scope per folder as before. Verify that `npm test` passes unchanged (`recorder`, `recorderScope`, `recorderLabels`)
- [ ] 5.2 Resolve one scope per chosen checkout (cap of five, own checkout by default, first five folders when more), tag each pushed change with its lane, and register lanes and colors in the timeline. Watch a nested lane through the folder watcher when the own checkout records, and drop handler events whose `scopeOf` is another scope. Verify with `test/recorderScope.test.ts` cases: main plus nested worktree record once each in their lanes, main plus sibling worktree, own checkout cleared, sixth checkout refused
- [ ] 5.3 Add `setCheckouts`, `addCheckout` and `removeCheckout`. A removed or gone worktree stops its lane (kept in the buffer), and a folder left with none falls back to its own checkout, as logged today. Verify with `test/recorderScope.test.ts`: add while recording gets baselines, remove keeps queued changes, gone worktree stops only its lane, last one gone falls back
- [ ] 5.4 Auto-record: watch each recorded repository's `<common dir>/worktrees/`, diff listings to find new worktrees, and apply `fill`/`rotate` with `rotationVictim`, logging every skip and rotation. Add the `agentTypewriter.autoRecordWorktrees` setting (package.json, `src/config.ts`, repo settings kinds and schema, README). Verify with `test/recorderScope.test.ts`: fill adds a lane, fill at cap logs and skips, rotate stops the idle lane, rotate with all busy skips, off leaves today's behavior

## 6. Highlights per lane

- [ ] 6.1 Have `HighlightView` compute baselines per lane (lane events, lane `through`, lane clears) and merge them, and make Clear Highlights write per-lane clears. Verify with `test/highlightView.test.ts` cases: two lanes at different positions highlight independently, clear all clears both, seek back in one lane restores only its highlights

## 7. Views and UI

- [ ] 7.1 Add the Activity Bar container and icon, move the Changes and Playback views into it, and contribute the five `agentTypewriter.lane*` colors. Verify `npm run package` includes the icon, and the integration suite finds the views by id
- [ ] 7.2 Group the Changes view by lane when more than one lane is in the buffer (followed lane first and expanded, colored node with its queued count, "stopped" label), unchanged with one lane. Verify with a new `test/timelineView.test.ts` against the vscode mock: one lane is flat, two lanes give ordered lane nodes
- [ ] 7.3 Add `CheckoutsView` with checkboxes, lane color icons, followed/queued/stopped descriptions, a Follow inline action, a "Not recording" node for buffer-only lanes, and title actions for auto-follow on/off and refresh. Register `agentTypewriter.followLane`, `autoFollowOn`/`autoFollowOff` and the `agentTypewriter.autoFollow` setting (package.json, config, schema, README). Verify with `test/checkoutsView.test.ts` against the mock: rows per checkout, a refused sixth tick resets its box, buffer-only lanes listed
- [ ] 7.4 Make the scrubber and its seek messages use the followed lane's changes and show its label, and prefix the mirror status row with the lane label when there are several lanes. Verify with `test/scrubberState.test.ts` two-lane cases (index, queued, label) and the existing webview test
- [ ] 7.5 Add the mirror `FileDecorationProvider` (lane color and badge, only with more than one lane) and show the followed lane in `statusPresentation`. Verify with `test/statusText.test.ts` cases and a unit test of the URI→lane mapping
- [ ] 7.6 Make `chooseCheckout` a multi-select with the cap and the empty refusal, keeping the test arguments and adding `string[]`. Verify with an integration check that the array argument records two checkouts
- [ ] 7.7 Add the auto-follow controller (3 s idle timer, never mid-change, re-checked on fire). Verify with a unit test using fake timers through an exported pure step function, plus the integration check in 8.1

## 8. Integration

- [ ] 8.1 Add an integration section (`it/lanes.ts`, wired into `npm run it`): main and a nested worktree recorded at once, each typed into its own mirror only when followed; follow switches and resumes; auto-follow tours both lanes; auto-record `fill` picks up `git worktree add`; reload restores lanes, cursors and the followed lane; no real file is written. Verify `npm run it` passes locally
- [ ] 8.2 Run `npm test`, `npm run it` and `npm run package`, and update the README's checkout section and screenshots text for lanes, the container and both settings. Verify all three commands succeed

## Workflow follow-up

- Open a PR to `develop`, turn on Auto-fix, and wait for CI on Ubuntu and Windows.
- Archive the change on the PR branch once CI is green and every task is done.
