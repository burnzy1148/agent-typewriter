# Design

## Context

- **The deck is session state.** `register.tsx` keeps the deck in module memory and mirrors it into `$.state`: `saved` (`saved-4` today; at-o3z.15 moves it to `saved-5` with lanes and per-lane positions), each change's texts and caption in the `text` family, `turns`, `agents` and `grouping`. `$.state` lasts for the session and a reload; nothing outlives the session.
- **`$.store` outlives it.** The engine's `$.store` is the plugin's own key-value store, JSON values, kept between sessions and hot reloads in a JSON file the engine owns under Claude Code's configuration directory. `set` rejects once the whole store would pass 4 MiB of JSON text. It has `get`, `set`, `delete` and `keys`, no change events and no transactions, and every session of the plugin on the machine shares it. The plugin uses no store key today.
- **`/typewriter` ignores its arguments.** `command.run` hands `e.args`, everything after the name. The hook today opens the pane whatever `args` holds.
- **Lanes come first.** at-o3z.15 (`claude-code-subagent-lanes`) gives the deck a lane per loop on the shared `Timeline`'s lanes, follow by hand, finished lanes giving way, lane chips and row lane tags. This change is queued after it and builds on it. The `Timeline` has `defineLane`, `follow`, `laneEvents` and `restore(events, cursor, clears, lanes)`, but no way to drop one lane's events.
- **The planner is shared.** `planHunks` and `applyHunks` are in `core.mjs`, and the fuzz test guards that applying `planHunks(before, after)` to `before` gives `after`.

## Goals / Non-Goals

**Goals:**
- A stored form small enough that ordinary sessions fit several to the 4 MiB, rebuilt exactly.
- No shared index key that two sessions could race on.
- A loaded replay that reuses lanes, chapters, file groups and captions instead of a second playback path.
- No change to the shared modules or `core.mjs`.

**Non-Goals:**
- Compression beyond chaining texts and keeping edits (no gzip: `$.store` holds JSON, and base64 would eat most of the gain).
- Splitting one replay over several keys to pass the per-store limit; the limit is the store's, not a key's.
- A pane control for save or load. The command is the whole interface, as the mockup draws it.

## Decisions

### One store key per replay, holding everything

Each saved replay is one key, `replay:<name folded to lower case>`, whose value is the whole replay:

```ts
type StoredReplay = {
  v: 'replay-1';
  name: string;          // as the person spelled it
  savedAt: number;       // epoch ms
  cwd?: string;          // the folder the session ran in
  turns: { turnId: string; number: number; prompt: string }[];
  changes: StoredChange[];
};
type StoredChange = Omit<SavedChange, 'replay'> & {
  caption?: string;
  before?: string;                         // absent: the file's text after its previous change here
  edits?: [offset: number, deleteLength: number, insertText: string][];
  after?: string;                          // instead of edits when they would not rebuild it
};
```

`list` reads `keys()`, keeps those under `replay:`, and `get`s each to count changes and files, measure `JSON.stringify(value).length`, and read `savedAt` and `cwd`. A save is one `set`, a delete one `delete`, so each is atomic in the store and two sessions never read-modify-write a shared value.

Alternatives: an index key listing names and sizes beside one key per body makes `list` cheap but is a shared read-modify-write that two sessions saving at once can lose an entry from, and a crash between the two writes leaves an orphan body taking room nobody can see. A meta key per replay avoids the race but keeps the orphan problem. `list` is rare and the person asks for it, so reading up to 4 MiB then is the better cost.

### Each file's text once, later changes as edits

Encoding walks the kept changes in recorded order with a map from path to the text after its last change. A change's `before` is stored only when it differs from that map's entry (the file's first change, or a file a `Bash` command or the person changed between calls). Its after is stored as `edits` from `planHunks(before, after)`, as `[offset, deleteText.length, insertText]`, and encoding checks `applyHunks` rebuilds `after` exactly, storing `after` in full when it does not. Too-large changes store neither. Decoding reverses it; an edit out of range, or a missing `before` with no previous text, makes the replay unreadable.

This is what makes the limit livable: the session buffer allows 20,000,000 characters, mostly the same file text repeated across before and after, while a replay keeps each file roughly once. Alternative: storing before and after literally, which fills 4 MiB with one large file edited a few times.

### Sizes come from the store's own refusal

The replay's size is `JSON.stringify(value).length`, and what saved replays take is the sum the same way over the `replay:` keys. The save calls `set` and treats a rejection as over the limit, answering with those two numbers. The plugin does not pre-check against its own arithmetic: the engine's count includes keys and structure, so the refusal is the authority, and a failed `set` leaves the old value under the key, which is what keeps an over-size replace from losing the earlier replay. The engine's docs say `set` rejects but not that it leaves the store untouched; task 6.1 confirms that in the pinned CLI, and if it does not hold, save deletes nothing and writes the new value under a temporary key first, renaming only once it fits. Sizes show in KiB under 1 MiB, else MiB with one decimal.

### Only recorded changes are saved

Save keeps the changes recorded from this session's `Edit` and `Write` calls: every lane of the session's own loops. Lanes that hold no recorded change are left out whole: a loaded replay's lane (`saved:<key>`) and at-o3z.21's git replay lane. A git replay is rebuilt from git on demand, so saving it would spend the 4 MiB on what `/typewriter replay` or `/typewriter pr` can bring back. Its row fields (Add/Modify/Delete/Rename kind, `fromPath`, `commit`) have no place in `StoredChange`, and `replay-1` does not keep them. The filter is "a change with neither `replay` nor a git-lane marker", in whatever field .21 names its lane by, so the two changes can land in either order.

Alternative: saving a git lane too, which needs `StoredChange` to gain kind, `fromPath` and `commit`, and a loaded git replay to come back as a git lane. Left for a later change if people ask, under a new `v` tag.

### Names

`/typewriter`'s `args` is split at the first whitespace run into the word and the rest; the rest is the name, with whitespace runs folded and ends trimmed. The key folds the name to lower case (`toLocaleLowerCase('en-US')`, so it does not change with the machine's locale); the value keeps the spelling. The default name is local `YYYY-MM-DD HH:MM`; two saves in the same minute replace, as any save of a taken name does, and the answer says so. Control characters are refused rather than shown as stand-ins, because the name is also how the person types it back.

### A loaded replay is a finished lane

Loading defines a lane `saved:<key>` labeled with the replay's name and colored by at-o3z.15's five-color rule, pushes the decoded changes into it in order, sets it not recording (finished), then follows it and seeks to its first change through the same path as pressing a lane chip, so pause, the cued change, the scrolled list and .16's pinned tab all behave as for a follow by hand. When it plays out, at-o3z.15's *A finished lane gives way* hands playback back. The limits apply through `push` as for any change.

Loaded changes get namespaced identity so a replay never collides with the session or with another replay saved from the same session: id `saved:<key>/<original id>`, and `turnId` and `mainTurnId` prefixed the same way; `agentId` is dropped (the lane is the replay's, not a subagent's) and `agentCallId` is dropped (it names a call in another conversation). The texts go into the `text` family under the new ids, as recorded changes' do. Each change keeps its saved `number`: rows tell lanes apart by their lane tag, as subagent rows do.

Loading a name already loaded rebuilds the timeline with `restore`, leaving that lane's events out and keeping every other lane's cursor, then loads afresh. Alternative: a `Timeline.dropLane` in `src/timeline.ts`, which would touch a shared module and the extension for one caller.

### What loaded changes remember across a reload

`SavedChange` gains `replay?: string`, the key, which names the lane; the `saved` tag moves to the one after at-o3z.15's `saved-5` (`saved-6`), and `savedFrom` reads `saved-5` and older with no loaded changes. A new atom `replays` (`replays-1`) holds `{ key, name, cwd?, turns }[]` for each loaded replay still holding a kept change, for lane labels, file names and chapters after a reload; `flush` writes it when it changes and drops entries whose lane is gone.

### Chapters, file names, Show in conversation

- **Chapters**: `chaptersOf` already keys chapters on `mainTurnId`. It gets the loaded replays' turns beside the session's, and a chapter of a loaded turn carries the replay's name, which `headerLabel` puts before `Turn n`. Play turn works unchanged on the namespaced ids.
- **File names**: `eventOf` takes the replay's `cwd` instead of the session's for a loaded change, so `relPath` and file groups read as they did where it was recorded.
- **Show in conversation**: `Row` gains `isLoaded`, and `View` the same for the shown change; `register.tsx` leaves out the ↗ and the header button for them. The call-row and Play turn chips key on ids and turn ids that are in this conversation, which namespaced ones never are, so they need no change beyond a test.

### The command

`argumentHint: 'save|load|list|delete [name]'` on the registered command. One `command.run` hook parses the word and dispatches; the terminal check comes first for every form. Answers are plain `{ text }`, nothing for the model. The parse and every answer's wording are pure functions in `saved.ts`, beside the encoder, so tests cover them without the engine.

## Risks / Trade-offs

- [Saved replays hold file contents outside the project, in Claude Code's configuration directory, until deleted] → the README says so; `list` shows the folder each came from; `delete` removes one. Nothing is saved without the person asking.
- [`list` reads every replay, up to 4 MiB] → rare and asked for. If it proves slow, a meta key per replay can be added later without changing the replay key.
- [Two sessions saving the same name at once] → the later `set` wins, whole; neither leaves a mix.
- [A large load drops the session's own changes past the limits] → the same rule as recording, and *The list says how many changes were dropped* already reports it.
- [Depends on at-o3z.15's lanes] → implemented after it lands. Without lanes the design would need a second way to keep a replay apart from the session; the queue already orders .15 first.
- [at-o3z.21 (git replay) also adds `/typewriter` words] → the word dispatch and the usage answer are one table in `saved.ts` (or a `commands.ts` beside it), so .21 adds its words there, and its lane follows the same finished-lane pattern.
- [Store format change later] → `v` tags each replay; a reader refuses tags it does not know and still lists and deletes them.

## Migration Plan

New store keys only, read by nothing older. Within a session, a reload into this version reads `saved-5` and older as having no loaded changes; a downgrade reads `saved-6` as unknown and starts fresh, the existing rule for shape changes. Rollback leaves saved replays in the store, unread and harmless, until a later version or the person removes them.
