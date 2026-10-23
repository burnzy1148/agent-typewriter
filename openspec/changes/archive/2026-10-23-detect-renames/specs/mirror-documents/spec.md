## ADDED Requirements

### Requirement: A rename moves the mirror document
Playing a `rename` change SHALL show the old path's mirror with the change's before text, then open the new path's mirror with that text in the same column, close the old mirror's tabs, and remove the old mirror document. Any difference between the before and after text SHALL then be typed into the new mirror like a modify. Real files SHALL NOT be touched.

#### Scenario: Plain rename plays
- **WHEN** a rename from `src/a.ts` to `src/b.ts` plays
- **THEN** the `src/b.ts` mirror shows the file's text, and no tab or mirror document for `src/a.ts` remains

#### Scenario: Rename with an edit plays
- **WHEN** a rename whose after text adds a line plays
- **THEN** the mirror moves first and the added line is then typed into the new mirror

### Requirement: Renamed-away mirrors stay gone
Skipping to latest and refilling mirrors after a reload SHALL leave no mirror at a path whose newest change renamed it away.

#### Scenario: Skip to latest past a rename
- **WHEN** a rename from `a.ts` to `b.ts` is queued and the user skips to latest
- **THEN** the `b.ts` mirror shows the after text and no `a.ts` mirror remains

#### Scenario: Played rename across a reload
- **WHEN** a rename from `a.ts` to `b.ts` was played and the window is reloaded with both names' tabs restored
- **THEN** the `b.ts` tab shows the after text and the `a.ts` tab is closed

#### Scenario: Queued rename across a reload
- **WHEN** a rename from `a.ts` to `b.ts` is queued and the `a.ts` mirror tab is open across a reload
- **THEN** the `a.ts` tab shows the rename's before text, and resuming playback moves it to `b.ts`
