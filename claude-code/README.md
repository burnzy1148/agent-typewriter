# Agent Typewriter for Claude Code

Watch the edits Claude makes in your session replayed as human-like typing, in a pane beside the conversation. Each change is typed out from the file's old text to its new text: lines are deleted and retyped in steps, a new block gets its opening and closing lines before its body, and the pane follows the caret through the file.

This is the Claude Code edition of [Agent Typewriter](https://agent-typewriter.com), the VS Code extension. It uses Claude Code's plugin API for function hooks and panes, which is in early access and may change between Claude Code releases. It needs Claude Code 2.1.309 or later.

## Install

Until the plugin is merged into `develop`, it is only on the testers' branch, and the commands below fail with "Marketplace file not found". Use `burnzy1148/agent-typewriter#claude-code-extension` wherever this section says `burnzy1148/agent-typewriter`:

```bash
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#claude-code-extension
```

From a shell:

```bash
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter
```

That adds this repository as the `agent-typewriter` marketplace and installs the plugin for your user account. The desktop app, Claude Code's VS Code extension and the terminal share the plugins and marketplaces you add, so it doesn't matter which one you install from.

Without a shell:

- **VS Code:** type `/plugins` in the Claude Code panel to open **Manage plugins**, add `burnzy1148/agent-typewriter` on the **Marketplaces** tab, then install Agent Typewriter from the **Plugins** tab.
- **Desktop app:** once the marketplace is added, Agent Typewriter is in the plugin browser: click **+** next to the prompt box and choose **Add plugins** (or **Plugins**, then **Browse plugins**).

Agent Typewriter is made for the desktop app's local sessions and Claude Code's VS Code extension. A desktop app or phone attached to another session by Remote Control doesn't show its pane. In an interactive session in a terminal, the plugin stays out of the way: it records nothing and draws nothing, and `/typewriter` points you to the [Agent Typewriter extension for VS Code](https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter), which types out the same edits from disk. A `claude -p` run or an SDK script draws nowhere, so the plugin still records its edits, but nothing shows them; the first one logs a line saying the pane can't be shown there.

Use it in a local session. Cloud sessions (claude.ai/code, the mobile app, and the desktop app's cloud sessions) don't load plugins installed on your machine or turned on in a repository's settings. A cloud environment that loads it some other way, such as by naming its folder in `CLAUDE_CODE_PLUGIN_DIRS`, records the session's edits, but no client draws the pane for a cloud session yet. There, `/typewriter` answers that the pane can't be shown in this session and points you to a local session.

### Which version you get

The repository's branches are the plugin's channels:

- `burnzy1148/agent-typewriter` follows `develop`, the default branch: the plugin as it is merged, ahead of releases.
- `burnzy1148/agent-typewriter#main` follows released versions only. It has the plugin from the first stable release that includes it.
- `burnzy1148/agent-typewriter#claude-code-extension` is for testers until the plugin is merged into `develop`, as above.

Any branch that has the marketplace works the same way, such as a pull request's branch you want to try.

The plugin has no version number of its own: its version is the commit you installed, as `claude plugin list` shows it. Mention it when you report a problem.

### Updating

Claude Code doesn't update plugins from this marketplace by itself. To update now, from a shell:

```bash
claude plugin marketplace update agent-typewriter
claude plugin update agent-typewriter@agent-typewriter
```

Then start a new session. Every new commit on the branch you follow counts as an update, so some updates change nothing in the plugin.

To have Claude Code update it for you, turn on auto-update for the marketplace in a terminal session: run `/plugin`, open **Marketplaces**, select `agent-typewriter` and choose **Enable auto-update**.

### Switching branches

Every branch registers as the same `agent-typewriter` marketplace, so remove it before adding another. Removing it uninstalls the plugin and forgets its options.

```bash
claude plugin marketplace remove agent-typewriter
claude plugin install agent-typewriter --marketplace burnzy1148/agent-typewriter#main
```

## What it replays

- Every `Edit` and `Write` the session runs, including those its subagents run.
- Only changes that succeed. A refused or failed call is not replayed.
- Only this session's changes. Files changed by `Bash`, by other programs, or by you are not replayed, and nothing carries over to the next session.

The plugin never writes a file. It reads the file before the tool runs and again after.

Files larger than 1 MB are not typed: the pane names them and moves on. A change that adds more than 6,000 characters, such as a generated file, is shown finished at once instead of typed, as in the VS Code extension. Long deletions are selected for a beat, their lines drawn removed from when the caret reaches them, and go in one step; short ones are backspaced.

The pane types at the VS Code extension's pace, using the same code to decide each step: the rhythm varies a little, a new line's indent goes in at once, it lingers after line breaks and punctuation and now and then at the end of a line, and the caret rests a moment at each edit. The caret walks with arrow keys to a nearby edit on screen and jumps to a far one. Before the view leaves what was just typed, for an edit off screen or another file, it waits until 1.5 seconds have passed since the last keystroke, and a new file is shown for a second before its first edit. While changes are queued it speeds up: one and a half times with one waiting, up to eight times. Apart from the two options below, these use the extension's default settings.

## The pane

The pane opens by itself on the first change, where Claude Code can dock it beside the conversation, as in the desktop app. Anywhere else, run `/typewriter` to open it; in a terminal session it points you to the VS Code extension instead, and where nothing can show the pane, such as a cloud session, it says so and points you to a local session in the desktop app or VS Code.

It shows the file being typed (by its path in your project) and the change's number, the lines around the caret with line numbers and syntax highlighting, and whether playback is typing, paused or idle with how many changes are queued.

The code is drawn as a unified diff, marked as Claude Code draws diffs. Lines typed since the file's baseline are marked added, and lines of the baseline that are gone stay in view, marked removed. A file's baseline is the file as it was before the oldest change to it that the pane keeps. Marks are whole lines: a line with one word changed shows its old version removed and its new version added. Text added and later removed leaves no mark.

Over the code there is a tab for each file the followed lane has typed (see Lanes below), in the order it typed them, with the file on show in bold. Press a tab to look at that file as it was last typed while playback carries on elsewhere. A line above the code then says which file playback is in, with **Follow playback** to go back to it. Pressing the playback file's tab, or anything that moves playback, goes back too. If the tabs don't fit in two rows, the files typed longest ago are left out, and the row says how many.

### Lanes

When Claude starts subagents, the main conversation and each subagent that edits get a lane of their own, so their edits don't interleave. An agent a subagent starts gets its own lane too. Only one lane types at a time, the followed one; the others keep recording and queue. Each lane remembers where it is, so you can leave one and come back to it.

While more than one lane holds changes, a row of chips sits under the header, one per lane: **Main** for the main conversation, and each subagent by the description its `Agent` call gave (or its agent type, or **Subagent** when the plugin didn't see it start). Each chip has its lane's color, one of five that repeat past five lanes, and says what the lane is doing: typing or paused, how many changes are queued, or caught up. The followed lane's chip is selected; press another to follow that lane. The tabs, the marks and Clear marks are the followed lane's: following another lane shows its files, with its own marks. The header then begins with the followed lane, with a subagent's agent type in parentheses, the status counts the changes queued in the other lanes, and each subagent's row in the list names its lane. If the chips don't fit in two rows, the caught-up lanes are left out first, and the row says how many.

**Auto-follow**, at the end of the chip row, is on until you turn it off. Once the followed lane is caught up and nothing has been typed for 3 seconds, the pane follows the lane whose oldest queued change came first, so it tours the subagents' work after the main conversation's. It never leaves a change halfway. With it off, the pane stays where you put it, except that a subagent's lane that has finished and played out hands over to a lane still working. A reload keeps the lanes, where each one is, the followed lane and the switch.

Lanes are the agents of this one session. Other Claude Code sessions, and their worktrees, are not lanes: each session's plugin sees only its own calls.

Its buttons, with the key that presses each while the pane has the keyboard:

- **From start** (`r`): play every change again from the first one the pane keeps, every lane from its first.
- **Pause** / **Resume** (`p`): stop typing where it is, and carry on from there.
- **Finish current** (`f`): show the current change done and start the next one.
- **Skip to latest** (`l`): finish every queued change in every lane and show the followed lane's last one.
- **Clear marks**: make every file's text, as the followed lane has typed it, its baseline, so only later changes are marked. Other lanes keep their marks until you follow one and clear it too. A file being typed when you press it shows no marks until that change is done. Going back to a change from before you cleared, by pressing it or From start, brings the marks back. A reload keeps what you cleared.

Over the code, the pane quotes what Claude wrote just before the call that made the change, such as “Now I'll guard the login route.”, cut to three lines. It takes the words from the same response and the same agent, so a subagent's change shows the subagent's words, never the main conversation's. A call made right after another with no words between them shares that call's words, and a change Claude made without writing anything first shows none. Thinking is never shown, and the words are plain text, as the conversation keeps them.

Below them, the pane lists the session's changes: ✓ played, ▸ the current one, ○ queued, each with its number, the tool that made it, its path, and the lines it adds and removes. The current row says whether it is typing, paused or next, and a file too large to type reads Too large, then Not typed. Rest the pointer on a row to see the words before that change in a card above it. The list keeps the current change in view; scroll it to look back, and it stays where you put it until you press a change, a lane's chip, Play turn, Play from first, By turn or By file, From start, Finish current or Skip to latest.

**By turn** and **By file**, beside the list's title, choose how it is grouped. Your choice holds for the session, through a reload; it starts on By turn.

By turn, each turn of the main conversation that makes changes gets a chapter headed **Turn 4**, the prompt that started it on one line (its first 200 characters), how many of its changes the pane keeps, and **Play turn**. Turns are numbered in the order the plugin saw them start, counting turns that made no change and turns Claude starts on its own, such as after a background task finishes. A change a subagent made goes in the chapter of the turn that started the subagent, even when it lands after a later turn began. Changes the plugin can't place in a turn, such as ones saved by an older version, sit under **Outside a turn**, with **Play from first**. Turn numbers and prompts survive a reload.

By file, each file Claude changed gets a group headed by its name, its folder, how many of its changes the pane keeps, and **Play from first**. A group holds the file's changes in the order they were made, from every turn and subagent, and the groups come in the order of each file's first change the pane keeps, so the newest file is last. On Windows, paths that differ only in `\` or `/`, or in letter case, are one file.

Press a change to play from it: the pane follows its lane, it is typed next and the lane's later changes follow, other lanes stay where they are, and a pause stays a pause. While paused, the pane shows the file as it was before that change, so Resume types it from there, and Finish current shows it done. Play from first does the same from the file's first change the pane keeps: the changes after it in its lane follow whatever file they changed. Play turn replays the whole turn: every lane with a change in it goes back to its first change there, and the pane follows the lane of the turn's first change.

### When the pane is closed

Close the pane while something is still typing or queued, or leave it where Claude Code couldn't place it, and the desktop app shows a band just above the prompt instead: the file being typed and its change number, whether playback is typing or paused, and how many changes are queued, with **Pause** / **Resume**, **Skip to latest** and **Open pane**. Click the band (or press ctrl+x tab) and `p`, `l` and `o` press them. Typing in the prompt never does. The band goes away once the pane is back or nothing is left to play, and steps aside while Claude Code asks you a question there. VS Code has no band: Claude Code draws that spot only in the desktop app and the terminal, and the plugin draws nothing in the terminal.

From the first change on, the plugin also keeps one status entry under the prompt with the same words, such as `Agent Typewriter · typing limiter.ts #3 · 2 queued`, whether the pane is open or not; it reads `up to date` once playback catches up. A session that also runs in a terminal gets no status entry, since Claude Code shows it on every surface, the terminal's too.

### Back and forth with the conversation

**Show in conversation**, in the pane's header, scrolls the conversation to the `Edit` or `Write` call that made the change the pane shows; the ↗ beside each row of the list does the same for that change. For a change a subagent made, it goes to the subagent's call, or to the `Agent` call that started the subagent when the conversation doesn't show the subagent's own calls. If it can't scroll there, say because the call is no longer in the conversation, the list says so until your next press in the pane. Neither moves playback.

In the conversation, each `Edit` or `Write` call whose change the pane keeps has a chip under it naming the change and where playback is with it: **Replay #2** once it has played, **Typing #2** or **Paused #2** while it is typed, **Next #2** when you picked it while paused, **Queued #2** while it waits, and **Too large #2**, then **Not typed #2**, for a file too large to type. Press the chip to play from that change, as pressing its row does; it opens the pane if it is closed.

Once a turn has ended, the last row of the conversation that holds its work gets a **Play turn · 4 changes** chip too: the `Edit` or `Write` call of its last change, or the `Agent` call that started a subagent when the subagent's change comes last. Pressing it plays the turn, as Play turn does, and opens the pane. It sits there rather than on the turn's closing "Worked for" line because Claude Code draws that line only in the terminal.

## Options

Set them in `/config`:

| Option | Default | |
| --- | --- | --- |
| Typing speed (`charsPerMinute`) | 1000 | Characters per minute. |
| Natural authoring order (`naturalOrder`) | on | Type a new block's opening and closing lines before its body. Off types top to bottom. |

Changing an option reloads the plugin. It keeps the session's recorded changes, played and queued, and the change being typed starts over.

## Working on the plugin

To run your own checkout instead of an installed copy, from the repository root:

```bash
claude --plugin-dir claude-code
```

Then ask Claude to create or edit a file. For that session, the checkout takes the place of an installed Agent Typewriter. See [CONTRIBUTING.md](../CONTRIBUTING.md) for building, testing and type-checking the plugin.

## License

MIT, as for the rest of the repository. `hooks/core.mjs` includes the [diff](https://github.com/kpdecker/jsdiff) package (BSD-3-Clause).
