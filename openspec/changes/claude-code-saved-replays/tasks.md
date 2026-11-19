# Tasks

## 0. Base

- [ ] 0.1 Branch from `origin/claude-code-extension` once `claude-code-subagent-lanes` (at-o3z.15) has merged into it, and re-read that change's archived requirements and its `saved-5` shape. If a later merged change took `saved-6` or `listing`/`view` tags, use the next free tag in every task below. Verify `npm test` and `npm run check:claude-code` pass on the base.

## 1. Encoding and decoding

- [ ] 1.1 Create `claude-code/hooks/saved.ts` with the `StoredReplay`/`StoredChange` types (also exported through `claude-code/types/index.d.ts`), `encodeReplay(changes, turns, { name, savedAt, cwd })` and `decodeReplay(stored)`, as in design.md *Each file's text once, later changes as edits*: chained befores, `edits` from `planHunks`, checked with `applyHunks` and falling back to `after`, too-large changes with no text; decoding returns the changes or a reason (`newer` for an unknown `v`, `damaged` for an edit out of range or a missing before). Unit-test in `test/claudeCodeReplay.test.ts`: every scenario of *Replays keep a file's text once*, a too-large change, captions and links kept, unknown `v`, and damaged edits. Verify with `npm test`.
- [ ] 1.2 Add a fuzz test beside the planner's: random sequences of changes over a few paths, with some befores not matching the previous after, round-trip through `encodeReplay` and `decodeReplay` to identical texts, and the encoded JSON of a 40-edit, 300 KB file stays under 1.2× the file. Verify with `npm test`.

## 2. Words, names and answers

- [ ] 2.1 In `saved.ts`, add `parseTypewriterArgs(args)` (`open`, `save`, `load`, `list`, `delete`, or `usage`, matching words ignoring case, the name folded and trimmed), `replayName(raw, now)` (the default `YYYY-MM-DD HH:MM` in local time, 1–60 characters, control characters refused with the reason), `replayKey(name)` (`replay:` plus `toLocaleLowerCase('en-US')`), `formatSize(n)` (KiB under 1 MiB, else MiB to one decimal), and the answer texts: saved, replaced, nothing to save, too big, list (newest first, counts, files, size, time, folder, total of 4 MiB), none saved, deleted, unknown name with the saved names, loaded (name and count, then the open answer), newer, damaged, usage. Unit-test each against the scenarios of *`/typewriter` takes a word*, *Replay names*, *List saved replays* and *Delete a saved replay*. Verify with `npm test`.

## 3. Save, list, delete

- [ ] 3.1 In `claude-code/hooks/register.tsx`, register `/typewriter` with `argumentHint: 'save|load|list|delete [name]'`, and make the `command.run` hook check the terminal first for every form (*Every word in a terminal session points to the extension*), open the pane only for bare `/typewriter`, and answer `usage` for any other word. Add plugin tests in a new `claude-code/tests/saved.test.tsx` for those scenarios and the MODIFIED *Pane opens on request or on the first change*. Verify with `npm run check:claude-code`.
- [ ] 3.2 Add save: collect the kept changes of the session's own lanes (no `replay` field) with their texts and captions from the deck, the turns their `mainTurnId`s name from `live.turnInfo`, `live.cwd`; encode; read whether the key exists; `$.store.set`; on rejection answer too big with the sizes from design.md *Sizes come from the store's own refusal*. Add list (`keys()`, `get` each `replay:` key, sizes from `JSON.stringify`) and delete. Plugin tests (the test world's store must enforce 4 MiB and keep the old value on a refused `set`; extend `claude-code/tests/world.ts` if it does not): every scenario of *Save the session's changes as a named replay*, *Save leaves out what this session did not record*, *Saving under a taken name replaces it*, *Saved replays outlast the session* (two worlds sharing one store), *Saved replays stay within 4 MiB*, *List saved replays*, *Delete a saved replay* and *Saving writes no file*. Verify with `npm run check:claude-code`.
- [ ] 3.3 In `claude-code/README.md`, document `/typewriter save|load|list|delete`, names, the shared 4 MiB, and that saved replays keep file contents in Claude Code's configuration directory until deleted. Verify by reading the section.

## 4. Load

- [ ] 4.1 In `claude-code/hooks/replay.ts`, add `SavedChange.replay` and `Change.replay`, the `saved-6` tag with `savedFrom` reading `saved-5` and older as having no loaded changes, `eventOf` taking a per-change `cwd`, and `loadReplay(deck, key, name, changes, cwd, opts)`: namespace ids and turn ids, drop `agentId` and `agentCallId`, define the `saved:<key>` lane (label, color by the five-color rule, not recording), rebuild the timeline without that lane first when it exists (keeping other lanes' cursors), push the changes, and follow the lane from its first change as following by hand does. Unit-test every scenario of *Load a replay into a lane of its own*, *Loading a loaded name replaces its lane* and *Loaded changes count toward the limits*, and the `saved-5` migration. Verify with `npm test`.
- [ ] 4.2 In `register.tsx`, add the `replays` atom (`replays-1`: `{ key, name, cwd?, turns }[]`) written in `flush` and pruned to lanes still holding a kept change, load it in `load()`, and wire `/typewriter load`: `get`, decode (answering newer or damaged and changing nothing), write the texts into the `text` family, `loadReplay`, `sync`, then open the pane as bare `/typewriter` and answer. Plugin tests for *Loading opens the pane*, *A replay that can't be read is refused* and *Loaded replays survive a reload* (reload mid-replay; a new session has no lane). Verify with `npm run check:claude-code`.

## 5. How a loaded replay shows

- [ ] 5.1 In `replay.ts`, give `chaptersOf` the loaded replays' turns and carry the replay name on their chapters, put it before `Turn n` in `headerLabel`, and add `Row.isLoaded` and the same on `View` (new `listing` and `view` tags). In `register.tsx`, leave out the header's Show in conversation and the row's ↗ for loaded changes, and make sure no call-row or Play turn chip is drawn for loaded ids. Unit- and plugin-test every scenario of *A loaded replay plays as recorded*, *A loaded replay keeps its chapters* and *Loaded changes are not in this conversation*, including grouping by file. Verify with `npm test` and `npm run check:claude-code`.

## 6. Integration

- [ ] 6.1 In a local desktop session with the plugin loaded (`claude --plugin-dir claude-code`), save a session with a subagent's changes and a too-large file, start a new session, list, load it while Main is typing, let it give way, reload the plugin mid-replay, and delete it. Note anything the tests missed as beads.
- [ ] 6.2 Run `npm run typecheck`, `npm test`, `npm run build:claude-code` (no diff expected: no shared module changes), `npm run typecheck:claude-code`, `npm run check:claude-code`, and `openspec validate claude-code-saved-replays --strict`. All pass.

## Workflow follow-up

- Open a PR into `claude-code-extension`, turn on Auto-fix, and run the review cycle.
- Archive the change on the PR branch once its tasks are done and CI is green, so `openspec/specs/claude-code-replay/spec.md` lands with the code.
- Do not merge; the maintainer merges. Close at-o3z.20 after the merge.
