// Lanes (at-o3z.15): a lane per loop, the chips over the code that follow
// one, auto-follow and its switch, the header and rows naming lanes, and
// lanes across a reload.

import type { On, RenderSurface } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { MAIN_LANE, PANE_ID, seed, start, world } from './world';

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const;

/** Stands in for the engine's loops: a turn starts under the id the test gives it, and a spawn starts the agent its prompt names. */
function loops(on: On) {
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: e.prompt }));
}

/** Starts turn `turnId` in the loop of `agentId`, the main conversation's when absent. */
async function turn($: Engine, turnId: string, agentId?: string) {
  const begin = $.turn.start as unknown as (e: object) => Promise<unknown>;
  await begin({ text: '', turnId, ...(agentId !== undefined && { agentId }) });
}

/** Ends turn `turnId` of the loop of `agentId`, the main conversation's when absent. */
async function endTurn($: Engine, turnId: string, agentId?: string) {
  const complete = $.turn.complete as unknown as (e: object) => Promise<unknown>;
  await complete({ turnId, reason: 'answer', answer: '', ...(agentId !== undefined && { agentId }) });
}

/** Spawns agent `agentId`, described `description`, from the main conversation's `Agent` call `toolu_<agentId>`. */
async function spawn($: Engine, agentId: string, description: string, subagentType = 'general-purpose') {
  const call = $.agent.spawn as unknown as (e: object) => Promise<unknown>;
  await call({ tool_use_id: `toolu_${agentId}`, description, prompt: agentId, subagentType, parentModel: 'm', background: false, fork: false });
}

/** Writes `/w/<name>` from the call `toolu_<name>`, in the loop of `agentId`. */
async function write($: Engine, name: string, agentId?: string, content = `${name}\n`) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: `toolu_${name}`, ...(agentId !== undefined && { agentId }) });
}

/** 300 characters: about 18 seconds of typing at the default speed. */
const LONG = 'x'.repeat(299) + '\n';

/** What the pane draws about lanes on `surface`, `bodyColumns` wide. */
async function look($: Engine, bodyColumns = 100, surface: RenderSurface = 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns } } as never);
  const buttons = await ui.findAll({ type: 'Button' });
  const chips = buttons.filter((b) => b.key?.startsWith('lane:')).map((b) => (b.props.variant === 'primary' ? `[${b.text}]` : b.text));
  const autoFollow = buttons.find((b) => b.key === 'auto-follow')?.text;
  const texts = await ui.findAll({ type: 'Text' });
  const header = texts.find((t) => t.text.startsWith('● '))?.text;
  const dots = texts.filter((t) => t.text === '●').map((t) => t.props.color);
  const status = texts.find((t) => /^(typing|paused|idle)/.test(t.text))?.text;
  const more = texts.find((t) => /^\+\d+ more$/.test(t.text))?.text;
  const chipRows = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('lanes:')).length;
  const rows = buttons.filter((b) => b.key?.startsWith('change:')).map((b) => b.text);
  await ui.unmount();
  return { chips, autoFollow, header, dots, status, more, chipRows, rows };
}

/** Answers the plugin's first read of its `agents` state with `stored`, as a reload finds it. */
function storedAgents(on: On, stored: { shape: string; value: unknown }) {
  let isRead = false;
  on('state.get', { plugin: 'agent-typewriter', key: 'agents' }, async (_, e, next) => {
    const got = await next(e);
    if (isRead || got.deny !== undefined) return got;
    isRead = true;
    return { value: { value: stored, version: got.value.version } };
  });
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  await ui.press({ key });
  await ui.unmount();
}

/**
 * Main typing a long change with one more queued; `write tests` with two
 * queued; `update callers`, which edited first and finished, played out.
 */
async function threeLanes($: Engine, w: ReturnType<typeof world>) {
  await turn($, 't1');
  await spawn($, 'uc', 'update callers');
  await turn($, 'tu', 'uc');
  await write($, 'callers.ts', 'uc');
  await endTurn($, 'tu', 'uc');
  await w.clock.advance(2_000);
  await write($, 'a.ts', undefined, LONG);
  await write($, 'b.ts');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  await write($, 'login.test.ts', 'wt');
  await w.clock.advance(200);
}

test('three lanes draw a chip each, Main first, the followed one selected, then the switch; the header and rows name lanes', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await threeLanes($, w);

  const l = await look($);
  expect(l.chips).toEqual(['[● Main · typing · 1 queued]', '● update callers · caught up', '● write tests · 2 queued']);
  expect(l.autoFollow).toBe('Auto-follow: on');
  expect(l.header).toBe('● Main');
  expect(l.status).toBe('typing · 1 queued · 2 in other lanes');
  // update callers took the first color, so Main takes the next free one; the header's dot comes first.
  expect(l.dots.slice(0, 4)).toEqual(['green', 'green', 'blue', 'orange']);
  expect(l.rows.map((r) => r.replace(/^. #\d+ Write /, ''))).toEqual([
    'callers.ts  ● update callers +1',
    'a.ts Typing +1',
    'b.ts +1',
    'limiter.test.ts  ● write tests +1',
    'login.test.ts  ● write tests +1',
  ]);
});

test('pressing a chip follows its lane: the change being typed waits, and the lane types from its own position', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await threeLanes($, w);

  await press($, 'lane:wt');
  let l = await look($);
  expect(l.chips[2]).toBe('[● write tests · 2 queued]');
  expect(l.header).toBe('● write tests (general-purpose)');
  expect(l.status).toBe('idle · 2 queued · 2 in other lanes');
  await w.clock.advance(100);
  l = await look($);
  expect(l.chips).toEqual(['● Main · 2 queued', '● update callers · caught up', '[● write tests · typing · 1 queued]']);

  await press($, 'lane:main');
  await w.clock.advance(100);
  expect((await look($)).chips[0]).toBe('[● Main · typing · 1 queued]');
});

test('a chip press brings a scrolled list back to following playback', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  for (let i = 1; i <= 30; i++) await write($, `f${i}.ts`);
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  // The list scrolls once the pane has drawn it.
  await look($);
  const scroll = $.ui.scroll as unknown as (e: object) => Promise<unknown>;
  await scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: 5, bodyRows: 30, contentRows: 29, origin: { kind: 'person' }, pointer: { row: 29, column: 4 } });
  expect((await look($)).rows.some((r) => r.includes('limiter.test.ts'))).toBe(false);

  await press($, 'lane:wt');
  expect((await look($)).rows.some((r) => r.includes('limiter.test.ts'))).toBe(true);
});

test('the switch turns auto-follow off and on, and while off a caught-up Main stays followed', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts');
  await w.clock.advance(1_000);
  expect((await look($)).autoFollow).toBe(undefined);
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  expect((await look($)).autoFollow).toBe('Auto-follow: on');
  await press($, 'auto-follow');
  expect((await look($)).autoFollow).toBe('Auto-follow: off');
  expect(w.saved.autoFollow).toBe(false);
  await w.clock.advance(10_000);
  expect((await look($)).chips).toEqual(['[● Main · caught up]', '● write tests · 1 queued']);

  await press($, 'auto-follow');
  expect((await look($)).autoFollow).toBe('Auto-follow: on');
  await w.clock.advance(3_200);
  expect((await look($)).header).toBe('● write tests (general-purpose)');
});

test('auto-follow moves to a subagent\'s lane after Main is caught up and quiet for 3 s', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  await w.clock.advance(1_000);
  expect((await look($)).header).toBe('● Main');
  await w.clock.advance(1_500);
  expect((await look($)).header).toBe('● Main');
  await w.clock.advance(1_000);
  expect((await look($)).header).toBe('● write tests (general-purpose)');
});

test('with auto-follow off, a subagent\'s lane that finished and played out gives way to Main', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt', LONG);
  await write($, 'a.ts');
  await press($, 'auto-follow');
  await write($, 'b.ts');
  await endTurn($, 'tw', 'wt');
  expect((await look($)).header).toBe('● write tests (general-purpose)');
  await w.clock.advance(30_000);
  const l = await look($);
  expect(l.header).toBe('● Main');
  expect(l.chips).toEqual(['[● Main · caught up]', '● write tests · caught up']);
});

test('chips that do not fit two rows leave some out and say how many, keeping the followed one', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts', undefined, LONG);
  for (let i = 1; i <= 11; i++) {
    await spawn($, `ag${i}`, `agent number ${i}`);
    await turn($, `ta${i}`, `ag${i}`);
    await write($, `f${i}.ts`, `ag${i}`);
  }
  await w.clock.advance(100);
  const l = await look($, 60);
  expect(l.chipRows).toBe(2);
  expect(l.chips[0]).toBe('[● Main · typing]');
  expect(l.more).toMatch(/^\+\d+ more$/);
  expect(l.chips.length + Number(/\d+/.exec(l.more!)![0])).toBe(12);
  expect(l.autoFollow).toBe('Auto-follow: on');
});

test('a single lane draws no chips and names no lane, whether Main\'s or one subagent\'s', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  await w.clock.advance(100);
  let l = await look($);
  expect([l.chips, l.autoFollow, l.header, l.chipRows]).toEqual([[], undefined, undefined, 0]);
  expect(l.status).toMatch(/^typing/);
  expect(l.rows[0]).not.toContain('●');

  await w.clock.advance(5_000);
  await write($, 'a.ts');
  expect((await look($)).chips.length).toBe(2);
});

test('nothing about lanes is drawn on the terminal', async ($, on) => {
  const w = world(on);
  loops(on);
  // Stands in for what the engine draws when no plugin draws the pane.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, () => ({ type: 'Box' }));
  await start($);
  await threeLanes($, w);
  const l = await look($, 100, 'terminal');
  expect([l.chips, l.header, l.autoFollow]).toEqual([[], undefined, undefined]);
});

test('three lanes survive a reload with their labels, colors, positions, the followed lane and auto-follow', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await threeLanes($, w);
  await press($, 'lane:wt');
  await press($, 'auto-follow');
  await w.clock.advance(100);
  const saved = w.saved;
  expect(saved.lanes).toEqual([
    { id: 'uc', label: 'update callers', color: 1, kind: 'general-purpose' },
    { id: '', label: 'Main', color: 2 },
    { id: 'wt', label: 'write tests', color: 3, kind: 'general-purpose' },
  ]);
  expect([saved.positions, saved.followed, saved.autoFollow]).toEqual([{ uc: 1, '': 0, wt: 0 }, 'wt', false]);
});

test('a reload keeps lanes: the followed lane types its change from the start, and auto-follow stays off', async ($, on) => {
  const w = world(on);
  const changes = [
    { id: 'toolu_c', number: 1, tool: 'Write', path: '/w/c.ts', kind: 'create', time: 1, agentId: 'uc' },
    { id: 'toolu_a', number: 2, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 2 },
    { id: 'toolu_t1', number: 3, tool: 'Write', path: '/w/t1.ts', kind: 'create', time: 3, agentId: 'wt' },
    { id: 'toolu_t2', number: 4, tool: 'Write', path: '/w/t2.ts', kind: 'create', time: 4, agentId: 'wt' },
    { id: 'toolu_c2', number: 5, tool: 'Write', path: '/w/c2.ts', kind: 'create', time: 5, agentId: 'uc' },
  ];
  const lanes = [
    { id: 'uc', label: 'update callers', color: 1, kind: 'general-purpose' },
    { id: '', label: 'Main', color: 2 },
    { id: 'wt', label: 'write tests', color: 3, kind: 'general-purpose' },
  ];
  const texts = Object.fromEntries(changes.flatMap((c) => [[`${c.id}:before`, ''], [`${c.id}:after`, `${c.id}\n`]]));
  seed(on, { shape: 'saved-5', value: { changes, recorded: 5, isPaused: false, lanes, positions: { uc: 1, '': 1, wt: 0 }, followed: 'wt', autoFollow: false } }, texts);
  await start($);
  await w.clock.settle();

  let l = await look($);
  expect(l.chips).toEqual(['● Main · caught up', '● update callers · 1 queued', '[● write tests · 2 queued]']);
  expect(l.autoFollow).toBe('Auto-follow: off');
  expect(l.dots.slice(0, 1)).toEqual(['orange']);
  await w.clock.advance(100);
  l = await look($);
  expect(l.chips[2]).toBe('[● write tests · typing · 1 queued]');
  expect(l.rows.find((r) => r.includes('t1.ts'))).toContain('Typing');
  // write tests is finished after the reload: once it plays out, update callers is not running either, so nothing takes over.
  await w.clock.advance(10_000);
  expect((await look($)).chips).toEqual(['● Main · caught up', '● update callers · 1 queued', '[● write tests · caught up]']);
});

test('a subagent described before a reload that first edits after it gets its description as its label', async ($, on) => {
  const w = world(on);
  loops(on);
  const stored = [{ agentId: 'uc', mainTurnId: 't1', agentCallId: 'toolu_uc', description: 'update callers', subagentType: 'Explore' }];
  storedAgents(on, { shape: 'agents-2', value: stored });
  await start($);
  await write($, 'a.ts');
  await write($, 'c.ts', 'uc');
  await w.clock.settle();
  expect(w.saved.lanes).toEqual([MAIN_LANE, { id: 'uc', label: 'update callers', color: 2, kind: 'Explore' }]);
});

test('changes saved before lanes load into lanes by their agent, played ones still played, Main followed and auto-follow on', async ($, on) => {
  const w = world(on);
  const changes = [
    { id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1 },
    { id: 'toolu_b', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2, agentId: 'wt' },
    { id: 'toolu_c', number: 3, tool: 'Write', path: '/w/c.ts', kind: 'create', time: 3 },
    { id: 'toolu_d', number: 4, tool: 'Write', path: '/w/d.ts', kind: 'create', time: 4, agentId: 'wt' },
  ];
  const texts = Object.fromEntries(changes.flatMap((c) => [[`${c.id}:before`, ''], [`${c.id}:after`, `${c.id}\n`]]));
  seed(on, { shape: 'saved-4', value: { changes, played: 2, recorded: 4, isPaused: false } }, texts);
  storedAgents(on, { shape: 'agents-1', value: [{ agentId: 'wt', agentCallId: 'toolu_wt' }] });
  await start($);
  await w.clock.settle();

  expect(w.saved.lanes).toEqual([MAIN_LANE, { id: 'wt', label: 'Subagent', color: 2 }]);
  expect([w.saved.positions, w.saved.followed, w.saved.autoFollow]).toEqual([{ '': 1, wt: 1 }, '', true]);
  expect((await look($)).chips).toEqual(['[● Main · 1 queued]', '● Subagent · 1 queued']);
});

test('Play from first on a file another lane changed first follows that lane, and Main waits where it was', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  await w.clock.advance(10_000);
  await write($, 'b.ts', undefined, LONG);
  await w.clock.advance(100);
  expect((await look($)).chips[0]).toBe('[● Main · typing]');

  await press($, 'group:file');
  await press($, 'play-file:/w/limiter.test.ts');
  const l = await look($);
  expect(l.header).toBe('● write tests (general-purpose)');
  expect(l.chips).toEqual(['● Main · 1 queued', '[● write tests · 1 queued]']);
  expect(l.rows.find((r) => r.includes('limiter.test.ts'))).toContain('Next');
});

test('a pinned tab ends when a chip follows another lane, and the tabs are that lane\'s', async ($, on) => {
  const w = world(on);
  loops(on);
  await start($);
  await turn($, 't1');
  await write($, 'a.ts');
  await write($, 'b.ts');
  await spawn($, 'wt', 'write tests');
  await turn($, 'tw', 'wt');
  await write($, 'limiter.test.ts', 'wt');
  await w.clock.advance(1_000);
  await press($, 'tab:/w/a.ts');
  const tabs = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
    const buttons = await ui.findAll({ type: 'Button' });
    await ui.unmount();
    return { tabs: buttons.filter((b) => b.key?.startsWith('tab:')).map((b) => b.text), hasFollow: buttons.some((b) => b.key === 'follow') };
  };
  expect(await tabs()).toEqual({ tabs: ['a.ts', 'b.ts'], hasFollow: true });

  await press($, 'lane:wt');
  await w.clock.advance(1_000);
  expect(await tabs()).toEqual({ tabs: ['limiter.test.ts'], hasFollow: false });
});
