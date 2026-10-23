## ADDED Requirements

### Requirement: Renames are recorded as one change
When a recorded file is deleted and a recorded file is created with matching content while the first of the two is still held for reordering, the recorder SHALL record one change of kind `rename` instead of a delete and a create. The change SHALL name the new path, carry the old path, and keep the deleted text as its before text and the created text as its after text, both captured when the change is recorded. A create SHALL also pair with a delete held in a chosen worktree.

#### Scenario: Plain rename
- **WHEN** an agent renames `src/a.ts` to `src/b.ts` without changing it
- **THEN** the buffer gets one `rename` change from `src/a.ts` to `src/b.ts` whose before and after text are the file's text

#### Scenario: Rename with an edit
- **WHEN** an agent moves `src/a.ts` to `lib/a.ts` and changes one of its ten lines
- **THEN** the buffer gets one `rename` change whose before text is the old file and whose after text is the new file

#### Scenario: Rename in a chosen worktree
- **WHEN** a sibling worktree is chosen and an agent renames a file in it
- **THEN** the buffer gets one rename under the worktree's label, not a held delete and a create

### Requirement: Rename matching
Content SHALL match when it is identical, or when both texts are non-empty and at least half of the larger file's lines are unchanged. An identical match SHALL be preferred over a near one, then a file with the same name, then the nearest in write time. Only a create from nothing SHALL pair with a delete to nothing, and only changes the filters record SHALL pair.

#### Scenario: Unrelated files
- **WHEN** an agent deletes `src/a.ts` and creates `src/c.ts` with different content in the same moment
- **THEN** the buffer gets a delete of `src/a.ts` and a create of `src/c.ts`

#### Scenario: Directory move
- **WHEN** an agent moves directory `src/util/` holding `x.ts` and an empty `index.ts` to `src/lib/`, next to another empty file being created
- **THEN** each moved file is one rename to its new path, and the empty `index.ts` pairs with `src/lib/index.ts`

#### Scenario: Moved across the filters
- **WHEN** the filters record `*.ts` and an agent renames `notes.txt` to `notes.ts`
- **THEN** the buffer gets a create of `notes.ts`
- **AND** renaming `notes.ts` back to `notes.txt` records a delete of `notes.ts`


#### Scenario: Atomic replace
- **WHEN** an editor saves an existing file by writing a temporary file and renaming it over the original
- **THEN** the change to the original is recorded as a modify, as before
