// Linking changes to the conversation: the turn and agent each change keeps,
// Show in conversation from the pane, and the chip on a call's row.

import type { On, RenderSurface } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, seed, start, world } from './world';

/** Stands in for the engine's loops: a turn starts under the id the test gives it, and a spawn starts the agent its description names. */
function loops(on: On) {
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: e.description }));
}

/** Ends turn `turnId` of the loop of `agentId`, the main conversation's when absent. */
async function endTurn($: Engine, turnId: string, agentId?: string) {
  const complete = $.turn.complete as unknown as (e: object) => Promise<unknown>;
  await complete({ turnId, reason: 'answer', answer: '', ...(agentId !== undefined && { agentId }) });
}

/** Starts turn `turnId` in the loop of `agentId`, the main conversation's when absent. */
async function turn($: Engine, turnId: string, agentId?: string) {
  const start = $.turn.start as unknown as (e: object) => Promise<unknown>;
  await start({ text: '', turnId, ...(agentId !== undefined && { agentId }) });
}

/** Spawns agent `agentId` from the `Agent` call `callId`, inside the loop of `parentAgentId` (the main conversation's when absent). */
async function spawn($: Engine, agentId: string, callId: string, parentAgentId?: string) {
  const call = $.agent.spawn as unknown as (e: object) => Promise<unknown>;
  await call({
    tool_use_id: callId,
    description: agentId,
    prompt: 'work',
    subagentType: 'general-purpose',
    parentModel: 'm',
    background: false,
    fork: false,
    ...(parentAgentId !== undefined && { parentAgentId }),
  });
}

/** Writes `/w/<name>` from the call `id`, in the loop of `agentId`; `content` defaults to the name. */
async function write($: Engine, name: string, id: string, agentId?: string, content = `${name}\n`) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: id, ...(agentId !== undefined && { agentId }) });
}

/** 300 characters: about 18 seconds of typing at the default speed. */
const LONG = 'x'.repeat(299) + '\n';

/** The links of the change saved for call `id`. */
function linksOf(w: ReturnType<typeof world>, id: string) {
  const c = w.saved.changes.find((x) => x.id === id);
  if (!c) return undefined;
  const { turnId, agentId, mainTurnId, agentCallId } = c;
  return { turnId, agentId, mainTurnId, agentCallId };
}

test('a change in the main conversation keeps its call and turn, and no agent', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts', 'toolu_a');

  expect(linksOf(w, 'toolu_a')).toEqual({ turnId: 't1', agentId: undefined, mainTurnId: 't1', agentCallId: undefined });
  expect('agentId' in w.saved.changes[0]!).toBe(false);
});

test("a subagent's change keeps its own turn, the agent, the main turn that started it and the Agent call", async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', 'ag1');
  await write($, 'b.ts', 'toolu_b', 'ag1');
  // The main conversation moves on to another turn; the agent's later change still belongs to t1.
  await turn($, 't2');
  await write($, 'c.ts', 'toolu_c', 'ag1');

  expect(linksOf(w, 'toolu_b')).toEqual({ turnId: 'ta', agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent' });
  expect(linksOf(w, 'toolu_c')).toEqual({ turnId: 'ta', agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent' });
});

test('an agent started by a subagent keeps the main turn and Agent call of the first one', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await spawn($, 'ag1', 'toolu_agent');
  await turn($, 'ta', 'ag1');
  await spawn($, 'ag2', 'toolu_inner', 'ag1');
  await turn($, 'tb', 'ag2');
  await write($, 'd.ts', 'toolu_d', 'ag2');

  expect(linksOf(w, 'toolu_d')).toEqual({ turnId: 'tb', agentId: 'ag2', mainTurnId: 't1', agentCallId: 'toolu_agent' });
});

test('a change made between turns keeps no turn, though the turn before it was seen', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await endTurn($, 't1');
  await write($, 'between.ts', 'toolu_between');

  expect(linksOf(w, 'toolu_between')).toEqual({ turnId: undefined, agentId: undefined, mainTurnId: undefined, agentCallId: undefined });
});

/** Watches what the plugin writes to its `agents` state, and answers its first read with `stored` when given, as a reload finds it. */
function agentsState(on: On, stored?: unknown) {
  const writes: unknown[] = [];
  let isWritten = false;
  on('state.set', { plugin: 'agent-typewriter', key: 'agents' }, (_, e, next) => {
    isWritten = true;
    writes.push((e.value as { value: unknown }).value);
    return next(e);
  });
  if (stored !== undefined) {
    on('state.get', { plugin: 'agent-typewriter', key: 'agents' }, async (_, e, next) => {
      const got = await next(e);
      if (isWritten || got.deny !== undefined) return got;
      return { value: { value: stored, version: got.value.version } };
    });
  }
  return writes;
}

test("an agent started before a reload still gives its later changes the main turn and Agent call", async ($, on) => {
  const w = world(on);
  loops(on);
  agentsState(on, { shape: 'agents-1', value: [{ agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent' }] });
  await start($);
  await w.clock.settle();
  await turn($, 'ta2', 'ag1');
  await write($, 'late.ts', 'toolu_late', 'ag1');

  expect(linksOf(w, 'toolu_late')).toEqual({ turnId: 'ta2', agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent' });
});

test('an agent started while a reload is still loading keeps the stored agents, in memory and saved', async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = agentsState(on, { shape: 'agents-1', value: [{ agentId: 'old', mainTurnId: 't0', agentCallId: 'toolu_old' }] });
  const starting = start($);
  await spawn($, 'new', 'toolu_new');
  await starting;
  await w.clock.settle();

  expect(writes.at(-1)).toEqual([
    { agentId: 'old', mainTurnId: 't0', agentCallId: 'toolu_old' },
    { agentId: 'new', agentCallId: 'toolu_new' },
  ]);
  await turn($, 'tx', 'old');
  await write($, 'old.ts', 'toolu_oldwrite', 'old');
  expect(linksOf(w, 'toolu_oldwrite')).toEqual({ turnId: 'tx', agentId: 'old', mainTurnId: 't0', agentCallId: 'toolu_old' });
});

test('the agents started are saved for a reload, the newest 200', async ($, on) => {
  const w = world(on);
  loops(on);
  const writes = agentsState(on);
  await start($);
  await turn($, 't1');
  for (let i = 0; i < 201; i++) await spawn($, `ag${i}`, `toolu_agent${i}`);
  await w.clock.settle();

  const last = writes.at(-1) as { agentId: string; mainTurnId?: string; agentCallId?: string }[];
  expect(last.length).toBe(200);
  expect(last[0]).toEqual({ agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent1' });
  expect(last.at(-1)).toEqual({ agentId: 'ag200', mainTurnId: 't1', agentCallId: 'toolu_agent200' });
});

test('a change made before the plugin saw a turn start keeps no turn', async ($, on) => {
  const w = world(on);
  await start($);
  await write($, 'e.ts', 'toolu_e');

  expect(linksOf(w, 'toolu_e')).toEqual({ turnId: undefined, agentId: undefined, mainTurnId: undefined, agentCallId: undefined });
});

const LINKED = { id: 'toolu_s', number: 2, tool: 'Edit', path: '/w/s.ts', kind: 'modify', time: 2_000, turnId: 'ta', agentId: 'ag1', mainTurnId: 't1', agentCallId: 'toolu_agent' } as const;
const PLAIN = { id: 'toolu_r', number: 1, tool: 'Write', path: '/w/r.ts', kind: 'create', time: 1_000, turnId: 't1', mainTurnId: 't1' } as const;
const TEXTS = { 'toolu_r:before': '', 'toolu_r:after': 'kept\n', 'toolu_s:before': 'old\n', 'toolu_s:after': 'new\n' };

test('turns and agents survive a reload', async ($, on) => {
  const w = world(on);
  engineRows(on);
  const saved = { changes: [PLAIN, LINKED], played: 1, recorded: 2, isPaused: false };
  seed(on, { shape: 'saved-4', value: saved }, TEXTS);
  await start($);
  await w.clock.settle();
  expect(w.saved).toEqual(saved);

  await w.clock.advance(60);
  expect((await row($, 'toolu_s')).chip).toBe('Typing #2');
});

test('changes saved by the earlier saved-3 shape load without turns', async ($, on) => {
  const w = world(on);
  engineRows(on);
  const unlinked = (c: typeof PLAIN | typeof LINKED) => ({ id: c.id, number: c.number, tool: c.tool, path: c.path, kind: c.kind, time: c.time });
  const saved = { changes: [unlinked(PLAIN), unlinked(LINKED)], played: 2, recorded: 2, isPaused: false };
  seed(on, { shape: 'saved-3', value: saved }, TEXTS);
  await start($);
  await w.clock.settle();

  expect(w.saved).toEqual(saved);
  expect((await row($, 'toolu_r')).chip).toBe('Replay #1');
  expect((await row($, 'toolu_s')).chip).toBe('Replay #2');
});

// The pane's side.

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

/** The pane's Show in conversation buttons and the line under "Changes", as `surface` draws them. */
async function pane($: Engine, surface: RenderSurface = 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface } as never);
  const buttons = await ui.findAll({ type: 'Button' });
  const header = buttons.find((b) => b.key === 'reveal')?.text;
  const reveals = buttons.filter((b) => b.key?.startsWith('reveal:')).map((b) => [b.key, b.text, b.props.label]);
  const hint = (await ui.find({ type: 'Text', text: /Pick a change|Couldn't scroll/ }))?.text;
  const status = (await ui.find({ type: 'Text', text: /^(typing|paused|idle)/ }))?.text;
  const number = (await ui.find({ type: 'Text', text: /^#\d+$/ }))?.text;
  await ui.unmount();
  return { header, reveals, hint, status, number };
}

async function pressPane($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  await ui.press({ key });
  await ui.unmount();
}

test('the pane has Show in conversation while it shows a change, and a ↗ beside every row, on every surface', async ($, on) => {
  const w = world(on);
  await start($);
  expect(await pane($)).toMatchObject({ header: undefined, reveals: [] });

  await write($, 'a.ts', 'toolu_a');
  await write($, 'b.ts', 'toolu_b');
  await w.clock.advance(60);
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const { header, reveals } = await pane($, surface);
    expect(header).toBe('Show in conversation');
    expect(reveals).toEqual([
      ['reveal:toolu_a', '↗', 'Show #1 in the conversation'],
      ['reveal:toolu_b', '↗', 'Show #2 in the conversation'],
    ]);
  }
});

test("Show in conversation changes no playback, and when the scroll fails the pane says so until the next press", async ($, on) => {
  const w = world(on);
  await start($);
  await write($, 'a.ts', 'toolu_a');
  await write($, 'b.ts', 'toolu_b');
  await w.clock.advance(60);
  const before = await pane($);
  expect(before.hint).toBe('Pick a change to play from it');

  // The test kit cannot scroll a conversation row: a plugin's $.ui.scroll of one fails ("no implementation"), so the pane says it could not scroll.
  await pressPane($, 'reveal:toolu_b');
  const after = await pane($);
  expect(after.hint).toBe("Couldn't scroll the conversation to that call.");
  expect([after.status, after.number]).toEqual([before.status, before.number]);

  await pressPane($, 'reveal');
  expect((await pane($)).hint).toBe("Couldn't scroll the conversation to that call.");

  await pressPane($, 'pause');
  const paused = await pane($);
  expect(paused.hint).toBe('Pick a change to play from it');
  expect(paused.status).toBe('paused · 1 queued');
});

test('a press that changes nothing still clears the note on the pane as drawn', async ($, on) => {
  const w = world(on);
  await start($);
  await write($, 'a.ts', 'toolu_a');
  await w.clock.advance(10_000);

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const hint = async () => (await ui.find({ type: 'Text', text: /Pick a change|Couldn't scroll/ }))?.text;
  await ui.press({ key: 'reveal:toolu_a' });
  await w.clock.settle();
  expect(await hint()).toBe("Couldn't scroll the conversation to that call.");

  // Everything has played: Finish current moves nothing and writes no state.
  await ui.press({ key: 'finish' });
  await w.clock.settle();
  expect(await hint()).toBe('Pick a change to play from it');
  await ui.unmount();
});

// The conversation's side.

/** Stands in for the engine's drawing of a tool row: one Text naming the tool. */
function engineRows(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>{`engine ${(e.props as { tool: string }).tool}`}</Text>;
  });
}

/** The tool row of call `id` as `surface` draws it: the engine's text, and the chip's words and label if it has one. */
async function row($: Engine, id: string, tool = 'Edit', surface: RenderSurface = 'desktop') {
  const props = { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false };
  const ui = await $.ui.mount({ plugin: 'agent-typewriter', component: 'ToolUse', requestId: id, surface, props } as never);
  const engine = (await ui.find({ type: 'Text', text: /^engine / }))?.text;
  const button = await ui.find({ type: 'Button' });
  await ui.unmount();
  return { engine, chip: button?.text, key: button?.key, label: button?.props.label };
}

async function pressChip($: Engine, id: string) {
  const props = { tool_use_id: id, tool: 'Write', input: {}, isRunning: false, isErrored: false, isInterrupted: false };
  const ui = await $.ui.mount({ plugin: 'agent-typewriter', component: 'ToolUse', requestId: id, surface: 'desktop', props } as never);
  await ui.press({ key: `chip:${id}` });
  await ui.unmount();
}

test("a kept change's call row keeps the engine's drawing and gains a chip naming its state, on every surface but the terminal", async ($, on) => {
  const w = world(on);
  engineRows(on);
  await start($);
  await write($, '1.ts', 'toolu_1');
  await write($, '2.ts', 'toolu_2', undefined, LONG);
  await write($, '3.ts', 'toolu_3', undefined, LONG);
  await w.clock.advance(2_000);

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    expect(await row($, 'toolu_1', 'Write', surface)).toEqual({ engine: 'engine Write', chip: 'Replay #1', key: 'chip:toolu_1', label: 'Play from #1 in the typewriter pane' });
    expect((await row($, 'toolu_2', 'Write', surface)).chip).toBe('Typing #2');
    expect((await row($, 'toolu_3', 'Write', surface)).chip).toBe('Queued #3');
  }
  expect(await row($, 'toolu_1', 'Write', 'terminal')).toEqual({ engine: 'engine Write', chip: undefined, key: undefined, label: undefined });

  await pressPane($, 'pause');
  expect((await row($, 'toolu_2', 'Write')).chip).toBe('Paused #2');
});

test('rows with no kept change are drawn as the engine draws them', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  engineRows(on);
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'missing', new_string: 'B', tool_use_id: 'toolu_failed' });
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_bash' } as never);
  await w.clock.advance(60);

  expect(await row($, 'toolu_failed', 'Edit')).toEqual({ engine: 'engine Edit', chip: undefined, key: undefined, label: undefined });
  expect((await row($, 'toolu_bash', 'Bash')).chip).toBe(undefined);
  expect((await row($, 'toolu_never', 'Write')).chip).toBe(undefined);
});

test("a change dropped to stay within the limits loses its call row's chip", async ($, on) => {
  const w = world(on);
  engineRows(on);
  await start($);
  await write($, 'first.ts', 'toolu_first');
  await w.clock.advance(10_000);
  expect((await row($, 'toolu_first', 'Write')).chip).toBe('Replay #1');

  for (let i = 0; i < 200; i++) await write($, `n${i}.ts`, `toolu_n${i}`);
  await w.clock.advance(60);
  expect(await row($, 'toolu_first', 'Write')).toEqual({ engine: 'engine Write', chip: undefined, key: undefined, label: undefined });
  expect((await row($, 'toolu_n0', 'Write')).chip).toMatch(/#2$/);
});

test('a too-large change reads Too large on its chip while shown, and Not typed once passed', async ($, on) => {
  const w = world(on);
  engineRows(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'x'.repeat(1_000_001), tool_use_id: 'toolu_big' });
  await write($, 'n.ts', 'toolu_n');
  await w.clock.advance(60);
  expect((await row($, 'toolu_big', 'Write')).chip).toBe('Too large #1');

  await w.clock.advance(5_000);
  expect((await row($, 'toolu_big', 'Write')).chip).toBe('Not typed #1');
});

test('pressing a chip opens the pane and plays from its change; while paused it cues the change as Next', async ($, on) => {
  const w = world(on);
  engineRows(on);
  await start($);
  for (const n of ['1', '2', '3']) await write($, `${n}.ts`, `toolu_${n}`, undefined, LONG);
  await w.clock.advance(60_000);
  expect((await row($, 'toolu_2', 'Write')).chip).toBe('Replay #2');
  const opens = w.opens.length;

  await pressChip($, 'toolu_2');
  expect(w.opens.slice(opens)).toEqual([PANE_ID]);
  await w.clock.advance(60);
  expect((await pane($)).number).toBe('#2');
  expect((await row($, 'toolu_2', 'Write')).chip).toBe('Typing #2');
  expect((await row($, 'toolu_3', 'Write')).chip).toBe('Queued #3');

  await pressPane($, 'pause');
  await pressChip($, 'toolu_3');
  expect((await row($, 'toolu_3', 'Write')).chip).toBe('Next #3');
  expect((await pane($)).status).toMatch(/^paused/);
});

test('pressing a chip brings a scrolled changes list back to following playback', async ($, on) => {
  const w = world(on);
  engineRows(on);
  await start($);
  for (let i = 1; i <= 30; i++) await write($, `f${i}.ts`, `toolu_${i}`);
  await w.clock.advance(60_000);
  const numbers = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
    const rows = (await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('change:'));
    await ui.unmount();
    return rows.map((b) => Number(/#(\d+) /.exec(b.text)![1]));
  };
  expect(await numbers()).toEqual([23, 24, 25, 26, 27, 28, 29, 30]);
  const scroll = $.ui.scroll as unknown as (e: object) => Promise<unknown>;
  await scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: -100, bodyRows: 20, contentRows: 19, origin: { kind: 'person' }, pointer: { row: 19, column: 4 } });
  expect((await numbers())[0]).toBe(1);

  await pressChip($, 'toolu_17');
  expect(await numbers()).toEqual([15, 16, 17, 18, 19, 20, 21, 22]);
});
