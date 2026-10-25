---
title: Session files
description: "Save recorded changes to a file and load them elsewhere for a demo or review."
---

Recorded changes are kept across reloads automatically (`persistHistory`). To take a run somewhere else, for a demo, another machine, or a reviewer, save it to a file:

- **Save Session to File...** writes every change in the buffer, with its before and after text, to a JSON file you pick. The dialog starts in your home folder. If you save into the watched workspace instead, the file itself is recorded as a change when it passes the filters.
- **Load Session from File...** replaces the buffer with a saved session (plain or gzip-compressed JSON), after asking if the buffer is not empty. Playback is paused at the first change, so resume when you are ready. If the session has more changes than `historyLimit`, you choose between raising the limit and loading the newest changes.

Both are in the panel's `...` menu. Loaded changes replay into mirror documents like any other; your real files are never written. A file saved by a newer version of the extension is refused with a message instead of being misread.
