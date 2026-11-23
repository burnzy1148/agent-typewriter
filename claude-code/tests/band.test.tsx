// The band above the prompt while the pane is out of view, its controls and
// hotkeys, and the status entry that carries the same line.

import type { On } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, seed, start, world, type World } from './world';

const BAND = {
  plugin: 'agent-typewriter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const;

/** 300 characters: about 18 seconds of typing at the default speed. */
const LONG = 'x'.repeat(299) + '\n';

/** Writes `/w/<name>` with `content` from the call `toolu_<name>`. */
async function write($: Engine, name: string, content = LONG) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: `toolu_${name}` });
}

async function mount($: Engine, surface: 'desktop' | 'terminal' = 'desktop', props: object = {}) {
  return $.ui.mount({ ...BAND, surface, props: { ...BAND.props, ...props } } as never);
}

/** What the band draws: its line and each Button's words, key, hotkey and variant; undefined when it draws nothing. */
async function look($: Engine, surface: 'desktop' | 'terminal' = 'desktop', props: object = {}) {
  const ui = await mount($, surface, props);
  const buttons = await ui.findAll({ type: 'Button' });
  const line = (await ui.find({ type: 'Text', text: /^Agent Typewriter/ }))?.text;
  await ui.unmount();
  if (buttons.length === 0 && line === undefined) return undefined;
  return { line, buttons: buttons.map((b) => [b.text, b.key, b.props.hotkey, b.props.variant ?? null]) };
}

async function press($: Engine, key: string) {
  const ui = await mount($);
  await ui.press({ key });
  await ui.unmount();
}

/** Presses the pane's Button `key`, as the person does before closing it. */
async function pressPane($: Engine, key: string) {
  const ui = await $.ui.mount({
    plugin: 'agent-typewriter',
    component: 'Pane',
    requestId: PANE_ID,
    surface: 'desktop',
    props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never);
  await ui.press({ key });
  await ui.unmount();
}

/**
 * The world beneath the plugin, and an empty band beneath its hook, which
 * stands for the engine drawing nothing there when the hook passes.
 */
function setUp(on: On): World {
  const w = world(on);
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }));
  return w;
}

/**
 * The person closes the pane from its mark. A test cannot raise `ui.close`, so
 * the engine's record of open panes, which the band reads, drops it.
 */
function closePane(w: World) {
  w.panes.delete(PANE_ID);
}

async function typewriter($: Engine) {
  return $.command.run({ command: 'typewriter', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
}

/** The status entry the plugin last set; undefined for none. */
const status = (w: World) => w.statuses.at(-1);

test('the band shows once the pane is closed while a change types, with its line and three controls', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await write($, 'b.ts');
  await w.clock.advance(200);
  expect(w.panes.get(PANE_ID)).toBe(true);
  expect(await look($)).toBeUndefined();

  closePane(w);
  expect(await look($)).toEqual({
    line: 'Agent Typewriter · typing a.ts #1 · 1 queued',
    buttons: [
      ['Pause', 'band:pause', 'p', null],
      ['Skip to latest', 'band:skip', 'l', null],
      ['Open pane', 'band:open', 'o', 'primary'],
    ],
  });
});

test('the band shows at once when the pane is closed while paused, and its Pause reads Resume', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  await pressPane($, 'pause');
  closePane(w);
  const band = await look($);
  expect(band?.line).toBe('Agent Typewriter · paused · a.ts #1');
  expect(band?.buttons[0]?.[0]).toBe('Resume');
});

test('the band goes away when /typewriter places the pane again, and when nothing is left to play', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  expect(await look($)).toBeDefined();
  expect((await typewriter($)).text).toBe('Agent Typewriter pane opened.');
  expect(await look($)).toBeUndefined();

  closePane(w);
  await w.clock.advance(60_000);
  expect(await look($)).toBeUndefined();
  expect(status(w)).toBe('Agent Typewriter · up to date · a.ts #1');
});

test('the band shows while the pane is open but unplaced', async ($, on) => {
  const w = setUp(on);
  w.openAnswer = { isPlaced: false, reason: 'unrequested panes need 144 columns; the window has 120' };
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  expect(w.panes.get(PANE_ID)).toBe(false);
  expect((await look($))?.line).toBe('Agent Typewriter · typing a.ts #1');
});

test('the band yields to a question in the band, and draws nothing on the terminal', async ($, on) => {
  const w = setUp(on);
  w.surfaces = ['desktop', 'terminal'];
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  expect(await look($, 'desktop', { hasSurvey: true })).toBeUndefined();
  expect(await look($, 'terminal')).toBeUndefined();
  expect(await look($)).toBeDefined();
});

test('the band draws nothing before the first change', async ($, on) => {
  setUp(on);
  await start($);
  expect(await look($)).toBeUndefined();
});

test('Pause and Resume on the band stop and continue typing', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  await press($, 'band:pause');
  const saved = w.saved;
  await w.clock.advance(5_000);
  expect(w.saved).toEqual(saved);
  expect((await look($))?.buttons[0]?.[0]).toBe('Resume');
  await press($, 'band:pause');
  await w.clock.advance(60_000);
  expect(status(w)).toBe('Agent Typewriter · up to date · a.ts #1');
});

test('Skip to latest on the band finishes every change, and the band goes away', async ($, on) => {
  const w = setUp(on);
  await start($);
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await write($, f);
  await w.clock.advance(200);
  closePane(w);
  expect((await look($))?.line).toBe('Agent Typewriter · typing a.ts #1 · 3 queued');
  await press($, 'band:skip');
  await w.clock.settle();
  expect(await look($)).toBeUndefined();
  expect(status(w)).toBe('Agent Typewriter · up to date · d.ts #4');
});

test('Open pane on the band opens the pane, and the band goes away', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  w.opens.length = 0;
  await press($, 'band:open');
  expect(w.opens).toEqual([PANE_ID]);
  expect(await look($)).toBeUndefined();
  expect(w.toasts).toEqual([]);
});

test('Open pane left unplaced says why in a toast', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  w.openAnswer = { isPlaced: false, reason: 'the attached surfaces place no panes' };
  await press($, 'band:open');
  expect(w.toasts).toEqual([
    "Agent Typewriter can't show its pane here (the attached surfaces place no panes). To watch Claude's edits typed out, use a local session in the Claude Code desktop app or in VS Code.",
  ]);
  expect(await look($)).toBeDefined();
});

test('the band after a reload with the pane closed', async ($, on) => {
  const w = setUp(on);
  const changes = [
    { id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1 },
    { id: 'toolu_b', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2 },
  ];
  const texts = { 'toolu_a:before': '', 'toolu_a:after': LONG, 'toolu_b:before': '', 'toolu_b:after': LONG };
  seed(on, { shape: 'saved-5', value: { changes, recorded: 2, isPaused: false, lanes: [{ id: '', label: 'Main', color: 1 }], positions: { '': 0 }, followed: '', autoFollow: true } }, texts);
  await start($);
  await w.clock.advance(200);
  // Nothing opened the pane in this load.
  expect(w.panes.size).toBe(0);
  expect((await look($))?.line).toBe('Agent Typewriter · typing a.ts #1 · 1 queued');
  expect(status(w)).toBe('Agent Typewriter · typing a.ts #1 · 1 queued');
});

test('the status entry: none before the first change, then the band\'s line whether the pane is open or not', async ($, on) => {
  const w = setUp(on);
  await start($);
  expect(w.statuses).toEqual([]);
  await write($, 'app.ts');
  await write($, 'b.ts');
  await w.clock.advance(200);
  expect(w.panes.get(PANE_ID)).toBe(true);
  expect(status(w)).toBe('Agent Typewriter · typing app.ts #1 · 1 queued');
  await w.clock.advance(60_000);
  expect(status(w)).toBe('Agent Typewriter · up to date · b.ts #2');
  // Set only when the line changes.
  expect(new Set(w.statuses).size).toBe(w.statuses.length);
});

test('the status entry stays off while a terminal is attached, and comes back when it leaves', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  expect(status(w)).toBe('Agent Typewriter · typing a.ts #1');

  w.surfaces = ['desktop', 'terminal'];
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' });
  expect(status(w)).toBeUndefined();
  await w.clock.advance(60_000);
  expect(status(w)).toBeUndefined();

  w.surfaces = ['desktop'];
  await $.session.detach({ surface: 'terminal', clientId: 'terminal:default', reason: 'detach' });
  expect(status(w)).toBe('Agent Typewriter · up to date · a.ts #1');
});

test('a session that starts on the terminal and the desktop keeps no status entry; a terminal-only one records nothing to show', async ($, on) => {
  const w = setUp(on);
  w.surfaces = ['desktop', 'terminal'];
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  expect(w.statuses.filter((x: string | undefined) => x !== undefined)).toEqual([]);
});

test('a terminal-only session sets no status entry', async ($, on) => {
  const w = setUp(on);
  w.surfaces = ['terminal'];
  await start($, 'terminal');
  await write($, 'a.ts');
  await w.clock.advance(200);
  expect(w.statuses.filter((x: string | undefined) => x !== undefined)).toEqual([]);
});

test('the band shows while only another lane waits, counting it as the pane does', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'app.ts', 'a\n');
  await $.tool.call({ tool: 'Write', file_path: '/w/t1.ts', content: LONG, tool_use_id: 'toolu_t1', agentId: 'wt' });
  await $.tool.call({ tool: 'Write', file_path: '/w/t2.ts', content: LONG, tool_use_id: 'toolu_t2', agentId: 'wt' });
  await w.clock.advance(100);
  await pressPane($, 'auto-follow');
  await w.clock.advance(10_000);
  closePane(w);
  expect((await look($))?.line).toBe('Agent Typewriter · up to date · app.ts #1 · 2 in other lanes');
  await press($, 'band:skip');
  await w.clock.settle();
  expect(await look($)).toBeUndefined();
});

/** Whether a band already drawn, held across acts, shows its controls now. */
async function shows(ui: Awaited<ReturnType<typeof mount>>) {
  return (await ui.findAll({ type: 'Button' })).some((b) => b.key === 'band:open');
}

test('a band already drawn goes away when Open pane places the pane', async ($, on) => {
  const w = setUp(on);
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  closePane(w);
  const ui = await mount($);
  expect(await shows(ui)).toBe(true);
  await ui.press({ key: 'band:open' });
  expect(await shows(ui)).toBe(false);
  await ui.unmount();
});

test('a band already drawn redraws when a surface attaches or leaves', async ($, on) => {
  const w = setUp(on);
  w.openAnswer = { isPlaced: false, reason: 'unrequested panes need 144 columns; the window has 120' };
  await start($);
  await write($, 'a.ts');
  await w.clock.advance(200);
  const ui = await mount($);
  expect(await shows(ui)).toBe(true);
  // A surface that places the pane attaches.
  w.panes.set(PANE_ID, true);
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' });
  expect(await shows(ui)).toBe(false);
  // It leaves, and the pane waits unplaced again.
  w.panes.set(PANE_ID, false);
  await $.session.detach({ surface: 'vscode', clientId: 'vscode:default', reason: 'detach' });
  expect(await shows(ui)).toBe(true);
  await ui.unmount();
});
