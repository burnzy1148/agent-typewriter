## ADDED Requirements

### Requirement: Renames are labeled with both paths
A `rename` change SHALL be described with its old and new path wherever playback names a change: the Playback panel and mirror status row SHALL say `#<seq> <old> → <new>`, the changes tree SHALL show the new name with `renamed from <old>` and, when the text changed, its line counts, and Show Diff SHALL compare the old path's before text with the new path's after text.

#### Scenario: Rename queued next
- **WHEN** playback is paused before a rename from `src/a.ts` to `src/b.ts` with seq 7
- **THEN** the panel reads `Paused before #7 src/a.ts → src/b.ts`

#### Scenario: Rename in the changes tree
- **WHEN** the buffer holds a pure rename from `src/a.ts` to `lib/a.ts`
- **THEN** its tree item is named `a.ts` and its description says `renamed from src/a.ts`
