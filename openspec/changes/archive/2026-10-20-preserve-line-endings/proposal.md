# Proposal

## Why

The recorder converts every file to LF before storing it, and mirror documents take whatever line ending VS Code defaults to. A CRLF file therefore replays as LF: the status bar shows the wrong line ending and the mirror no longer matches the real file. On Windows, where new documents can default to CRLF, the reverse also happens. The player's character offsets are worked out against LF text, so a mirror that ends up CRLF can place edits in the wrong spot.

## What Changes

- Each recorded change carries the line ending of the real file (LF or CRLF), captured when the change is recorded.
- Before typing a change, the player sets the mirror document's line ending to the one recorded for that change. CRLF files replay as CRLF and LF files as LF, whatever the VS Code default is.
- Edits land at the same positions whatever the mirror's line ending, so typed text, backspacing and selections in a CRLF mirror match the LF case.
- "Snap to latest" also applies the recorded line ending.
- Recorded before/after text stays LF-normalized, so planning and the planner's round-trip guarantee do not change.

## Capabilities

### New Capabilities

- `mirror-documents`: how the `agent-typewriter:` mirror documents represent the real files they replay, starting with line endings.

### Modified Capabilities

None. `typing-pace` is about speed and is not affected.

## Impact

- `src/planner.ts`: a pure helper that detects a text's line ending, next to `normalizeEol`.
- `src/recorder.ts`: snapshots keep each file's line ending, and every recorded event includes it.
- `src/timeline.ts`: `ChangeEvent` gains an `eol` field.
- `src/player.ts`: sets the mirror's line ending before each change, maps LF-based offsets to positions in the document, and compares text with line endings normalized.
- `test/`: unit tests for line-ending detection and offset mapping. `it/suite.ts`: a CRLF replay scenario.
