// Wires playback (replay.ts) to Claude Code: records the session's Edit and
// Write calls, ticks the deck on a timer, and draws the pane. The plugin only
// reads files; it never writes one.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import {
  MAX_REPLAY_BYTES,
  TICK_MS,
  emptyDeck,
  enqueue,
  finish,
  playOptions,
  relativePath,
  skipToLatest,
  tick,
  togglePause,
  windowAround,
  type Change,
  type PlayOptions,
} from './replay';

const PANE = 'agent-typewriter';
const TITLE = 'Agent Typewriter';
const TOO_LARGE = Symbol('too large');

// Change the tag when Deck's fields change: a reload then starts fresh
// instead of reading what an earlier version stored.
const deck = atom({ plugin: 'agent-typewriter', key: 'deck' } as const, emptyDeck, { shape: 'deck-2' });

/** A file's text, TOO_LARGE past the replay limit, or undefined when it does not exist. */
async function snapshot($: EngineInterface, path: string): Promise<string | typeof TOO_LARGE | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined);
  if (!stat) return undefined;
  if (stat.size > MAX_REPLAY_BYTES) return TOO_LARGE;
  return $.fs.read(path);
}

/** Runs a file tool, reading "before" when the call starts and "after" once it succeeded. */
async function record<R extends { deny?: string; isError?: boolean }>(
  $: EngineInterface,
  path: string,
  id: string,
  run: () => Promise<R>,
): Promise<R> {
  const before = await snapshot($, path);
  const ran = await run();
  if (ran.deny !== undefined || ran.isError) return ran;
  const after = await snapshot($, path);
  if (after === undefined) return ran;
  const change: Change =
    before === TOO_LARGE || after === TOO_LARGE
      ? { id, path, before: '', after: '', isTooLarge: true }
      : { id, path, before: before ?? '', after };
  let isFirst = false;
  await update($, deck, (d) => {
    const next = enqueue(d, change);
    isFirst = d.recorded === 0 && next !== d;
    return next;
  });
  // Unasked, the engine places the pane only where it docks beside the
  // conversation; elsewhere it waits for /typewriter.
  if (isFirst) void $.ui.open({ id: PANE, title: TITLE });
  return ran;
}

/** One timer tick: writes the deck only when playback moved. */
async function step($: EngineInterface, opts: PlayOptions): Promise<void> {
  const now = await read($, deck);
  if (tick(now, opts) !== now) await update($, deck, (d) => tick(d, opts));
}

export const register: Register = (on, options) => {
  const opts = playOptions(options);
  let cwd: string | undefined;

  on('session.start', async ($, e, next) => {
    cwd = e.cwd;
    await $.command.register({ name: 'typewriter', description: 'Open the Agent Typewriter pane' });
    $.clock.every(TICK_MS, () => void step($, opts));
    return next(e);
  });

  on('command.run', { command: 'typewriter' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE });
    return { text: 'Agent Typewriter pane opened.' };
  });

  // A failure while recording never blocks the tool: the handler runs it, or
  // hands back the result it already has.
  on('tool.call', { tool: 'Edit' }, ($, e, next) => record($, e.file_path, e.tool_use_id, () => next(e))).catch(
    ($, e, next) => next(e),
  );
  on('tool.call', { tool: 'Write' }, ($, e, next) => record($, e.file_path, e.tool_use_id, () => next(e))).catch(
    ($, e, next) => next(e),
  );

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e);
    const d = await read($, deck);
    const shown = d.shown;
    const isTyping = d.playing !== undefined;
    const status = d.isPaused ? 'paused' : isTyping ? 'typing' : 'idle';
    const queued = d.queue.length > 0 ? ` · ${d.queue.length} queued` : '';
    const rows = Math.max(3, (e.props.scroll?.bodyRows ?? 24) - 3);
    const view = shown && !shown.isTooLarge ? windowAround(shown.text, shown.caret, rows, isTyping) : undefined;
    const name = shown ? relativePath(shown.path, cwd) : undefined;

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{name ?? 'No changes yet'}</Text>
          <Text dimColor>
            {status}
            {queued}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="pause" onPress={() => update($, deck, togglePause)}>
            {d.isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button key="finish" onPress={() => update($, deck, finish)}>
            Finish current
          </Button>
          <Button key="skip" onPress={() => update($, deck, (x) => skipToLatest(x, opts))}>
            Skip to latest
          </Button>
        </Box>
        {view ? (
          <Code source={view.source} path={shown!.path} startLine={view.startLine} />
        ) : shown?.isTooLarge ? (
          <Text>{name} is too large to replay.</Text>
        ) : (
          <Text dimColor>Edits Claude makes with Edit or Write are typed out here.</Text>
        )}
      </Box>
    );
  });
};
