// Wires playback (replay.ts) to Claude Code: records the session's Edit and
// Write calls, ticks the deck on a timer, and draws the pane. The plugin only
// reads files; it never writes one. A session that draws only in a terminal is
// left to the VS Code extension: nothing is recorded or drawn there.
//
// The deck lives in module memory. Hooks, the timer and button handlers run in
// this one module, one at a time, so they change it directly. $.state keeps
// only what must outlive a reload (`saved`, and each kept change's texts in
// the `text` family with their captions, the agents' links in `agents`, the
// main conversation's turns in `turns`) and what the pane draws (`view`, and the changes list in
// `listing`, which changes far less often).

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, UiOpenResult } from 'claude-code';

import type { AgentLink, Turns } from '../types';

import { normalizeEol } from './core.mjs';
import {
  MAX_REPLAY_BYTES,
  SAVED_SHAPE,
  TICK_MS,
  captionLines,
  captionsOf,
  changeById,
  chaptersOf,
  chipLabel,
  enqueue,
  finish,
  forgetLoop,
  frame,
  headerLabel,
  isUnchanged,
  keptTurns,
  linksOf,
  listLines,
  listWindow,
  listingOf,
  narrate,
  newDeck,
  playOptions,
  promptOf,
  relativePath,
  replayFromStart,
  restore,
  rowLabel,
  savedFrom,
  savedOf,
  scrollTargets,
  scrolledTop,
  seek,
  setCaption,
  skipToLatest,
  tick,
  togglePause,
  turnChipLabel,
  turnChips,
  viewOf,
  type CallLinks,
  type Change,
  type Deck,
  type HeardRow,
  type ListGeometry,
  type Narration,
  type NewChange,
  type PlayOptions,
  type Tool,
} from './replay';

const PANE = 'agent-typewriter';
const TITLE = 'Agent Typewriter';
const TERMINAL_POINTER =
  "Agent Typewriter for Claude Code doesn't replay in the terminal. To watch Claude's edits typed out, use the Agent Typewriter extension for VS Code (https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter), or run Claude Code in the desktop app.";
/** Where the pane can be shown, for a session where it can't. */
const LOCAL_POINTER = "To watch Claude's edits typed out, use a local session in the Claude Code desktop app or in VS Code.";
/** What the plugin says when no surface is attached to show the pane, as in a cloud session or a -p run. */
const NO_SURFACE = `Agent Typewriter can't show its pane in this session: no app is showing it here. Cloud sessions, claude.ai/code and the mobile app don't draw plugin panes. ${LOCAL_POINTER}`;
/** Columns the Code element's line-number gutter takes. */
const GUTTER = 8;
/** Columns a row keeps free of its label, for a desktop's button padding. */
const ROW_MARGIN = 4;
/** Columns the ↗ beside a row takes, with the gap before it and its padding. */
const REVEAL_COLUMNS = 4;
/** What the pane says when Show in conversation could not scroll the conversation, for whatever reason. */
const SCROLL_FAILED_NOTE = "Couldn't scroll the conversation to that call.";
/** Most agents whose links are kept across a reload; past this the oldest go first. */
const MAX_AGENTS = 200;
/** The share of the body's rows the changes list may take. */
const LIST_SHARE = 0.4;
/** Most captions kept for calls not yet recorded as changes; past this the oldest go first. */
const MAX_WAITING_CAPTIONS = 200;
/** Most lines the caption over the code takes. */
const BAND_LINES = 3;
/** Most lines a row's hover card takes, and the columns it may take at most. */
const CARD_LINES = 6;
const CARD_COLUMNS = 60;

// Change a tag when its value's fields change: a reload then starts fresh
// instead of reading what an earlier version stored. `saved` reads its earlier
// tag through savedFrom.
const savedRef = { plugin: 'agent-typewriter', key: 'saved' } as const;
const saved = atom(savedRef, savedOf(newDeck()), { shape: SAVED_SHAPE });
const view = atom({ plugin: 'agent-typewriter', key: 'view' } as const, viewOf(newDeck()), { shape: 'view-2' });
const listing = atom({ plugin: 'agent-typewriter', key: 'listing' } as const, listingOf(newDeck()), { shape: 'listing-4' });
const agentsRef = { plugin: 'agent-typewriter', key: 'agents' } as const;
const AGENTS_SHAPE = 'agents-1';
const agents = atom(agentsRef, [] as AgentLink[], { shape: AGENTS_SHAPE });
const turnsRef = { plugin: 'agent-typewriter', key: 'turns' } as const;
const TURNS_SHAPE = 'turns-1';
const NO_TURNS: Turns = { next: 1, turns: [] };
const turns = atom(turnsRef, NO_TURNS, { shape: TURNS_SHAPE });

/** The module's own state; rebuilt from $.state when the module loads. */
type Live = {
  deck: Deck;
  opts: PlayOptions;
  cwd?: string;
  /** Ids whose `text` members hold text: their before and after texts, their caption, or both. */
  texts: Set<string>;
  /** Ids whose `:caption` member holds their caption. */
  captioned: Set<string>;
  /** Where each loop's response stands, for the captions of its calls. */
  narration: Narration;
  /** Captions settled for calls not yet recorded as changes, by `tool_use_id`, oldest first, at most MAX_WAITING_CAPTIONS. */
  captions: Map<string, string>;
  /** What was last written to `saved`, `view` and `listing`, to skip writes that change nothing. */
  savedJson: string;
  viewJson: string;
  listingJson: string;
  /** The changes list's first row once the person scrolled it; undefined while it follows playback. */
  listTop?: number;
  /** The list as the pane last drew it. */
  list?: ListGeometry;
  /** Writes to $.state, one after another, so a later state never lands first. */
  writes: Promise<void>;
  /** The running turn of each loop, by its agent id, '' for the main conversation. */
  turns: Map<string, string>;
  /**
   * Where each agent hangs off the main conversation: the turn and the `Agent`
   * call that started the top of its chain. Oldest first, at most MAX_AGENTS,
   * and kept in $.state (`agents`) so a reload keeps it.
   */
  agents: Map<string, { mainTurnId?: string; agentCallId?: string }>;
  /**
   * The main conversation's turns the plugin saw start, numbered from 1, kept
   * in $.state (`turns`) for the changes list's chapters and for a reload.
   */
  turnInfo: Turns;
  /** Settles once the load has read and merged the stored `agents` and `turns`, or failed; neither is written before. */
  loaded: Promise<void>;
  settleLoaded: () => void;
  /** Writes of `agents`, one after another. */
  agentWrites: Promise<void>;
  /** Writes of `turns`, one after another. */
  turnWrites: Promise<void>;
  /** A note the pane shows on its Changes line until the next press in it. */
  note?: string;
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
    if (live.captioned.delete(id)) await $.state.set({ ...text, id: `${id}:caption` }, '');
  }
  // A caption is written once its change is kept; a reload that finds none shows none.
  for (const [id, caption] of captionsOf(live.deck)) {
    if (live.captioned.has(id)) continue;
    live.captioned.add(id);
    live.texts.add(id);
    await $.state.set({ ...text, id: `${id}:caption` }, caption);
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
    // Changes saved before captions were kept have no caption member.
    const stored = (await $.state.get({ ...text, id: `${c.id}:caption` })).value;
    const caption = stored ? { caption: stored } : {};
    if (stored) {
      live.texts.add(c.id);
      live.captioned.add(c.id);
    }
    if (c.isTooLarge) {
      changes.push({ ...c, before: '', after: '', ...caption });
      continue;
    }
    const before = (await $.state.get({ ...text, id: `${c.id}:before` })).value;
    const after = (await $.state.get({ ...text, id: `${c.id}:after` })).value;
    live.texts.add(c.id);
    if (before === undefined || after === undefined || before === after) continue;
    changes.push({ ...c, before, after, ...caption });
  }
  live.deck = restore(was, changes, live.opts, live.cwd);
  const stored = (await $.state.get(agentsRef)).value;
  if (stored?.shape === AGENTS_SHAPE) {
    // Spawns seen since the module loaded are newer than what was stored.
    const seen = [...live.agents];
    live.agents = new Map(stored.value.map(({ agentId, ...at }) => [agentId, at]));
    for (const [id, at] of seen) keepAgent(live, id, at);
    // A spawn during the load queued a write that waits for this one's list.
    if (seen.length > 0) saveAgents($, live);
  }
  const storedTurns = (await $.state.get(turnsRef)).value;
  if (storedTurns?.shape === TURNS_SHAPE) {
    // Turns that started during the load come after the stored ones, numbered
    // on from them, and every stored turn has ended by then.
    const was = storedTurns.value;
    const seen = live.turnInfo.turns;
    const kept = seen.length > 0 ? was.turns.map((t) => ({ ...t, isEnded: true })) : was.turns;
    live.turnInfo = { next: was.next + seen.length, turns: [...kept, ...seen.map((t, i) => ({ ...t, number: was.next + i }))] };
    if (seen.length > 0) saveTurns($, live);
  }
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

/** The turn and agent a call in the loop of `agentId` (none for the main conversation) belongs to, as far as the plugin saw them. */
function linksFor(live: Live, agentId: string | undefined): CallLinks {
  const turnId = live.turns.get(agentId ?? '');
  if (agentId === undefined) return linksOf({ turnId, mainTurnId: turnId });
  return linksOf({ turnId, agentId, ...live.agents.get(agentId) });
}

/** Notes where agent `id` hangs off the main conversation, as its newest entry, dropping the oldest past MAX_AGENTS. */
function keepAgent(live: Live, id: string, at: { mainTurnId?: string; agentCallId?: string }): void {
  live.agents.delete(id);
  live.agents.set(id, at);
  for (const oldest of live.agents.keys()) {
    if (live.agents.size <= MAX_AGENTS) break;
    live.agents.delete(oldest);
  }
}

/**
 * Queues a write of the agents' links as they are when it runs, after the
 * load has read the stored ones: written earlier, it would replace them.
 */
function saveAgents($: EngineInterface, live: Live): void {
  live.agentWrites = live.agentWrites
    .then(() => live.loaded)
    .then(async () => {
      const next = [...live.agents].map(([agentId, at]): AgentLink => ({ agentId, ...at }));
      await update($, agents, () => next);
    })
    .catch(() => undefined);
}

/**
 * Queues a write of the turns as they are when it runs, after the load has
 * merged the stored ones, keeping only the running turn and the turns a kept
 * change or a known agent names.
 */
function saveTurns($: EngineInterface, live: Live): void {
  live.turnWrites = live.turnWrites
    .then(() => live.loaded)
    .then(async () => {
      const named = new Set<string>();
      for (const row of listingOf(live.deck).rows) if (row.mainTurnId) named.add(row.mainTurnId);
      for (const at of live.agents.values()) if (at.mainTurnId) named.add(at.mainTurnId);
      live.turnInfo = keptTurns(live.turnInfo, named);
      const next = live.turnInfo;
      await update($, turns, () => next);
    })
    .catch(() => undefined);
}

/** A main conversation turn starts: it takes the next number, and every turn before it has ended. */
function startTurn(live: Live, turnId: string, text: string): void {
  const was = live.turnInfo;
  const ended = was.turns.map((t) => (t.isEnded ? t : { ...t, isEnded: true }));
  live.turnInfo = { next: was.next + 1, turns: [...ended, { turnId, number: was.next, prompt: promptOf(text) }] };
}

/** A main conversation turn ends. */
function endTurn(live: Live, turnId: string): void {
  const was = live.turnInfo;
  live.turnInfo = { ...was, turns: was.turns.map((t) => (t.turnId === turnId && !t.isEnded ? { ...t, isEnded: true } : t)) };
}

/** Plays from the first kept change of the chapter `key` names, as pressing its row does. */
function playTurn(live: Live, key: string): void {
  const chapter = chaptersOf(listingOf(live.deck), live.turnInfo.turns).find((ch) => ch.key === key);
  if (chapter) seek(live.deck, chapter.rows[0]!.id, live.opts);
}

/** Runs a file tool, capturing "before" when the call starts and "after" once it succeeded. */
async function record<R extends { deny?: string; isError?: boolean }>(
  $: EngineInterface,
  live: Live,
  tool: Tool,
  path: string,
  id: string,
  agentId: string | undefined,
  run: () => Promise<R>,
): Promise<R> {
  const links = linksFor(live, agentId);
  const before = await snapshot($, path, true);
  const ran = await run();
  if (ran.deny !== undefined || ran.isError) return ran;
  // Once the file was too large, its text is not read at all.
  const after = await snapshot($, path, !before || 'text' in before);
  if (!after) return ran;

  const recorded = { id, tool, path, kind: before ? 'modify' : 'create', time: await $.clock.now(), ...links } as const;
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
  // The caption, too: the row with the call's text may have been kept meanwhile.
  const caption = live.captions.get(id);
  if (caption !== undefined) {
    live.captions.delete(id);
    change = { ...change, caption };
  }
  const isFirst = live.deck.recorded === 0;
  enqueue(live.deck, change, live.cwd);
  // Tracked only once queued: a flush during the writes would take it for a
  // change that is gone and blank its texts.
  if (!change.isTooLarge) live.texts.add(id);
  sync($, live);
  // Unasked, the engine places the pane only where it docks beside the
  // conversation; elsewhere it waits for /typewriter, quietly. With no surface
  // at all nothing will draw it, so the transcript says so. The tool call does
  // not wait for the open.
  if (isFirst) {
    void $.ui.open({ id: PANE, title: TITLE }).then(
      (opened) => {
        if (isNoSurface(opened)) $.ui.log(NO_SURFACE);
      },
      () => undefined,
    );
  }
  return ran;
}

/**
 * Feeds a row a loop kept to the narration tracker. A caption for a change
 * already kept is set on it; one for a call not yet recorded waits for it.
 */
function heard($: EngineInterface, live: Live, row: HeardRow): void {
  for (const [id, caption] of narrate(live.narration, row)) {
    if (changeById(live.deck, id)) {
      if (setCaption(live.deck, id, caption)) sync($, live);
      continue;
    }
    live.captions.delete(id);
    live.captions.set(id, caption);
    for (const oldest of live.captions.keys()) {
      if (live.captions.size <= MAX_WAITING_CAPTIONS) break;
      live.captions.delete(oldest);
    }
  }
}

/** Whether an open left the pane undrawn because no surface is attached, the engine's `no-surface` reason. */
function isNoSurface(opened: UiOpenResult): boolean {
  return !opened.isPlaced && opened.reason.startsWith('no-surface');
}

/** What /typewriter answers for an open: opened only when the pane is placed. */
function openedText(opened: UiOpenResult): string {
  if (opened.isPlaced) return 'Agent Typewriter pane opened.';
  if (isNoSurface(opened)) return NO_SURFACE;
  return `Agent Typewriter can't show its pane here (${opened.reason}). ${LOCAL_POINTER}`;
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
  agentId: string | undefined,
  run: () => Promise<R>,
): Promise<R> {
  if (await isTerminalOnly($)) return run();
  return record($, live, tool, path, id, agentId, run);
}

/** Applies a control's action to the deck. Any press clears the pane's note, redrawing the pane even when nothing else changed. */
function act($: EngineInterface, live: Live, fn: (deck: Deck) => void): void {
  if (live.note !== undefined) {
    live.note = undefined;
    $.ui.invalidate('ui.render');
  }
  fn(live.deck);
  sync($, live);
}

/**
 * Scrolls the conversation to the call that made change `id`, or for an
 * agent's change to the `Agent` call when the call's own row is not there.
 * When no scroll lands, whatever the reason (the engine names no reason that
 * means only "not there"), or the change is no longer kept, the pane says it
 * could not scroll. Playback does not move.
 */
async function reveal($: EngineInterface, live: Live, id: string): Promise<void> {
  const hadNote = live.note !== undefined;
  live.note = undefined;
  const change = changeById(live.deck, id);
  for (const requestId of change ? scrollTargets(change) : []) {
    const r = await $.ui.scroll({ to: { requestId }, block: 'center' }).catch(() => undefined);
    if (r && r.deny === undefined) {
      if (hadNote) $.ui.invalidate('ui.render');
      return;
    }
  }
  live.note = SCROLL_FAILED_NOTE;
  $.ui.invalidate('ui.render');
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
    captioned: new Set(),
    narration: new Map(),
    captions: new Map(),
    savedJson: '',
    viewJson: '',
    listingJson: '',
    writes: Promise.resolve(),
    turns: new Map(),
    agents: new Map(),
    turnInfo: NO_TURNS,
    loaded: Promise.resolve(),
    settleLoaded: () => undefined,
    agentWrites: Promise.resolve(),
    turnWrites: Promise.resolve(),
  };
  live.loaded = new Promise((resolve) => (live.settleLoaded = resolve));

  on('session.start', async ($, e, next) => {
    live.cwd = e.cwd;
    try {
      await $.command.register({ name: 'typewriter', description: 'Open the Agent Typewriter pane' });
      await load($, live).catch(() => undefined);
    } finally {
      live.settleLoaded();
    }
    $.clock.every(TICK_MS, () => step($, live));
    return next(e);
  });

  on('command.run', { command: 'typewriter' }, async ($) => {
    if (await isTerminalOnly($)) return { text: TERMINAL_POINTER };
    return { text: openedText(await $.ui.open({ id: PANE, title: TITLE })) };
  });

  // Which turn each loop is in, and where each agent hangs off the main
  // conversation, so a change can name both; and the main conversation's
  // turns, numbered with their prompts, for the list's chapters. Observed only.
  on('turn.start', ($, e, next) => {
    live.turns.set(e.agentId ?? '', e.turnId);
    if (e.agentId === undefined) {
      startTurn(live, e.turnId, e.text);
      saveTurns($, live);
    }
    return next(e);
  });
  // Between turns a loop has no turn: a call then (a plugin's own) is stamped with none.
  on('turn.complete', ($, e, next) => {
    live.turns.delete(e.agentId ?? '');
    forgetLoop(live.narration, e.agentId);
    if (e.agentId === undefined) {
      endTurn(live, e.turnId);
      saveTurns($, live);
    }
    return next(e);
  });
  on('agent.spawn', async ($, e, next) => {
    // Read before the agent runs: a nested agent takes the entry of the agent it was started in.
    const at =
      e.parentAgentId === undefined
        ? { mainTurnId: live.turns.get(''), agentCallId: e.tool_use_id || undefined }
        : { ...live.agents.get(e.parentAgentId) };
    const started = await next(e);
    if (started.agentId !== undefined) {
      keepAgent(live, started.agentId, at);
      saveAgents($, live);
    }
    return started;
  });

  // What each loop's agent writes before an Edit or Write call becomes that
  // change's caption. Observed only: the row is stored and handed back as the
  // engine stored it, and a failure here loses a caption, nothing else. In a
  // session drawn only on the terminal nothing is recorded, so no caption is
  // ever used.
  on('session.append', async ($, e, next) => {
    const stored = await next(e);
    try {
      if (stored.deny === undefined) heard($, live, { door: e.door, ...(e.agentId !== undefined && { agentId: e.agentId }), content: stored.message.content });
    } catch {
      // The caption is lost; the conversation and the recording are not touched.
    }
    return stored;
  });

  // A failure while recording never blocks the tool: the handler runs it, or
  // hands back the result it already has.
  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    recordIfShown($, live, 'Edit', e.file_path, e.tool_use_id, e.agentId, () => next(e)),
  ).catch(($, e, next) => next(e));
  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    recordIfShown($, live, 'Write', e.file_path, e.tool_use_id, e.agentId, () => next(e)),
  ).catch(($, e, next) => next(e));

  // In the conversation, a kept change's call row keeps the engine's drawing
  // and gains a chip that plays from the change. The row a turn's work ends on
  // (its last kept change's call, or the Agent or Workflow call that started
  // it) gains a chip that plays the turn, once the turn has ended. Every other
  // row, and the terminal, are left as the engine draws them.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const tool = e.props.tool;
    const isFileTool = tool === 'Edit' || tool === 'Write';
    if (e.surface === 'terminal' || (!isFileTool && tool !== 'Agent' && tool !== 'Workflow')) return next(e);
    const l = await read($, listing);
    const row = isFileTool ? l.rows.find((r) => r.id === e.props.tool_use_id) : undefined;
    const t = await read($, turns);
    const chapter = turnChips(chaptersOf(l, t.turns)).get(e.props.tool_use_id);
    if (!row && !chapter) return next(e);
    const drawn = await next(e);
    const { Box, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" gap={1}>
          {row && (
            <Button
              key={`chip:${row.id}`}
              label={`Play from #${row.number} in the typewriter pane`}
              onPress={async () => {
                move($, live, (d) => seek(d, row.id, live.opts));
                await $.ui.open({ id: PANE, title: TITLE });
              }}
            >
              {chipLabel(row, { isCurrent: row.id === l.current, isPaused: l.isPaused })}
            </Button>
          )}
          {chapter && (
            <Button
              key={`turn-chip:${chapter.key}`}
              label={`Play turn ${chapter.number} in the typewriter pane`}
              onPress={async () => {
                move($, live, () => playTurn(live, chapter.key));
                await $.ui.open({ id: PANE, title: TITLE });
              }}
            >
              {turnChipLabel(chapter)}
            </Button>
          )}
        </Box>
      </Box>
    );
  });

  // The pane's tree fits its body, so the only thing to scroll is the changes
  // list, which the plugin draws a window of: it moves that window instead.
  // A scroll that is not the list's goes on to the engine, which has nothing to move.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    const l = live.list;
    const top = l && scrolledTop({ by: e.by, bodyRows: e.bodyRows, contentRows: e.contentRows, pointerRow: e.pointer?.row }, l);
    if (!l || top === undefined) return next(e);
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
    const t = await read($, turns);
    const queued = v.queued > 0 ? ` · ${v.queued} queued` : '';
    const name = v.path === undefined ? undefined : relativePath(v.path, live.cwd);
    const current = l.rows.findIndex((r) => r.id === l.current);
    const bodyRows = e.props.scroll?.bodyRows ?? 24;
    const bodyColumns = e.props.bodyColumns ?? 80;

    // The list's lines: a note on dropped changes, then each turn's header and rows.
    const lines = listLines(l, chaptersOf(l, t.turns));
    const count = lines.length;
    const currentLine = lines.findIndex((x) => x.kind === 'row' && x.row.id === l.current);
    const height = count === 0 ? 0 : Math.min(count, Math.max(3, Math.floor(bodyRows * LIST_SHARE)));
    const top = listWindow(count, currentLine === -1 ? undefined : currentLine, height, live.listTop);
    const linesShown = lines.slice(top, top + height);

    // The shown change's caption, in quotes, between the header and the code.
    const band = v.caption ? captionLines(`“${v.caption}”`, bodyColumns - 2, BAND_LINES) : [];
    // The code takes what the header, the caption, the controls and the list leave.
    const rows = Math.max(3, bodyRows - 3 - band.length - (height > 0 ? height + 1 : 0));
    const columns = Math.max(10, bodyColumns - GUTTER);
    const shown = v.path !== undefined && !v.isTooLarge ? frame(v, rows, columns) : undefined;
    // Under the header and the caption, the code (or its one-line note), the controls and the "Changes" line.
    const firstRow = 1 + band.length + (shown ? shown.source.split('\n').length : 1) + 2;
    live.list = { top, height, count, firstRow };
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
          {current !== -1 && (
            <Button key="reveal" onPress={() => reveal($, live, l.rows[current]!.id)}>
              Show in conversation
            </Button>
          )}
        </Box>
        {band.length > 0 && (
          <Box backgroundColor="subtle" paddingX={1}>
            <Text italic>{band.join('\n')}</Text>
          </Box>
        )}
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
              <Text dimColor>{live.note ?? 'Pick a change to play from it'}</Text>
            </Box>
            {linesShown.map((line, index) => {
              if (line.kind === 'dropped') {
                return (
                  <Text key="dropped" dimColor>{`${l.dropped} older ${l.dropped === 1 ? 'change was' : 'changes were'} dropped to stay within the limit.`}</Text>
                );
              }
              if (line.kind === 'header') {
                const { chapter } = line;
                const label = headerLabel(chapter, bodyColumns - ROW_MARGIN);
                return (
                  <Box key={`turn:${chapter.key}`} flexDirection="row" gap={1}>
                    <Text bold>{label.title}</Text>
                    {label.prompt !== '' && <Text dimColor>{label.prompt}</Text>}
                    <Text dimColor>{label.count}</Text>
                    <Button key={`play:${chapter.key}`} plain onPress={() => move($, live, () => playTurn(live, chapter.key))}>
                      {label.play}
                    </Button>
                  </Box>
                );
              }
              const { row } = line;
              const isCurrent = row.id === l.current;
              const width = bodyColumns - ROW_MARGIN - REVEAL_COLUMNS;
              const label = rowLabel(row, relativePath(row.path, live.cwd), { isCurrent, isPaused }, width);
              // The card opens above the row, over the rows and code drawn before it,
              // since the list sits at the pane's foot; its lines fit the rows above.
              const cardColumns = Math.max(10, Math.min(CARD_COLUMNS, bodyColumns - ROW_MARGIN));
              const cardLines = Math.max(1, Math.min(CARD_LINES, firstRow + index - 2));
              const card = row.caption ? captionLines(row.caption, cardColumns - 4, cardLines) : [];
              return (
                <Box key={`row:${row.id}`} flexDirection="row" gap={1}>
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
                  <Button key={`reveal:${row.id}`} plain dimColor label={`Show #${row.number} in the conversation`} onPress={() => reveal($, live, row.id)}>
                    ↗
                  </Button>
                  {card.length > 0 && (
                    <Box
                      position="absolute"
                      left={2}
                      bottom={1}
                      width={cardColumns}
                      display="none"
                      hover={{ display: 'flex' }}
                      borderStyle="round"
                      borderDimColor
                      backgroundColor="inverseText"
                      paddingX={1}
                    >
                      <Text italic>{card.join('\n')}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    );
  });
};
