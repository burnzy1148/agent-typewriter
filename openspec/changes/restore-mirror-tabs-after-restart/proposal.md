# Proposal

## Why

Mirror documents live only in memory, so after VS Code restarts every `agent-typewriter:` tab it restores shows "The editor could not be opened because the file was not found." The timeline itself is restored from workspace storage, but nothing rebuilds the mirror files from it, and the empty filesystem provider is registered and answering before the restore has even run.

## What Changes

- When the extension activates and restores the saved timeline, each recorded file's mirror is filled with the text it showed before the restart: the after text of its newest played change, or, when none of its changes were played yet, the before text of its earliest queued change. The recorded line ending is kept.
- The mirror filesystem holds back answers to `stat`, `readFile` and `readDirectory` until that rebuild is done, so a tab VS Code restores during activation never sees an empty filesystem.
- Mirror tabs that still have nothing behind them after the rebuild (history turned off, the file aged out of `historyLimit`, no folder open, or a damaged saved timeline) are closed instead of showing an error.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `mirror-documents`: adds how mirror tabs behave across a restart or reload: restored with their pre-restart text when the timeline has history for the file, closed otherwise.

## Impact

- `src/mirrorFs.ts`: a readiness gate on the read methods; a way to seed files without announcing a change.
- `src/timeline.ts`: a helper returning, per recorded path, the event and side (before/after) a mirror should show.
- `src/extension.ts`: seed mirrors after the history restore at activation, open the gate, then close orphaned mirror tabs.
- `it/restore.ts`, `it/suite.ts`: the reload launch checks a mirror tab left open is restored with its text; a launch with history off checks the tab is closed.
- No new settings or dependencies. The real files are still never written.
