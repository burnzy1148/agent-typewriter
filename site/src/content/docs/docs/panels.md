---
title: The panels
description: "The Playback panel, the replay editor controls, and the list of recorded changes."
---

Agent Typewriter has its own icon in the Activity Bar, with three views: **Checkouts**, **Changes** and **Playback**. (They used to sit in the Explorer; drag them back there if you prefer.)

**Playback** controls replay like a media player:

- Replay from the start, play/pause, finish the current change instantly, skip to the next change, skip to latest, and clear highlights.
- Drag the slider to any recorded change and let go to seek there. Seeking keeps playback paused or playing as it was; the far end of the slider skips to latest.
- The speed picker sets a multiplier (0.5x to 5x) on top of the base speed.
- The line under the slider shows what is typing or next, and how many changes are queued. With several [lanes](/docs/lanes/), the slider covers the followed lane, whose name leads the line.

**The replay editor** has controls too, on the tab of the file being typed (or played last):

- Its title bar has the same buttons: replay from the start, play/pause, finish current, skip to next, and skip to latest, plus clear highlights in this file while it has any. Right-click the title bar to hide any of them.
- A row above the first line has play/pause, finish, next, latest, the speed (click to change it), and what is typing or next with the position in the buffer (click to open the Playback panel). The row is not part of the text. Set `mirrorStatusRow` to `false` to hide it, for example for screen recordings.

**Changes** lists recorded changes, newest first, with their state (pending, typing, played) and line counts. With several lanes in the buffer, each lane gets a node in its color holding its changes, the followed lane first.

- Click an entry to see its diff.
- Inline **Replay From Here** restarts playback at that change.
- Title bar: start/stop watching. The `...` menu has filters, base speed, and clear. Pause, finish current, skip to latest, and replay all are also commands in the Command Palette.
