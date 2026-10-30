# Proposal

## Why

Installing the Claude Code plugin turns it on in every local session, terminal ones included, and today it records each edit and draws its pane in a wide terminal. The maintainers decided in the at-o3z.8 mockup that the plugin has no terminal experience: people who run Claude Code in a terminal replay with the Agent Typewriter extension for VS Code, which types the same edits from disk. Spike at-o3z.10 then showed that Remote Control viewers of a terminal session draw nothing, so a terminal session can show the pane nowhere but the terminal itself. Recording there only costs file reads and stored text that nothing will ever show.

## What Changes

- **A session that draws only in a terminal is left to the extension.** When every surface the session draws on is the terminal, the plugin records no change (it reads no file and stores no text), never opens its pane, and `/typewriter` answers with a line pointing to the VS Code extension.
- **Nothing is drawn on the terminal surface.** If a session draws on the terminal and on another surface at once, the plugin records and draws as usual on the other surface, and its pane's render passes through on the terminal.
- **The pane's surfaces are the desktop app and VS Code.** The "Replay pane" requirement drops the terminal. "Opening the pane" drops the wide-terminal case and its "Narrow terminal" scenario.
- **Sessions with no surface at all are unchanged.** In a `-p` run, an SDK host or a cloud session, the plugin still records, as a surface may attach later. Saying that no surface can show the pane is at-o3z.23.
- **Docs.** `claude-code/README.md` stops saying the plugin is on in the terminal and that the pane docks in a wide terminal. It says what a terminal session does instead.

Out of scope:
- Telling the person when no surface can show the pane, in cloud and `-p` sessions (at-o3z.23).
- The mobile surface (at-o3z.24).
- Bands, status entries and tool-row marks. The plugin has none yet; the beads that add them (at-o3z.12 to at-o3z.21) follow the new requirement.
- The VS Code extension, which needs no change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: "Session edits are recorded" gains the exception for terminal-only sessions; "Replay pane" and "Opening the pane" lose the terminal ("Opening the pane" is replaced by "Pane opens on request or on the first change", because a MODIFIED block cannot drop its "Narrow terminal" scenario). A new requirement says what a terminal session does: no recording, no pane, and a `/typewriter` answer that points to the extension.

## Impact

- `claude-code/hooks/register.tsx`: a check of the session's surfaces before recording, before opening the pane and in `/typewriter`, and a pass-through in the pane's render for the terminal surface. `replay.ts` and the shared bundle do not change.
- `claude-code/tests/`: the pane tests stop expecting a drawing on the terminal surface, and new tests cover terminal-only and mixed sessions. `world.ts` answers `$.session.surfaces()`.
- `claude-code/README.md`.
- The change edits the same file as PR #82 (at-o3z.5), so it is built on `claude-code-extension` after #82 merges.
- Users who run the plugin in a terminal today lose the pane there, and `/typewriter` points them to the extension.
