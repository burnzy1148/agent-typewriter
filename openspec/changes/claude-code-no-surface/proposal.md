# Proposal

## Why

Spike at-o3z.10 showed that a cloud session loads the plugin and records its edits, but no client attaches as a surface, so nothing can draw the pane there. `$.ui.open` says so: it resolves `{ isPlaced: false, reason: "no-surface: …" }`. The plugin ignores that answer. `/typewriter` replies "Agent Typewriter pane opened." and the automatic opening on the first change fails silently, so the person waits for a pane that will never appear and has no hint where it would.

## What Changes

- **`/typewriter` reports what `$.ui.open` answered.** When the pane is placed, the reply stays "Agent Typewriter pane opened." When the open resolves `isPlaced: false` with a reason starting `no-surface`, the reply says that nothing shows this session's panes, so the pane can't be shown here, and that it shows in a local session in the Claude Code desktop app or in VS Code. Any other unplaced answer gets the same pointer with the engine's reason in it, never "opened".
- **The automatic opening on the first change says when no surface can show the pane.** When that open resolves `no-surface`, the plugin adds one dim notice to the transcript (`$.ui.log`, not sent to the model) with the same words. An unplaced answer for any other reason (an unasked pane below the engine's width floor) stays silent, as today: the pane waits for `/typewriter`.
- **Nothing else changes.** The plugin still records in a session with no surface, and the pane stays open, so a surface that attaches later still draws it. Terminal-only sessions keep their pointer to the VS Code extension and never reach `$.ui.open`.
- **Docs.** `claude-code/README.md` says what `/typewriter` and the first change do in a cloud session or a `-p` run.

Out of scope:
- Making the pane draw in cloud sessions, on claude.ai/code, on mobile or for Remote Control viewers. That waits on the engine (at-o3z.24).
- Stopping recording where nothing draws. The README already says a `-p` run records but shows nothing; this change only says so to the person.
- Notifying through `$.ui.notify`, `$.ui.status` or a toast: each needs an attached surface, which is exactly what is missing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-replay`: two added requirements. `/typewriter` answers "opened" only when the pane is placed, and otherwise says where it can be shown. The first recorded change in a session with no surface adds one transcript notice saying the same. "Pane opens on request or on the first change" stays as written: `/typewriter` still opens the pane, which a surface that attaches later draws.

## Impact

- `claude-code/hooks/register.tsx`: `/typewriter` awaits and reads `$.ui.open`'s answer; the first-change open handles its answer without blocking the tool call and logs the notice on `no-surface`. `replay.ts` and the shared bundle (`core.mjs`) do not change.
- `claude-code/tests/`: `world.ts` lets a test choose `ui.open`'s answer and records `ui.log` lines; new tests in `pane.test.tsx` or `recording.test.tsx`.
- `claude-code/README.md`.
- People in cloud sessions, `-p` runs and SDK hosts see one dim line in the transcript (or a `ui_log` message in an SDK stream) when the first change is recorded.
