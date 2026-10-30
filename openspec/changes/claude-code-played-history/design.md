# Design

## Context

The plugin's deck (`claude-code/hooks/replay.ts`) holds its changes in the shared `Timeline`, on the default lane, plus the change being typed in `deck.playing`. The timeline keeps played changes behind its cursor and drops the oldest past 200 changes or 20,000,000 characters of text. Since the oldest are the played ones, played changes go first. A change being typed can outlive its place in the timeline: when 200 more are recorded behind it, the timeline drops it while `deck.playing` keeps typing it.

What reaches `$.state` (`claude-code/hooks/register.tsx`):

- `saved` (shape `saved-1`): `{ changes: [{ id, path, isTooLarge? }], recorded, isPaused }`, the change being typed first, then the waiting ones. `savedOf` builds it.
- `text` members `<id>:before` and `<id>:after`, written by `record()` before the change is queued. `flush()` writes `''` over the texts of every id that `liveIds` (being typed or waiting) no longer lists, so a played change's texts are cleared.
- `view`, what the pane draws.

`load()` reads `saved`, reads each change's texts, skips a change whose texts are gone or equal, and calls `restore()`, which pushes every change as waiting. `eventOf()` fills each event's `kind` with `'modify'` and `time` with `0`, because neither is saved. An atom whose `shape` tag differs from what is stored reads as its initial value, so a bumped tag drops the old state unless the plugin reads the old tag itself.

## Goals / Non-Goals

**Goals:**
- A reload rebuilds the same timeline: the played changes, played; the waiting ones, waiting; the change being typed, waiting at the front of them.
- Each event's `kind` and `time` are real, in memory and after a reload.
- `$.state` holds texts for exactly the changes the deck keeps.
- State saved under `saved-1` still loads.

**Non-Goals:**
- Showing played changes in a list, or seeking among them (at-o3z.3).
- Saving where a change being typed had got to. It starts over, as now.
- Keeping `delete` or `rename` kinds. `Edit` and `Write` only create or modify files.

## Decisions

### `saved-2` lists every kept change and counts the played ones

```ts
type SavedChange = { id: string; path: string; kind: 'create' | 'modify'; time: number; isTooLarge?: boolean };
type Saved = { changes: SavedChange[]; played: number; recorded: number; isPaused: boolean };
```

`changes` holds, oldest first, the timeline's played changes, the change being typed, and the waiting ones. `played` says how many lead the list as played. On one lane, the cursor splits the timeline into a played prefix and the rest, so a count is enough, and it matches how `Timeline.restore` maps a cursor by position.

The change being typed comes from `deck.playing`, so it is saved even after the timeline has dropped it, as `saved-1` did. Because the timeline drops from the oldest end, by then it has dropped every played change too, so the list stays in order.

Alternatives:
- **A `played` flag on each change.** Rejected: a count cannot describe an order the timeline cannot hold, such as a played change after a waiting one.
- **Saving the timeline's seqs and cursor.** Rejected: seqs are fresh on every reload (`Timeline.restore` renumbers them), so saving them only adds a mapping step.

### Texts are cleared when a change leaves `saved`

`flush()` computes the next `saved` first. Every tracked id that it no longer lists gets `''` written over its texts. Then `saved` and `view` are written, as now. A played change keeps its texts until the timeline drops it. `liveIds` has no use left in the plugin and goes, with its unit tests rewritten on `savedOf`.

Clearing comes before writing `saved`, as now. If a reload falls between the two, the old `saved` still names the cleared change, and `load()` skips it because its texts are equal. The other order could leave texts that no `saved` names, which nothing would ever clear.

### `record()` captures kind and time

The kind is `'create'` when the file did not exist when the call started, too large or not, and `'modify'` otherwise, a `Write` over an existing file included. An existing empty file is modified, not created. The time is `$.clock.now()` read once the tool has finished and the after text is read, the moment the change is recorded, in epoch milliseconds as `ChangeEvent.time` is. `Change` carries both, `eventOf()` copies them onto the event, and `changeOf()` reads them back.

### `restore()` rebuilds the cursor and what the pane shows

`restore(saved, changes, opts, cwd?)` pushes the loaded changes in order. A change is played when its id is among the first `saved.played` ids of `saved.changes`. Because `changes` keeps the saved order, the played ones are a prefix of it. The cursor is then set past them with `Timeline.seek`, or `seekToEnd` when all of them played. The limits grow to hold every loaded change, as now, and shrink back at the next `enqueue`.

When at least one restored change has played, `shown` is the last one done: its after text, with the caret where `skipToLatest` would leave it, or the too-large note. `opts` is needed to plan that caret in natural order. The pane then keeps showing the last change after a reload, as the "Pane names the file" requirement asks of an idle pane. The first tick replaces it when a change waits.

### `saved-1` is read by its tag

`register.tsx` keeps the `saved` atom, tagged `saved-2`, for writes. `load()` reads the stored value with `$.state.get` and passes it to `savedFrom()` in `replay.ts`:

- under `saved-2`, the value as stored;
- under `saved-1`, every change waiting (`played: 0`), each a `'modify'` at time `0`, since `saved-1` kept neither kind nor time;
- under any other tag, or nothing, an empty `Saved`.

The texts under `saved-1` are the same `text` members, so they load unchanged.

Alternative: bump the tag and let old state drop. Rejected: a tester who updates the plugin mid-session would lose their queued changes.

## Risks / Trade-offs

- **More of `$.state` used.** Played texts stay until the timeline drops them, so `$.state` can hold 20,000,000 characters of text, played or waiting, where before it held the waiting ones only. The in-memory timeline already held them. → The limit is unchanged. Each text member stays under the engine's 4,194,304-character value cap, since a file over 1,000,000 bytes keeps no text.
- **A played change whose texts are lost is skipped on reload.** That happens only if a write failed. → As for waiting changes now, the rest of the history loads.
- **A `saved-1` change's time is `0`.** → Only a reload across this update has them, and only for changes recorded before it. Readers of `time` (at-o3z.12) must treat `0` as unknown.

## Migration Plan

`saved-1` state loads through `savedFrom()`. The next `flush()` writes it back as `saved-2`. Rolling back to a build that knows only `saved-1` drops `saved-2` state at its next reload, which is what a tag bump does. The plugin is in early access on the `claude-code-extension` branch.

The `saved-1` reader can go once no session that saved under `saved-1` can still reload, which is any time after this ships to `develop` (at-o3z.11).
