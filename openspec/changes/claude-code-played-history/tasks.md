# Tasks

## 1. Kind and time

- [ ] 1.1 In `claude-code/hooks/replay.ts`, add `kind: 'create' | 'modify'` and `time: number` to `Change`; make `eventOf()` copy them instead of the placeholders and `changeOf()` read them back. Update `change()` in `test/claudeCodeReplay.test.ts` to give them, and add a unit test that an enqueued change's event carries its kind and time. Verify with `npm test`.
- [ ] 1.2 In `claude-code/hooks/register.tsx`, make `record()` set `kind` (`'create'` when the before snapshot is missing, else `'modify'`) and `time` (`$.clock.now()` after the after snapshot). Verify with `npm run typecheck:claude-code` and `npm run check:claude-code`.

## 2. Saved shape `saved-2`

- [ ] 2.1 In `claude-code/types/index.d.ts`, give `SavedChange` `kind` and `time` and `Saved` a `played` count, with doc comments saying what each holds. In `replay.ts`, make `savedOf()` list the played changes, the change being typed, then the waiting ones, and count the played ones. Rewrite the unit tests that read `savedOf` or `liveIds` to the new shape, and add one for a deck with played, typing and waiting changes, and one where the timeline has dropped the change being typed. Verify with `npm test`.
- [ ] 2.2 Make `restore(saved, changes, opts, cwd?)` set the cursor past the loaded changes that `saved.played` counts as played, and set `shown` to the last played one done, with the caret `skipToLatest` would give it. Add unit tests: a save and restore round trip keeps played, waiting and kind and time; a restore with every change played plays nothing and shows the last one; a played change whose texts are missing is skipped and the rest keep their states. Verify with `npm test`.
- [ ] 2.3 Add `savedFrom(stored)` to `replay.ts`: a `saved-2` value as stored, a `saved-1` value as every change waiting, each a `'modify'` at time `0`, anything else empty. Unit-test all three. Verify with `npm test`.

## 3. Saving and loading in the plugin

- [ ] 3.1 In `register.tsx`, tag the `saved` atom `saved-2`; make `load()` read the stored `saved` with `$.state.get`, pass it through `savedFrom()`, and call `restore()` with `live.opts`; make `flush()` clear the texts of tracked ids that the next `saved` no longer lists, before writing `saved`. Drop `liveIds` from `replay.ts` once nothing uses it. Verify with `npm run typecheck:claude-code`.
- [ ] 3.2 In `claude-code/tests/`, change the reload seeds to `saved-2`, and add plugin tests: a played change keeps its texts in `saved` until it is dropped; a reload with played and waiting changes plays only the waiting ones; a reload with everything played shows the last change's file and after text and types nothing; a `Write` of a new file is saved as `'create'` with the clock's time and an `Edit` as `'modify'`; a reload of `saved-1` state plays its changes; 201 recorded changes keep 200 in `saved`, the oldest played one dropped and its texts cleared. Rewrite "a finished change has its texts cleared" to the new rule. Verify with `npm run check:claude-code`.
- [ ] 3.3 In `claude-code/README.md`, say under Options that changing an option reloads the plugin, which keeps recorded changes, played and queued, and starts the change being typed over. Verify by reading the section.

## 4. Integration

- [ ] 4.1 Run `npm run typecheck`, `npm test`, `npm run typecheck:claude-code` and `npm run check:claude-code`, and `openspec validate claude-code-played-history --strict`. All pass.

## Workflow follow-up

- Record the change on the bead (`bd update at-u1t --spec-id openspec/changes/claude-code-played-history`) and remove its `needs-spec` label.
- Open a PR into `claude-code-extension` with the at-mwi fix as its own commit, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-u1t and at-mwi after the merge.
