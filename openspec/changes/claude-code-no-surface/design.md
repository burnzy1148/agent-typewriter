# Design

## Context

`claude-code/hooks/register.tsx` opens the pane in two places:

- `/typewriter` (`command.run`): after the terminal-only check it awaits `$.ui.open({ id: PANE, title: TITLE })`, ignores the answer and returns `{ text: 'Agent Typewriter pane opened.' }`.
- `record`, on the session's first recorded change: `void $.ui.open(...)`, answer ignored. A rejection would go unhandled.

What the engine says (the 2.1.309 types laid in `claude-code/.claude-plugin/types/`, checked on 2.1.312 by spike at-o3z.10):

- `$.ui.open` resolves `UiOpenResult`: `{ isPlaced: true }` or `{ isPlaced: false, reason: string }`. `reason` is free text, not a closed set. The types name three families: the width floor an unasked pane fell under (144 columns, 110 for an id the person opened before) with the width now; attached surfaces that place no panes; and, starting `no-surface` (`$.ui.copy`'s word), that no surface is attached at all, as in every `-p` run and in a session until a page attaches. Only the `no-surface` prefix is a stable token.
- An unplaced pane stays open. When a surface attaches, `session.attach` is raised and a surface that places panes asks the pane's `ui.render`, so it draws without a second open.
- An asked open (a command the person typed) is placed at any width, so `/typewriter` never meets the width floor.
- The spike's cloud session answered `isPlaced false "no-surface: no surface is attached"`, `$.session.surfaces()` stayed `[]`, and no client ever attached.
- `$.ui.notify`, `$.ui.status` and toasts need a surface; `$.ui.notify` itself answers `no-surface` without one. `$.ui.log(text)` appends a dim transcript row that is not sent to the model; a `-p` or SDK host receives it as a `ui_log` message, and the debug log keeps it either way.

## Goals / Non-Goals

**Goals:**
- `/typewriter` never claims the pane opened when it did not.
- A person in a cloud session learns once, unasked, that the pane can't be shown there and where it can.
- Desktop app, VS Code and terminal-only behaviour does not change.

**Non-Goals:**
- Drawing anywhere new (at-o3z.24).
- Changing what is recorded where no surface is attached.
- Telling the person about an unasked pane waiting under the width floor; that is the existing "waits for `/typewriter`" behaviour.

## Decisions

### One message for both places

A constant `NO_SURFACE` next to `TERMINAL_POINTER`:

> Agent Typewriter can't show its pane in this session: no app is showing it here. Cloud sessions, claude.ai/code and the mobile app don't draw plugin panes. To watch Claude's edits typed out, use a local session in the Claude Code desktop app or in VS Code.

The implementer may tighten the wording, keeping: that the pane can't be shown here, and the pointer to a local desktop-app or VS Code session. It does not promise the pane will appear later, though the pane stays open and would draw if a surface attached.

### `/typewriter` branches on the answer

```ts
const opened = await $.ui.open({ id: PANE, title: TITLE });
if (opened.isPlaced) return { text: 'Agent Typewriter pane opened.' };
if (opened.reason.startsWith('no-surface')) return { text: NO_SURFACE };
return { text: `Agent Typewriter can't show its pane here (${opened.reason}). ${POINTER}` };
```

where `POINTER` is the "use a local session…" sentence shared with `NO_SURFACE`. The fallback covers attached surfaces that place nothing (none known today) and any reason a later engine adds, without claiming the pane opened.

Alternative: treat every unplaced answer as no-surface. Rejected: an attached surface that places nothing is a different situation, and the engine's reason says which surface it is.

### The first-change open logs once on `no-surface`

```ts
if (isFirst) void $.ui.open({ id: PANE, title: TITLE }).then(
  (opened) => { if (!opened.isPlaced && opened.reason.startsWith('no-surface')) $.ui.log(NO_SURFACE); },
  () => undefined,
);
```

It stays fire-and-forget, so the tool call is never held up by the open, and the rejection handler closes today's unhandled-rejection gap. "Once" comes from `isFirst` (`deck.recorded === 0`): after a reload `recorded` is restored, so a reloaded session does not repeat the notice.

Alternatives:
- **`$.ui.notify`, `$.ui.status`, a toast**: rejected; none reaches anyone without a surface.
- **`$.session.append` a user-role row**: rejected; it puts text in the conversation the model reads.
- **Log on every unplaced answer**: rejected; an unasked pane under the width floor is normal and today stays quiet.
- **Skip the notice when `session.start`'s `isInteractive` is false (`-p`, SDK)**: rejected for now. Whether a cloud session reports itself interactive is unknown (open question below); gating on it could silence the very case this change is for. The cost in `-p`/SDK is one `ui_log` message per session, which text output does not print.

### Tests

`claude-code/tests/world.ts` already hooks `ui.open` and answers `{ isPlaced: true }`. It gains a field the test can set to the answer (default placed), and a `ui.log` hook beneath that records each line into `logs`. New tests:

- `/typewriter` with `{ isPlaced: false, reason: 'no-surface: no surface is attached' }` and surfaces `[]`: the answer is `NO_SURFACE`, contains no "opened", and `opens` holds the pane id (it stays open).
- `/typewriter` with another unplaced reason: the answer holds the reason and the pointer, no "opened".
- `/typewriter` placed: unchanged answer (existing test).
- First Edit with surfaces `[]` and a `no-surface` answer: the change is recorded and `logs` holds `NO_SURFACE` once; a second Edit adds nothing.
- First Edit with an unplaced width-floor reason: recorded, `logs` empty.
- `ui.open` rejecting on the first change: the tool result is unchanged and recording goes on.

## Risks / Trade-offs

- [The `no-surface` prefix is the engine's wording, not a typed enum] → The types say an unplaced reason "starts `no-surface`" and the spike saw it; if the engine changes it, `/typewriter` falls back to the generic message with the reason, which is still honest, and the first-change notice goes quiet. A test pins the prefix.
- [Cloud clients may not show `ui.log` rows] → The spike checked `$.ui.open` and `$.ui.scroll` in a cloud session, not `$.ui.log`. If claude.ai/code does not render plugin log rows, the first-change notice is lost there, but `/typewriter`'s reply (a command result) still reaches the person. Checking this needs a cloud session with the plugin loaded through `CLAUDE_CODE_PLUGIN_DIRS`; see the last task.
- [`-p` and SDK hosts get a `ui_log` message] → One per session, dim, not sent to the model, and only when the plugin is loaded in such a run.

## Open Questions

- Does a cloud session's client (claude.ai/code, the desktop app's cloud view, mobile) show `$.ui.log` rows? Untested; the implementer checks in a cloud session if one is at hand, else records it on at-o3z.24.
- Does `session.start` report `isInteractive: true` in a cloud session? Only matters if `-p` noise turns out to bother anyone.
