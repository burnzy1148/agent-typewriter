# Proposal

## Why

A Claude Code session's replay lasts only as long as the session: the next session's pane starts empty, so a person can't keep a good run to show later, or watch yesterday's edits again. The VS Code extension saves and loads sessions (`session-persistence`), and the at-o3z.8 mockup's Mapping board carries that over as `/typewriter save` and `/typewriter load` over the plugin's own store, 4 MiB in all, with no files written. at-o3z.20 designs it.

## What Changes

- **`/typewriter` takes a word.** `/typewriter save [name]`, `/typewriter load <name>`, `/typewriter list` and `/typewriter delete <name>`. Bare `/typewriter` still opens the pane. Any other word answers with the words it takes and opens nothing. In a session that draws only on the terminal, every form still answers with the pointer to the VS Code extension.
- **Save.** Keeps the changes this session recorded, in every lane of its own, played or not, under a name: their texts, files, kinds, times, tools, numbers, captions, and the prompts of the turns they belong to. Without a name, the date and time is the name. Names compare ignoring case, so saving under a name already taken replaces that replay. A loaded replay's changes are not saved again, a git replay's (at-o3z.21) are not saved, and neither is where playback stands.
- **Within the store's 4 MiB.** Saved replays live in the plugin's `$.store`, which Claude Code keeps for the plugin across sessions, 4 MiB of JSON for every saved replay together. A file's text is kept once and each later change to it as the edit it made, so a long session fits. When a replay does not fit, the save is refused and the answer says how big the replay is, how much the saved replays already take, and to delete one. Nothing is half saved.
- **List and delete.** `list` shows each saved replay, newest first, with its change and file counts, its size, when it was saved and the folder it was recorded in, and how much of the 4 MiB is taken. `delete` removes one.
- **Load into a lane of its own.** Loading puts the replay's changes in the pane's timeline as one lane named after the replay, follows that lane and plays it from its first change, keeping whether playback is paused, and opens the pane as `/typewriter` does. The session goes on recording in its own lanes. When the replay has played out its lane gives way, as a finished subagent's lane does. Loading a name that is already loaded replaces its lane.
- **A loaded replay plays as it was recorded.** Exact texts, its captions, its chapters (named with the replay and numbered with its own turns), its file groups, and its too-large changes. Its changes are not in this conversation, so they get no Show in conversation, no ↗ and no chips on call rows.
- **Limits and reloads.** Loaded changes count toward the 200 changes and 20,000,000 characters kept, as recorded ones do. A loaded replay survives a plugin reload within the session, and does not carry into the next session unless loaded again.

Out of scope, and kept possible:
- Saving one turn, one lane or a range. Save keeps the whole session.
- Unloading a replay's lane by hand. Its changes leave as the limits drop them, or with the session.
- Saving a loaded replay or a git replay lane (at-o3z.21) again. Save keeps what this session recorded.
- Saving where playback stood, the chosen grouping or the lanes' followed state.
- Moving replays between machines or to a file. The plugin never writes a file.
- Seeing replays saved by the VS Code extension, which keeps its own.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: adds requirements for `/typewriter`'s words, saving, the store's 4 MiB, naming and replacing, listing, deleting, loading into a lane, how a loaded replay plays, what a loaded change does not offer, the limits, reloads, and refusing a replay that can't be read. Modifies *Pane opens on request or on the first change* so that only bare `/typewriter` opens the pane.

## Impact

- New `claude-code/hooks/saved.ts`: pure functions that encode the session's changes into a stored replay (each file's text once, later changes as edits, checked to rebuild exactly), decode one back into changes, parse `/typewriter`'s words and names, and word the answers.
- `claude-code/hooks/register.tsx`: dispatches `/typewriter`'s words, reads and writes `$.store`, loads a replay into the deck, a `replays` atom for loaded replays' names, folders and turns, and the `argumentHint` on the command.
- `claude-code/hooks/replay.ts`: a loaded change's lane, its chapter header naming the replay, rows and the header leaving out Show in conversation for loaded changes, a `saved` tag after at-o3z.15's `saved-5` that keeps which replay each change came from, and rebuilding the timeline without a replaced replay's lane.
- `claude-code/types/index.d.ts`: the stored replay type, `SavedChange.replay`, `Row.isLoaded`, and the `replays` key in `PluginState`.
- `claude-code/tests/` and `test/claudeCodeReplay.test.ts`: tests for encoding round trips (with a fuzz test against the planner), the commands, the store limit, loading, reloads and migrations.
- `claude-code/README.md`: the four words, the 4 MiB, and that saved replays hold file contents in Claude Code's configuration directory until deleted.
- Shared modules: none change. `planHunks` and `applyHunks` are already in `core.mjs`.
- Builds on at-o3z.15 (`claude-code-subagent-lanes`) for lanes; implemented after it lands.
