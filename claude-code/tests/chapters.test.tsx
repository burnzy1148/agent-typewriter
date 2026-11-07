// Chapters by turn: the main conversation's turns the plugin keeps, the
// changes list grouped under their headers, Play turn, and the Play turn chip
// on the conversation's rows.

import type { On, RenderSurface } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import type { Turns } from '../types';

import { PANE_ID, seed, start, world } from './world';

/** Stands in for the engine's loops: a turn starts under the id the test gives it, and a spawn starts the agent its description names. */
function loops(on: On) {
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: e.description }));
}

/** Starts turn `turnId` with prompt `text` in the loop of `agentId`, the main conversation's when absent. */
async function turn($: Engine, turnId: string, text = '', agentId?: string) {
  const call = $.turn.start as unknown as (e: object) => Promise<unknown>;
  await call({ text, turnId, ...(agentId !== undefined && { agentId }) });
}

/** Ends turn `turnId` of the loop of `agentId`, the main conversation's when absent. */
async function endTurn($: Engine, turnId: string, agentId?: string) {
  const call = $.turn.complete as unknown as (e: object) => Promise<unknown>;
  await call({ turnId, reason: 'answer', answer: '', ...(agentId !== undefined && { agentId }) });
}

/** Spawns agent `agentId` from the `Agent` call `callId` in the main conversation. */
async function spawn($: Engine, agentId: string, callId: string) {
  const call = $.agent.spawn as unknown as (e: object) => Promise<unknown>;
  await call({ tool_use_id: callId, description: agentId, prompt: 'work', subagentType: 'general-purpose', parentModel: 'm', background: false, fork: false });
}

/** Writes `/w/<name>` from the call `id`, in the loop of `agentId`. */
async function write($: Engine, name: string, id: string, agentId?: string) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content: `${name}\n`, tool_use_id: id, ...(agentId !== undefined && { agentId }) });
}

/** Watches the plugin's writes of `turns`, and answers its first read with `stored` when given, as a reload finds it. */
function turnsState(on: On, stored?: unknown) {
  const writes: Turns[] = [];
  let isWritten = false;
  on('state.set', { plugin: 'agent-typewriter', key: 'turns' }, (_, e, next) => {
    isWritten = true;
    writes.push((e.value as { value: Turns }).value);
    return next(e);
  });
  if (stored !== undefined) {
    on('state.get', { plugin: 'agent-typewriter', key: 'turns' }, async (_, e, next) => {
      const got = await next(e);
      if (isWritten || got.deny !== undefined) return got;
      return { value: { value: stored, version: got.value.version } };
    });
  }
  return writes;
}

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

const TITLE = /^(Turn \d+|Earlier turn|Outside a turn)$/;
const COUNT = /^\d+ changes?$/;

/** The changes list's lines as the pane draws them, `bodyRows` high: 'dropped' for the note, `header <key>` for a chapter's header, `#<n>` for a row. */
async function lines($: Engine, bodyRows = 20) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, scroll: { offset: 0, bodyRows } } } as never);
  const dropped = (await ui.findAll({ type: 'Text' })).some((t) => /dropped/.test(t.text));
  const out: string[] = dropped ? ['dropped'] : [];
  for (const b of await ui.findAll({ type: 'Button' })) {
    if (b.key?.startsWith('play:')) out.push(`header ${b.key.slice('play:'.length)}`);
    else if (b.key?.startsWith('change:')) out.push(`#${/#(\d+) /.exec(b.text)![1]}`);
  }
  await ui.unmount();
  return out;
}

/** Each chapter header drawn, as its title, prompt when it has one, count and play button's words joined by ' | '. */
async function headers($: Engine) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const plays = (await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('play:'));
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text);
  await ui.unmount();
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (!TITLE.test(texts[i]!)) continue;
    const end = texts.findIndex((t, j) => j > i && COUNT.test(t));
    out.push([...texts.slice(i, end + 1), plays[out.length]?.text].join(' | '));
  }
  return out;
}

async function pressPane($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  await ui.press({ key });
  await ui.unmount();
}

/** What the pane's header names: the current change's number and the status. */
async function shown($: Engine) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const number = (await ui.find({ type: 'Text', text: /^#\d+$/ }))?.text;
  const status = (await ui.find({ type: 'Text', text: /^(typing|paused|idle)/ }))?.text;
  await ui.unmount();
  return { number, status };
}

/** Stands in for the engine's drawing of a tool row: one Text naming the tool. */
function engineRows(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>{`engine ${(e.props as { tool: string }).tool}`}</Text>;
  });
}

/** The tool row of call `id` as `surface` draws it: the engine's text, and each chip's key and words. */
async function row($: Engine, id: string, tool = 'Write', surface: RenderSurface = 'desktop') {
  const props = { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false };
  const ui = await $.ui.mount({ plugin: 'agent-typewriter', component: 'ToolUse', requestId: id, surface, props } as never);
  const engine = (await ui.find({ type: 'Text', text: /^engine / }))?.text;
  const chips = (await ui.findAll({ type: 'Button' })).map((b) => [b.key, b.text]);
  await ui.unmount();
  return { engine, chips };
}

async function pressRow($: Engine, id: string, key: string, tool = 'Write') {
  const props = { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false };
  const ui = await $.ui.mount({ plugin: 'agent-typewriter', component: 'ToolUse', requestId: id, surface: 'desktop', props } as never);
  await ui.press({ key });
  await ui.unmount();
}

/** 300 characters: about 18 seconds of typing at the default speed. */
const LONG = 'x'.repeat(299) + '\n';

// Keeping turns.

test("the main conversation's turns are numbered in order, with or without changes, and an agent's turns are not", async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = turnsState(on);
  await start($);
  await turn($, 't1', 'Add a rate limiter.');
  await write($, 'a.ts', 'toolu_a');
  await endTurn($, 't1');
  await turn($, 't2', 'What does it do?');
  await endTurn($, 't2');
  await turn($, 't3', '  Cover it\n\nwith   tests. ');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', 'agent work', 'ag1');
  await write($, 'b.ts', 'toolu_b', 'ag1');
  await w.clock.settle();

  expect(writes.at(-1)).toEqual({
    next: 4,
    turns: [
      { turnId: 't1', number: 1, prompt: 'Add a rate limiter.', isEnded: true },
      { turnId: 't3', number: 3, prompt: 'Cover it with tests.' },
    ],
  });
  expect(await headers($)).toEqual(['Turn 1 | Add a rate limiter. | 1 change | Play turn', 'Turn 3 | Cover it with tests. | 1 change | Play turn']);
});

test('turns survive a reload with their numbers and prompts, and numbering goes on', async ($, on) => {
  const w = world(on);
  loops(on);
  const saved = {
    changes: [
      { id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1, turnId: 't1', mainTurnId: 't1' },
      { id: 'toolu_b', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2, turnId: 't2', mainTurnId: 't2' },
    ],
    played: 2,
    recorded: 2,
    isPaused: false,
  };
  seed(on, { shape: 'saved-4', value: saved }, { 'toolu_a:before': '', 'toolu_a:after': 'a\n', 'toolu_b:before': '', 'toolu_b:after': 'b\n' });
  const stored: Turns = {
    next: 3,
    turns: [
      { turnId: 't1', number: 1, prompt: 'first', isEnded: true },
      { turnId: 't2', number: 2, prompt: 'second', isEnded: true },
    ],
  };
  const writes = turnsState(on, { shape: 'turns-1', value: stored });
  await start($);
  await w.clock.settle();
  expect(await headers($)).toEqual(['Turn 1 | first | 1 change | Play turn', 'Turn 2 | second | 1 change | Play turn']);

  await turn($, 't3', 'third');
  await write($, 'c.ts', 'toolu_c');
  await w.clock.settle();
  expect(writes.at(-1)?.turns.at(-1)).toEqual({ turnId: 't3', number: 3, prompt: 'third' });
  expect((await headers($)).at(-1)).toBe('Turn 3 | third | 1 change | Play turn');
});

test('a turn that starts while a reload is loading is numbered after the stored turns', async ($, on) => {
  const w = world(on);
  loops(on);
  const stored: Turns = { next: 5, turns: [{ turnId: 't4', number: 4, prompt: 'four' }] };
  const writes = turnsState(on, { shape: 'turns-1', value: stored });
  const starting = start($);
  await turn($, 'tnew', 'new');
  await starting;
  await w.clock.settle();

  // t4 named no kept change and has ended, so it goes.
  expect(writes.at(-1)).toEqual({ next: 6, turns: [{ turnId: 'tnew', number: 5, prompt: 'new' }] });
});

test('a turn running at a reload ends when the next turn starts, and then gets its chip', async ($, on) => {
  const w = world(on);
  loops(on);
  engineRows(on);
  const saved = { changes: [{ id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1, turnId: 't2', mainTurnId: 't2' }], played: 1, recorded: 1, isPaused: false };
  seed(on, { shape: 'saved-4', value: saved }, { 'toolu_a:before': '', 'toolu_a:after': 'a\n' });
  turnsState(on, { shape: 'turns-1', value: { next: 3, turns: [{ turnId: 't2', number: 2, prompt: 'running' }] } });
  await start($);
  await w.clock.settle();
  expect((await row($, 'toolu_a')).chips.map(([k]) => k)).toEqual(['chip:toolu_a']);

  await turn($, 't3', 'next');
  await w.clock.settle();
  expect((await row($, 'toolu_a')).chips).toEqual([
    ['chip:toolu_a', 'Replay #1'],
    ['turn-chip:t2', 'Play turn · 1 change'],
  ]);
});

test("a turn is no longer kept once its changes are dropped", async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = turnsState(on);
  await start($);
  await turn($, 't1', 'old');
  await write($, 'old.ts', 'toolu_old');
  await endTurn($, 't1');
  await turn($, 't2', 'many');
  for (let i = 0; i < 200; i++) await write($, `n${i}.ts`, `toolu_n${i}`);
  await endTurn($, 't2');
  await w.clock.settle();

  expect(writes.at(-1)?.turns.map((t) => t.turnId)).toEqual(['t2']);
});

test("a turn with no changes of its own is kept while an agent it started is known, so the agent's later change sits under its number and prompt", async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = turnsState(on);
  await start($);
  await turn($, 't1', 'Start a background agent.');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', '', 'ag1');
  await endTurn($, 't1');
  await turn($, 't2', 'Something else.');
  await write($, 'b.ts', 'toolu_b');
  await w.clock.settle();
  expect(writes.at(-1)?.turns.map((t) => t.turnId)).toEqual(['t1', 't2']);

  // The background agent turn 1 started writes after turn 2's change.
  await write($, 'c.ts', 'toolu_c', 'ag1');
  await w.clock.settle();
  expect(await headers($)).toEqual(['Turn 2 | Something else. | 1 change | Play turn', 'Turn 1 | Start a background agent. | 1 change | Play turn']);
});

// Chapters in the pane.

test("the list groups changes under each turn's header, a subagent's change under the turn that started it", async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1', 'Add a rate limiter.');
  await write($, 'a.ts', 'toolu_a');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', '', 'ag1');
  await endTurn($, 't1');
  await turn($, 't2', 'Cover it with tests.');
  await write($, 'b.ts', 'toolu_b');
  // The background agent turn 1 started writes during turn 2.
  await write($, 'c.ts', 'toolu_c', 'ag1');
  await w.clock.settle();

  expect((await lines($))).toEqual(['header t1', '#1', '#3', 'header t2', '#2']);
  expect(await headers($)).toEqual(['Turn 1 | Add a rate limiter. | 2 changes | Play turn', 'Turn 2 | Cover it with tests. | 1 change | Play turn']);
});

test('after a reload from an older version, changes with no turn and turns known only by id get their own headers', async ($, on) => {
  const w = world(on);
  const saved = {
    changes: [
      { id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1 },
      { id: 'toolu_b', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2 },
      { id: 'toolu_c', number: 3, tool: 'Write', path: '/w/c.ts', kind: 'create', time: 3, turnId: 'tx', mainTurnId: 'tx' },
    ],
    played: 3,
    recorded: 3,
    isPaused: false,
  };
  seed(on, { shape: 'saved-4', value: saved }, { 'toolu_a:before': '', 'toolu_a:after': 'a\n', 'toolu_b:before': '', 'toolu_b:after': 'b\n', 'toolu_c:before': '', 'toolu_c:after': 'c\n' });
  await start($);
  await w.clock.settle();

  expect(await headers($)).toEqual(['Outside a turn | 2 changes | Play from first', 'Earlier turn | 1 change | Play turn']);
  expect((await lines($))).toEqual(['header ', '#1', '#2', 'header tx', '#3']);
});

test('Play turn types the turn\'s first change next, then the changes after it', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1', 'one');
  await write($, 'a.ts', 'toolu_a');
  await turn($, 't2', 'two');
  await write($, 'b.ts', 'toolu_b');
  await write($, 'c.ts', 'toolu_c');
  await w.clock.advance(60_000);
  expect(await shown($)).toEqual({ number: '#3', status: 'idle' });

  await pressPane($, 'play:t2');
  await w.clock.advance(60);
  expect(await shown($)).toEqual({ number: '#2', status: 'typing · 1 queued' });
});

test('Play turn while paused cues the turn\'s first change as Next and stays paused', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1', 'one');
  await write($, 'a.ts', 'toolu_a');
  await write($, 'b.ts', 'toolu_b');
  await turn($, 't2', 'two');
  await write($, 'c.ts', 'toolu_c');
  await w.clock.advance(60_000);
  await pressPane($, 'pause');

  await pressPane($, 'play:t1');
  await w.clock.advance(5_000);
  expect(await shown($)).toEqual({ number: '#1', status: 'paused · 3 queued' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const first = (await ui.findAll({ type: 'Button' })).find((b) => b.key === 'change:toolu_a');
  await ui.unmount();
  expect(first?.text).toContain('Next');
});

test('Play turn brings a scrolled list back to following playback', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1', 'one');
  for (let i = 1; i <= 15; i++) await write($, `a${i}.ts`, `toolu_a${i}`);
  await turn($, 't2', 'two');
  for (let i = 16; i <= 30; i++) await write($, `b${i}.ts`, `toolu_b${i}`);
  await w.clock.advance(60_000);
  expect((await lines($)).at(-1)).toBe('#30');
  const scroll = $.ui.scroll as unknown as (e: object) => Promise<unknown>;
  // Lines: t1's header, #1–#15 on lines 1–15, t2's header on line 16, #16–#30 on lines 17–31.
  await scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: -12, bodyRows: 20, contentRows: 19, origin: { kind: 'person' }, pointer: { row: 19, column: 4 } });
  expect(await lines($)).toEqual(['#12', '#13', '#14', '#15', 'header t2', '#16', '#17', '#18']);

  // #16 goes a third of the way down the window, and the list follows playback on from there.
  await pressPane($, 'play:t2');
  expect(await lines($)).toEqual(['#15', 'header t2', '#16', '#17', '#18', '#19', '#20', '#21']);
  await w.clock.advance(60_000);
  expect((await lines($)).at(-1)).toBe('#30');
});

test("a prompt with control characters draws them as stand-ins, and the pane still draws", async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = turnsState(on);
  await start($);
  await turn($, 't1', 'fix \x1b[31merror\x1b[0m please');
  await write($, 'a.ts', 'toolu_a');
  await w.clock.settle();

  expect(writes.at(-1)?.turns[0]?.prompt).toBe('fix \u241b[31merror\u241b[0m please');
  expect(await headers($)).toEqual(['Turn 1 | fix \u241b[31merror\u241b[0m please | 1 change | Play turn']);
  expect(await lines($)).toEqual(['header t1', '#1']);
});

test('the dropped note sits above the first chapter', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1', 'one');
  for (let i = 1; i <= 202; i++) await write($, `f${i}.ts`, `toolu_${i}`);
  await pressPane($, 'start');
  await w.clock.advance(60);

  expect((await lines($)).slice(0, 3)).toEqual(['dropped', 'header t1', '#3']);
  expect((await headers($))[0]).toBe('Turn 1 | one | 200 changes | Play turn');
});

// The Play turn chip.

test("an ended turn's chip sits on its last change's row, beside that change's chip, and the engine's row is kept", async ($, on) => {
  const w = world(on);
  loops(on);
  engineRows(on);
  await start($);
  await turn($, 't1', 'one');
  await write($, 'a.ts', 'toolu_a');
  await write($, 'b.ts', 'toolu_b');
  expect((await row($, 'toolu_b')).chips.map(([k]) => k)).toEqual(['chip:toolu_b']);

  await endTurn($, 't1');
  await w.clock.advance(60_000);
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    expect(await row($, 'toolu_b', 'Write', surface)).toEqual({
      engine: 'engine Write',
      chips: [
        ['chip:toolu_b', 'Replay #2'],
        ['turn-chip:t1', 'Play turn · 2 changes'],
      ],
    });
  }
  expect((await row($, 'toolu_a')).chips.map(([k]) => k)).toEqual(['chip:toolu_a']);
  expect(await row($, 'toolu_b', 'Write', 'terminal')).toEqual({ engine: 'engine Write', chips: [] });
});

test("when a subagent's change is a turn's last, the chip sits on the Agent call's row, and moves there when a background agent records later", async ($, on) => {
  const w = world(on);
  loops(on);
  engineRows(on);
  await start($);
  await turn($, 't1', 'one');
  await write($, 'a.ts', 'toolu_a');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', '', 'ag1');
  await endTurn($, 't1');
  await w.clock.settle();
  expect((await row($, 'toolu_a')).chips.map(([k]) => k)).toEqual(['chip:toolu_a', 'turn-chip:t1']);
  expect(await row($, 'toolu_agent', 'Agent')).toEqual({ engine: 'engine Agent', chips: [] });

  await turn($, 't2', 'two');
  await write($, 'b.ts', 'toolu_b', 'ag1');
  await w.clock.settle();
  expect((await row($, 'toolu_a')).chips.map(([k]) => k)).toEqual(['chip:toolu_a']);
  expect(await row($, 'toolu_agent', 'Agent')).toEqual({ engine: 'engine Agent', chips: [['turn-chip:t1', 'Play turn · 2 changes']] });
  expect((await row($, 'toolu_agent', 'Workflow')).chips).toEqual([['turn-chip:t1', 'Play turn · 2 changes']]);
});

test('pressing the Play turn chip opens the pane and plays the turn; while paused it cues the first change', async ($, on) => {
  const w = world(on);
  loops(on);
  engineRows(on);
  await start($);
  await turn($, 't1', 'one');
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: LONG, tool_use_id: 'toolu_a' });
  await $.tool.call({ tool: 'Write', file_path: '/w/b.ts', content: LONG, tool_use_id: 'toolu_b' });
  await endTurn($, 't1');
  await turn($, 't2', 'two');
  await $.tool.call({ tool: 'Write', file_path: '/w/c.ts', content: LONG, tool_use_id: 'toolu_c' });
  await w.clock.advance(120_000);
  const opens = w.opens.length;

  await pressRow($, 'toolu_b', 'turn-chip:t1');
  expect(w.opens.slice(opens)).toEqual([PANE_ID]);
  await w.clock.advance(60);
  expect(await shown($)).toEqual({ number: '#1', status: 'typing · 2 queued' });

  await pressPane($, 'pause');
  await w.clock.advance(60_000);
  await pressRow($, 'toolu_b', 'turn-chip:t1');
  expect((await row($, 'toolu_a')).chips[0]).toEqual(['chip:toolu_a', 'Next #1']);
  expect((await shown($)).status).toMatch(/^paused/);
});
