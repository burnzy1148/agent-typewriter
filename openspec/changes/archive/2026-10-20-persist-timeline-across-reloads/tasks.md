# Tasks

## 1. Session format and restore

- [x] 1.1 Add `SESSION_FORMAT`, `SESSION_VERSION`, `toSession`, `parseSession` and `SessionFormatError` to `src/timeline.ts`, and verify unit tests in `test/session.test.ts` cover a round trip, the text size cap keeping the newest events, a newer version, an unknown kind, a bad `eol`, missing fields, and non-increasing seqs
- [x] 1.2 Add `Timeline.restore(events, cursor)` and verify unit tests cover renumbering after earlier pushes, cursor mapping for played, pending and all-played buffers, the history limit keeping the newest, and a seek token issued before restore being stale after it

## 2. Storage

- [x] 2.1 Add `src/persistence.ts` with `TimelineStore` (load, throttled async save with atomic rename, cached events JSON, `flushSync`, `deleteSaved`, unreadable-file rename, size-cap log line) and verify unit tests in `test/persistence.test.ts` with a temp folder cover save then load, throttling, a damaged file being renamed and reported, and delete

## 3. Wiring and settings

- [x] 3.1 Add `persistHistory` to `package.json`, `config.ts` and the README (settings table and a note on where history lives), and verify `npm run typecheck` passes
- [x] 3.2 In `extension.ts`, load and restore before `autoStart`, pause when restored changes are pending, log the restore, final-save in `deactivate`, react to `persistHistory`, and expose the store on the API; verify `npm test` passes and the integration checks in group 4

## 4. Integration checks

- [x] 4.1 Launch VS Code a second time in `it/runTest.ts` on the same workspace and user-data folder with a new `it/restore.ts` suite; at the end of `it/suite.ts`, pause, record two more changes, and write the expected state to a file; in `it/restore.ts`, assert the same events and texts, the two pending changes, playback paused, the store path outside the workspace, then resume and assert the mirrors match disk; verify `npm run it` passes locally and on CI (Ubuntu and Windows)

## Workflow follow-up

- Archive on the PR branch once tasks are done and CI is green, then merge.
- Close at-dqb.1 after the merge.
