# Design

## Context

See proposal.md for why. This change is designed against at-o3z.13's `claude-code-turn-chapters` (on `claude/at-o3z-13-chapters-39cf87`, being implemented) and lands after it. What it builds on, once at-o3z.13 is in:

- `listingOf(deck)` in `replay.ts` builds the `listing` atom (`listing-3`): `Row`s oldest first, each with its absolute `path`, `mainTurnId` and `agentCallId`, plus `dropped`, `current` and `isPaused`.
- at-o3z.13's `chaptersOf(listing, turns)` groups rows into `Chapter`s, and the pane draws the list as a run of *lines*: the dropped note, then per chapter a header line and its rows. `listWindow`, `ListGeometry` and `scrolledTop` count lines. Its design says at-o3z.27 adds a second grouping that returns the same kind of thing, so the pane draws whichever a switch picks.
- The `Changes` line is a `Box` holding bold `Changes` and a dim hint (`Pick a change to play from it`, or `live.note`).
- `relativePath(path, cwd)` names a file as the pane names it, and `rowLabel` cuts a row's folder before its file name.
- The engine's `Button` takes `variant: 'primary' | 'secondary'`, drawn as the surface marks the main action; `plain` overrides it. It has no pressed or selected state of its own.

The mockup (Main board, `viewTurn` / `viewFile`; ChangesList board, "By file") draws the switch as a two-button segmented control on the `Changes` line, and builds By file groups as: paths in order of first appearance, each with its rows in recorded order, title the file name, sub the folder, a count, and `Play from first` that picks `rows[0]`.

## Goals / Non-Goals

**Goals:**
- Group by file as a pure function of the listing, beside `chaptersOf`, so the pane's line model, window and scrolling serve both groupings unchanged.
- Leave recording, `saved`, `listing`, playback and the conversation's chips alone.

**Non-Goals:**
- A shared abstraction over every future grouping. Two groupings, one switch.
- Sticky group headers, collapsing, or other sort orders.
- Rows drawn differently by file (for example without their path). The bead asks for the same rows.

## Decisions

### Group by the recorded path, ordered by first kept change

`fileGroupsOf(listing)` walks `listing.rows` once, keyed by `row.path` exactly as recorded (absolute, from the tool call's `file_path`). Each group holds its rows in listing order, and groups come in the order their first row appears. The change being typed after the timeline dropped it is already the listing's first row, so it falls in its file's group with no special case.

Ordering by first kept change matches the mockup and at-o3z.13's chapters, and keeps groups still while the session runs: a new change to an existing file adds a row inside its group, and only a file touched for the first time adds a group, at the end. "Newest file last" means the file first touched most recently.

Alternatives:
- Order by each file's latest change, so the file Claude touched last is at the bottom. Rejected: every edit would move a whole group to the end while the person reads, and Play from first on a moving target is harder to hit. The current row stays in view either way.
- Sort by path. Rejected: loses the session's order, which is what the list is for.
- Normalize paths (case, separators, symlinks) before grouping. Rejected for now: the recorder keys files by the path the tool used, and before and after texts follow that path; two spellings of one file are already two lines of history. See Risks.

### Shapes in `replay.ts`

```ts
type FileGroup = { path: string; rows: Row[] };          // rows in recorded order, never empty
fileGroupsOf(listing: Listing): FileGroup[]
fileHeaderLabel(group: FileGroup, name: string, width: number):
  { file: string; dir: string; count: string }           // name = relativePath(group.path, cwd)
```

`fileHeaderLabel` splits `name` at its last separator as `rowLabel` does, writes `1 change` / `<n> changes`, and cuts the folder first with `…`, then the file name, so the count and the button always fit. The count's wording is the same function at-o3z.13's `headerLabel` uses; if it has none to share, both use one small `countLabel(n)`.

The pane turns either grouping into the same line items: a header line (`{ kind: 'header', key, … }`) followed by row lines. Where at-o3z.13 builds its line list from chapters, this change adds the branch that builds it from file groups. Keys: a file header's Play button is `play-file:<path>`, distinct from at-o3z.13's `play:<turn key>`, so a surface never confuses the two after a switch.

### Play from first is a seek

Pressing it calls `seek(deck, group.rows[0].id)` through the same `move` path a row press uses, and clears `live.listTop` so the list follows again. Later changes of every file follow in recorded order because that is what a seek does; playing one file alone would need a filtered queue the timeline does not have, and the mockup's `pick(rows[0])` is a plain seek too.

### The switch: two Buttons on the `Changes` line

`Changes`, then `By turn` and `By file`, then the hint. The chosen one is `variant="primary"`; the other is `variant="secondary"` with `dimColor`. Neither is `plain`, since `plain` ignores `variant`. Each has a `label` that names the state for a screen reader: `By turn, shown` / `Group by turn`, and likewise for file. Keys `group:turn` and `group:file`. Pressing the chosen one does nothing; pressing the other saves the choice, clears `live.listTop` and invalidates the pane.

No hotkey. Tab reaches both buttons before the list's.

The buttons show only when the list does (`count > 0`), as the `Changes` line does today.

### The choice in a saved `grouping` atom

`grouping` (shape `grouping-1`), value `'turn' | 'file'`, initial `'turn'`. The pane reads it when drawing; the switch writes it. It is one string the person sets by hand, so it needs none of the load-merge queue `agents` and `turns` use: nothing records into it, and a write during the load just wins.

Alternatives:
- Module memory only. Rejected: a reload (a plugin update, `/reload-plugins`) would flip the list back to By turn under the person.
- A field in `saved` or `view`. Rejected: `saved` is rewritten on every playback change and has a shape migration path of its own; `view` changes on every tick.
- A `/config` setting. Rejected: it is a view choice the person flips while watching, not a preference they set once, and the mockup puts it on the list.

### What stays the same

The current row, the dropped note's place (first line), the window centering on the current row's line, scrolling, the transport and its hotkeys, Show in conversation, and both conversation chips. at-o3z.13's Play turn chip plays a turn whatever grouping the pane shows.

## Risks / Trade-offs

- [Two spellings of one file (`/w/src/A.ts` and `/w/src/a.ts` on a case-insensitive disk, or a symlinked folder) make two groups] → rare in practice, since Claude reuses the path it read; the rows still play correctly. Normalizing is a later change if the desktop check shows it.
- [Groups ordered by first change mean a file edited again much later gets its new row in the middle of the list] → the list keeps the current row in view, and the row's number shows where it falls in the session.
- [By file shows a file's history with gaps: Play from first plays the other files' changes in between] → that is the seek's meaning everywhere in the pane; the proposal keeps one-file playback out of scope.
- [The switch takes width on the `Changes` line, leaving less for the hint and `live.note`] → the hint is dim and may be cut; the buttons and the title come first.
- [at-o3z.13's line model or names change in its review] → this change's implementation follows what at-o3z.13 lands; the decisions above do not depend on its exact names.

## Migration Plan

`grouping` absent reads as `'turn'`, so a session upgraded mid-way shows what at-o3z.13 shows. Rolling back ignores the atom. No shape of `saved` or `listing` changes.

The delta spec modifies requirements at-o3z.13 adds (*The changes list is grouped by turn*) and rewrites, so this change is archived only after `claude-code-turn-chapters` is archived; `openspec validate` already reports that archive would refuse it before then. Before implementing, rebase onto `claude-code-extension` with at-o3z.13 merged and check the MODIFIED blocks still match its archived text.

## Open Questions

- Whether a desktop surface draws a `primary` / `secondary` pair so the selected button is clear enough. If not, the selected one can add a leading `●` without changing the specs. at-o3z.28's desktop check should look.
