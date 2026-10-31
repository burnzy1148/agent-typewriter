// Wires playback (replay.ts) to Claude Code: records the session's Edit and
// Write calls, ticks the deck on a timer, and draws the pane. The plugin only
// reads files; it never writes one. A session that draws only in a terminal is
// left to the VS Code extension: nothing is recorded or drawn there.
//
// The deck lives in module memory. Hooks, the timer and button handlers run in
// this one module, one at a time, so they change it directly. $.state keeps
// only what must outlive a reload (`saved`, and each kept change's texts in
// the `text` family) and what the pane draws (`view`, and the changes list in
// `listing`, which changes far less often).

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import { normalizeEol } from './core.mjs';
import {
  MAX_REPLAY_BYTES,
  SAVED_SHAPE,
  TICK_MS,
  enqueue,
  finish,
  frame,
  isUnchanged,
  listWindow,
  listingOf,
  newDeck,
  playOptions,
  relativePath,
  replayFromStart,
  restore,
  rowLabel,
  savedFrom,
  savedOf,
  seek,
  skipToLatest,
  tick,
  togglePause,
  viewOf,
  type Change,
  type Deck,
  type NewChange,
  type PlayOptions,
  type Tool,
} from './replay';

const PANE = 'agent-typewriter';
const TITLE = 'Agent Typewriter';
const TERMINAL_POINTER =
  "Agent Typewriter for Claude Code doesn't replay in the terminal. To watch Claude's edits typed out, use the Agent Typewriter extension for VS Code (https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter), or run Claude Code in the desktop app.";
/** Columns the Code element's line-number gutter takes. */
const GUTTER = 8;
/** Columns a row keeps free of its label, for a desktop's button padding. */
const ROW_MARGIN = 4;
/** The share of the body's rows the changes list may take. */
const LIST_SHARE = 0.4;

// Change a tag when its value's fields change: a reload then starts fresh
// instead of reading what an earlier version stored. `saved` reads its earlier
// tag through savedFrom.
const savedRef = { plugin: 'agent-typewriter', key: 'saved' } as const;
const saved = atom(savedRef, savedOf(newDeck()), { shape: SAVED_SHAPE });
const view = atom({ plugin: 'agent-typewriter', key: 'view' } as const, viewOf(newDeck()), { shape: 'view-1' });
const listing = atom({ plugin: 'agent-typewriter', key: 'listing' } as const, listingOf(newDeck()), { shape: 'listing-1' });

/** The module's own state; rebuilt from $.state when the module loads. */
type Live = {
  deck: Deck;
  opts: PlayOptions;
  cwd?: string;
  /** Ids whose `text` members hold text. */
  texts: Set<string>;
  /** What was last written to `saved`, `view` and `listing`, to skip writes that change nothing. */
  savedJson: string;
  viewJson: string;
  listingJson: string;
  /** The changes list's first row once the person scrolled it; undefined while it follows playback. */
  listTop?: number;
  /** The list as the pane last drew it: its first row, the rows it shows, and the rows it has. */
  list?: { top: number; height: number; count: number };
  /** Writes to $.state, one after another, so a later state never lands first. */
  writes: Promise<void>;
};

const text = { plugin: 'agent-typewriter', key: 'text' } as const;

/** Queues a write of what changed since the last one: cleared texts, `saved`, `view`, `listing`. */
function sync($: EngineInterface, live: Live): void {
  live.writes = live.writes.then(() => flush($, live)).catch(() => undefined);
}

async function flush($: EngineInterface, live: Live): Promise<void> {
  // Texts are blanked before `saved` stops naming their change: a reload in
  // between skips a change with blank texts, while the other order could leave
  // texts that nothing names and nothing blanks.
  const nextSaved = savedOf(live.deck);
  const ids = new Set(nextSaved.changes.map((c) => c.id));
  for (const id of [...live.texts]) {
    if (ids.has(id)) continue;
    live.texts.delete(id);
    await $.state.set({ ...text, id: `${id}:before` }, '');
    await $.state.set({ ...text, id: `${id}:after` }, '');
  }
  const savedJson = JSON.stringify(nextSaved);
  if (savedJson !== live.savedJson) {
    live.savedJson = savedJson;
    await update($, saved, () => nextSaved);
  }
  const nextView = viewOf(live.deck);
  const viewJson = JSON.stringify(nextView);
  if (viewJson !== live.viewJson) {
    live.viewJson = viewJson;
    await update($, view, () => nextView);
  }
  const nextListing = listingOf(live.deck);
  const listingJson = JSON.stringify(nextListing);
  if (listingJson !== live.listingJson) {
    live.listingJson = listingJson;
    await update($, listing, () => nextListing);
  }
}

/** Rebuilds the deck from what an earlier load saved; a change whose texts are gone is skipped. */
async function load($: EngineInterface, live: Live): Promise<void> {
  const was = savedFrom((await $.state.get(savedRef)).value);
  const changes: Change[] = [];
  for (const c of was.changes) {
    if (c.isTooLarge) {
      changes.push({ ...c, before: '', after: '' });
      continue;
    }
    const before = (await $.state.get({ ...text, id: `${c.id}:before` })).value;
    const after = (await $.state.get({ ...text, id: `${c.id}:after` })).value;
    live.texts.add(c.id);
    if (before === undefined || after === undefined || before === after) continue;
    changes.push({ ...c, before, after });
  }
  live.deck = restore(was, changes, live.opts, live.cwd);
  sync($, live);
}

type Snapshot = { text: string } | { size: number; mtimeMs: number } | undefined;

/** The file's text, or only its size and time when it is over the limit or `shouldRead` is false; undefined when missing. */
async function snapshot($: EngineInterface, path: string, shouldRead: boolean): Promise<Snapshot> {
  const stat = await $.fs.stat(path).catch(() => undefined);
  if (!stat) return undefined;
  if (stat.size > MAX_REPLAY_BYTES || !shouldRead) return { size: stat.size, mtimeMs: stat.mtimeMs };
  return { text: normalizeEol(await $.fs.read(path)) };
}

/** Runs a file tool, capturing "before" when the call starts and "after" once it succeeded. */
async function record<R extends { deny?: string; isError?: boolean }>(
  $: EngineInterface,
  live: Live,
  tool: Tool,
  path: string,
  id: string,
  run: () => Promise<R>,
): Promise<R> {
  const before = await snapshot($, path, true);
  const ran = await run();
  if (ran.deny !== undefined || ran.isError) return ran;
  // Once the file was too large, its text is not read at all.
  const after = await snapshot($, path, !before || 'text' in before);
  if (!after) return ran;

  const recorded = { id, tool, path, kind: before ? 'modify' : 'create', time: await $.clock.now() } as const;
  let change: NewChange;
  if ('text' in after && (!before || 'text' in before)) {
    change = { ...recorded, before: before?.text ?? '', after: after.text };
  } else {
    const isSame =
      before !== undefined && !('text' in before) && !('text' in after) && before.size === after.size && before.mtimeMs === after.mtimeMs;
    if (isSame) return ran;
    change = { ...recorded, before: '', after: '', isTooLarge: true };
  }
  if (isUnchanged(change)) return ran;

  if (!change.isTooLarge) {
    await $.state.set({ ...text, id: `${id}:before` }, change.before);
    await $.state.set({ ...text, id: `${id}:after` }, change.after);
  }
  // Read the deck after the writes: the timer and other hooks may have moved it.
  const isFirst = live.deck.recorded === 0;
  enqueue(live.deck, change, live.cwd);
  // Tracked only once queued: a flush during the writes would take it for a
  // change that is gone and blank its texts.
  if (!change.isTooLarge) live.texts.add(id);
  sync($, live);
  // Unasked, the engine places the pane only where it docks beside the
  // conversation; elsewhere it waits for /typewriter.
  if (isFirst) void $.ui.open({ id: PANE, title: TITLE });
  return ran;
}

/** Whether the session draws only on the terminal. An empty list (a -p run, a cloud session) is not. */
async function isTerminalOnly($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces();
  return surfaces.length > 0 && surfaces.every((s) => s === 'terminal');
}

/** Records a file tool's change, unless the session draws only on the terminal. */
async function recordIfShown<R extends { deny?: string; isError?: boolean }>(
  $: EngineInterface,
  live: Live,
  tool: Tool,
  path: string,
  id: string,
  run: () => Promise<R>,
): Promise<R> {
  if (await isTerminalOnly($)) return run();
  return record($, live, tool, path, id, run);
}

/** Applies a control's action to the deck. */
function act($: EngineInterface, live: Live, fn: (deck: Deck) => void): void {
  fn(live.deck);
  sync($, live);
}

/** Applies a control's action that moves playback; the changes list follows playback again. */
function move($: EngineInterface, live: Live, fn: (deck: Deck) => void): void {
  live.listTop = undefined;
  act($, live, fn);
}

/** One timer tick: moves playback and writes what it changed. */
function step($: EngineInterface, live: Live): void {
  if (tick(live.deck, live.opts)) sync($, live);
}

export const register: Register = (on, options) => {
  const live: Live = {
    deck: newDeck(),
    opts: playOptions(options),
    texts: new Set(),
    savedJson: '',
    viewJson: '',
    listingJson: '',
    writes: Promise.resolve(),
  };

  on('session.start', async ($, e, next) => {
    live.cwd = e.cwd;
    await $.command.register({ name: 'typewriter', description: 'Open the Agent Typewriter pane' });
    await load($, live).catch(() => undefined);
    $.clock.every(TICK_MS, () => step($, live));
    return next(e);
  });

  on('command.run', { command: 'typewriter' }, async ($) => {
    if (await isTerminalOnly($)) return { text: TERMINAL_POINTER };
    await $.ui.open({ id: PANE, title: TITLE });
    return { text: 'Agent Typewriter pane opened.' };
  });

  // A failure while recording never blocks the tool: the handler runs it, or
  // hands back the result it already has.
  on('tool.call', { tool: 'Edit' }, ($, e, next) => recordIfShown($, live, 'Edit', e.file_path, e.tool_use_id, () => next(e))).catch(
    ($, e, next) => next(e),
  );
  on('tool.call', { tool: 'Write' }, ($, e, next) => recordIfShown($, live, 'Write', e.file_path, e.tool_use_id, () => next(e))).catch(
    ($, e, next) => next(e),
  );

  // The pane's tree fits its body, so the only thing to scroll is the changes
  // list, which the plugin draws a window of: it moves that window instead.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    const l = live.list;
    if (!l || l.count <= l.height) return next(e);
    const top = Math.max(0, Math.min(l.top + e.by, l.count - l.height));
    live.listTop = top;
    live.list = { ...l, top };
    $.ui.invalidate('ui.render');
    return {};
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The terminal is left to the VS Code extension.
    if (e.surface === 'terminal') return next(e);
    const { Box, Text, Button, Code } = $.ui.resolve(e);
    const v = await read($, view);
    const l = await read($, listing);
    const queued = v.queued > 0 ? ` · ${v.queued} queued` : '';
    const name = v.path === undefined ? undefined : relativePath(v.path, live.cwd);
    const current = l.rows.findIndex((r) => r.id === l.current);
    const bodyRows = e.props.scroll?.bodyRows ?? 24;
    const bodyColumns = e.props.bodyColumns ?? 80;

    // The list's items: a note on dropped changes, then a row per change.
    const lead = l.dropped > 0 ? 1 : 0;
    const count = lead + l.rows.length;
    const height = count === 0 ? 0 : Math.min(count, Math.max(3, Math.floor(bodyRows * LIST_SHARE)));
    const top = listWindow(count, current === -1 ? undefined : lead + current, height, live.listTop);
    live.list = { top, height, count };
    const rowsShown = l.rows.slice(Math.max(0, top - lead), top - lead + height);
    const isDroppedShown = lead > 0 && top === 0;

    // The code takes what the header, the controls and the list leave.
    const rows = Math.max(3, bodyRows - 3 - (height > 0 ? height + 1 : 0));
    const columns = Math.max(10, bodyColumns - GUTTER);
    const shown = v.path !== undefined && !v.isTooLarge ? frame(v, rows, columns) : undefined;
    const isPaused = v.status === 'paused';

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{name ?? 'No changes yet'}</Text>
          {current !== -1 && <Text dimColor>{`#${l.rows[current]!.number}`}</Text>}
          <Text dimColor>
            {v.status}
            {queued}
          </Text>
        </Box>
        {shown ? (
          <Code source={shown.source} path={v.path} startLine={shown.startLine} wrap="truncate-end" />
        ) : v.isTooLarge ? (
          <Text>{name} is too large to replay.</Text>
        ) : (
          <Text dimColor>Edits Claude makes with Edit or Write are typed out here.</Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="start" hotkey="r" onPress={() => move($, live, (d) => replayFromStart(d, live.opts))}>
            From start
          </Button>
          <Button key="pause" hotkey="p" onPress={() => act($, live, togglePause)}>
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button key="finish" hotkey="f" onPress={() => move($, live, (d) => finish(d, live.opts))}>
            Finish current
          </Button>
          <Button key="skip" hotkey="l" onPress={() => move($, live, (d) => skipToLatest(d, live.opts))}>
            Skip to latest
          </Button>
        </Box>
        {count > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold>Changes</Text>
              <Text dimColor>Pick a change to play from it</Text>
            </Box>
            {isDroppedShown && (
              <Text dimColor>{`${l.dropped} older ${l.dropped === 1 ? 'change was' : 'changes were'} dropped to stay within the limit.`}</Text>
            )}
            {rowsShown.map((row) => {
              const isCurrent = row.id === l.current;
              const label = rowLabel(row, relativePath(row.path, live.cwd), { isCurrent, isPaused }, bodyColumns - ROW_MARGIN);
              return (
                <Button
                  key={`change:${row.id}`}
                  plain
                  dimColor={row.state === 'pending' && !isCurrent}
                  onPress={() => move($, live, (d) => seek(d, row.id, live.opts))}
                >
                  {label.lead}
                  {label.dir !== '' && <Text dimColor>{label.dir}</Text>}
                  <Text bold>{label.file}</Text>
                  {label.tail}
                </Button>
              );
            })}
          </Box>
        )}
      </Box>
    );
  });
};
