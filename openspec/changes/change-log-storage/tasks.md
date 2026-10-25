# Tasks

## 1. Text holders

- [ ] 1.1 Add `src/changeText.ts`: `TextHolder` (in memory or offloaded to a reader, character count, `pin`), the character-bounded LRU read cache, lazy events with enumerable `before`/`after` getters, `textHolder(e)` and `textChars(e)`; verify with new `test/changeText.test.ts` (getters read through the holder, offloaded reads go through the cache and evict by size, spread and `JSON.stringify` give plain data, a failing reader gives empty text and reports once)

## 2. Timeline size bound

- [ ] 2.1 Make `Timeline.push` keep text in a holder, `restore` rebind events to new seqs without reading their text, and `toSession` count characters through holders; verify the existing timeline, session and persistence tests still pass
- [ ] 2.2 Add the size bound to `Timeline` (constructor argument, running total, `setSizeLimit`, trim by both bounds keeping the newest change, `restore` keeping the newest that fit both); verify with timeline tests for the size bound across lanes, a single oversized change, lowering the bound, restore, and `droppedUnplayed`
- [ ] 2.3 Make `Timeline.mirrorStates` and `baselines` in `src/highlights.ts` read at most one text per file; verify existing highlight and mirror-state tests pass and a new test counts reads through offloaded holders

## 3. Settings and dialogs

- [ ] 3.1 Add `agentTypewriter.historySizeMB` to `package.json`, `src/config.ts` and `src/repoSettings.ts`, apply it at activation and on change in `src/extension.ts`, and drop the 64 MB note from `persistHistory`'s description; verify with `npm run typecheck` and the repo-settings test
- [ ] 3.2 Make the session-load and git-replay limit check cover both bounds (raise whichever is exceeded, or load the newest that fit both) and name both settings in the dropped-changes message; verify with a unit test of the fitting helper and `npm run typecheck`

## 4. Log store

- [ ] 4.1 Rewrite `TimelineStore` in `src/persistence.ts` around `history/`: per-lane segment files with CRC-checked records, `state.json` written through a rename, order numbers, synchronous incremental saves (append new changes, offload their holders, delete dead segments, write state), and keep `start`/`stop`/`flush`/`flushSync`/`deleteSaved`/`dispose`/`path`; verify with rewritten `test/persistence.test.ts` covering save and load, lanes and cursors, highlight clears, appending only new changes, cursor-only saves writing no text, and lazy load after restore
- [ ] 4.2 Compaction: delete fully dead segments, skip dead records below `first` on load, delete lanes' files when they leave the buffer, and rewrite a lane when the prefix property does not hold; verify with tests for trimming across segments, Clear Buffer, a session load replacing the buffer, and disk use staying near the buffer size
- [ ] 4.3 Recovery: truncate a segment after its last good record (torn text, torn header, CRC mismatch), drop later segments of that lane, delete leftover temp files, treat an unparsable `state.json` as missing, set a newer-version history aside and hold saves until it is moved; verify with tests that truncate a log at several points and then record and reload again
- [ ] 4.4 Migration from `timeline.json.gz`: load it when `history/state.json` is missing, delete it only after the first complete save, migrate again after an interrupted migration; verify with tests for a migrated timeline with lanes and clears, and an interrupted migration
- [ ] 4.5 Turning `persistHistory` off reads offloaded text back into memory before deleting `history/`; verify with a test that turns it off, then plays and saves a session file with the full text

## 5. Docs and integration

- [ ] 5.1 Update `site/` (how-it-works, limits, session-files) and `CHANGELOG.md` for the size bound, the log and the downgrade note; verify the pages read correctly and no longer mention the 64 MB saved-text cap
- [ ] 5.2 Run `npm run typecheck`, `npm test` and, where it can run, `npm run it` (the reload check in `it/restore.ts` exercises the log end to end); verify all pass

## Workflow follow-up

- Open the PR to `develop` naming bead at-9oi and this change.
- Once CI is green on Ubuntu and Windows, archive this change on the PR branch and push.
