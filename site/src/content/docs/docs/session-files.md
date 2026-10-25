---
title: Session files
description: "Save recorded changes to a file and load them elsewhere for a demo or review."
---

Recorded changes are kept across reloads automatically (`persistHistory`). To take a run somewhere else, for a demo, another machine, or a reviewer, save it to a file:

- **Save Session to File...** writes every change in the buffer, with its before and after text, to a JSON file you pick. The dialog starts in your home folder. If you save into the watched workspace instead, the file itself is recorded as a change when it passes the filters.
- **Load Session from File...** replaces the buffer with a saved session (plain or gzip-compressed JSON), after asking if the buffer is not empty or you are watching. Loading stops watching, so live edits do not mix into the loaded changes. Playback is paused at the first change, so resume when you are ready. If the session has more changes than `historyLimit` or more change text than `historySizeMB`, you choose between raising the limits and loading the newest changes that fit.

Both are in the panel's `...` menu. Loaded changes replay into mirror documents like any other; your real files are never written. A file saved by a newer version of the extension is refused with a message instead of being misread.

A session keeps each change's lane (see [Lanes](/docs/lanes/)), so a run recorded from several checkouts loads with the same lanes, colors and followed lane, every change pending. Sessions are saved in format version 3; files from earlier versions load as a single lane. Versions of the extension before lanes refuse version 3 files, and a saved timeline written by this version is set aside if you downgrade.
