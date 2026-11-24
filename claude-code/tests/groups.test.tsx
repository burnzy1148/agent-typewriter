// Groups by file: the By turn / By file switch over the changes list, the
// list grouped under each file's header, and Play from first.

import type { On } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, seed, start, world } from './world';

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

/** 300 characters: about 18 seconds of typing at the default speed. */
const LONG = 'x'.repeat(299) + '\n';

/** Writes `/w/<name>` with `content` from the call `id`. */
async function write($: Engine, name: string, id: string, content = `${id}\n`) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: id });
}

async function mount($: Engine) {
  return $.ui.mount({ ...PANE, surface: 'desktop' } as never);
}

/** The changes list's lines as the pane draws them: 'dropped', `file <path>` or `turn <key>` for a header, `#<n>` for a row. */
async function lines($: Engine) {
  const ui = await mount($);
  const dropped = (await ui.findAll({ type: 'Text' })).some((t) => /dropped/.test(t.text));
  const out: string[] = dropped ? ['dropped'] : [];
  for (const b of await ui.findAll({ type: 'Button' })) {
    if (b.key?.startsWith('play-file:')) out.push(`file ${b.key.slice('play-file:'.length)}`);
    else if (b.key?.startsWith('play:')) out.push(`turn ${b.key.slice('play:'.length)}`);
    else if (b.key?.startsWith('change:')) out.push(`#${/#(\d+) /.exec(b.text)![1]}`);
  }
  await ui.unmount();
  return out;
}

/** The grouping buttons: each one's words, whether it is drawn as the chosen one, and its label. */
async function switcher($: Engine) {
  const ui = await mount($);
  const buttons = (await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('group:'));
  await ui.unmount();
  return buttons.map((b) => [b.text, b.props.variant, b.props.label]);
}

/** Each file header drawn: its texts and its play button's words, joined by ' | '. */
async function fileHeaders($: Engine) {
  const ui = await mount($);
  const boxes = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('file:'));
  await ui.unmount();
  return boxes.map((b) => b.text);
}

/** Each change row's words, by its key. */
async function rows($: Engine) {
  const ui = await mount($);
  const out = new Map((await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('change:')).map((b) => [b.key, b.text]));
  await ui.unmount();
  return out;
}

async function pressPane($: Engine, key: string) {
  const ui = await mount($);
  await ui.press({ key });
  await ui.unmount();
}

/** What the pane's header names: the file, the current change's number and the status. */
async function shown($: Engine) {
  const ui = await mount($);
  const number = (await ui.find({ type: 'Text', text: /^#\d+$/ }))?.text;
  const status = (await ui.find({ type: 'Text', text: /^(typing|paused|idle)/ }))?.text;
  await ui.unmount();
  return { number, status };
}

/** The person's wheel scroll of the pane by `by` rows, the pointer over the list. */
async function scroll($: Engine, by: number) {
  const call = $.ui.scroll as unknown as (e: object) => Promise<unknown>;
  await call({ component: 'Pane', requestId: PANE_ID, offset: 0, by, bodyRows: 20, contentRows: 19, origin: { kind: 'person' }, pointer: { row: 19, column: 4 } });
}

/** Watches the plugin's writes of `grouping`, and answers its reads with `stored` until it writes, as a reload finds it. */
function groupingState(on: On, stored?: unknown) {
  const writes: unknown[] = [];
  on('state.set', { plugin: 'agent-typewriter', key: 'grouping' }, (_, e, next) => {
    writes.push((e.value as { value: unknown }).value);
    return next(e);
  });
  if (stored !== undefined) {
    on('state.get', { plugin: 'agent-typewriter', key: 'grouping' }, async (_, e, next) => {
      const got = await next(e);
      if (writes.length > 0 || got.deny !== undefined) return got;
      return { value: { value: stored, version: got.value.version } };
    });
  }
  return writes;
}

/** a.ts (#1), b.ts (#2), a.ts again (#3), test/a.test.ts (#4). */
async function threeFiles($: Engine, content?: (n: number) => string) {
  await write($, 'a.ts', 'toolu_1', content?.(1));
  await write($, 'b.ts', 'toolu_2', content?.(2));
  await write($, 'a.ts', 'toolu_3', content?.(3));
  await write($, 'test/a.test.ts', 'toolu_4', content?.(4));
}

test('By turn is chosen at first, and there are no grouping buttons before the first change', async ($, on) => {
  const w = world(on);
  await start($);
  expect(await switcher($)).toEqual([]);

  await write($, 'a.ts', 'toolu_1');
  await w.clock.settle();
  expect(await switcher($)).toEqual([
    ['By turn', 'primary', 'By turn, shown'],
    ['By file', 'secondary', 'Group by file'],
  ]);
});

test('By file groups the rows under each file, ordered by its first change, and By turn groups them back', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on);
  const writes = groupingState(on);
  await start($);
  await threeFiles($);
  await w.clock.advance(60_000);
  expect(await lines($)).toEqual(['turn ', '#1', '#2', '#3', '#4']);

  await pressPane($, 'group:file');
  await w.clock.settle();
  expect(writes).toEqual(['file']);
  expect(await switcher($)).toEqual([
    ['By turn', 'secondary', 'Group by turn'],
    ['By file', 'primary', 'By file, shown'],
  ]);
  expect(await lines($)).toEqual(['file /w/a.ts', '#1', '#3', 'file /w/b.ts', '#2', 'file /w/test/a.test.ts', '#4']);
  expect(await fileHeaders($)).toEqual(['a.ts2 changesPlay from first', 'b.ts1 changePlay from first', 'a.test.tstest/1 changePlay from first']);

  // A new change to a.ts joins its group, which stays first.
  await write($, 'a.ts', 'toolu_5');
  await w.clock.advance(60_000);
  expect(await lines($)).toEqual(['file /w/a.ts', '#1', '#3', '#5', 'file /w/b.ts', '#2', 'file /w/test/a.test.ts', '#4']);

  await pressPane($, 'group:turn');
  await w.clock.settle();
  expect(writes).toEqual(['file', 'turn']);
  expect(await lines($)).toEqual(['turn ', '#1', '#2', '#3', '#4', '#5']);
});

test('switching grouping leaves the change being typed going on, and draws every row the same', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on);
  await start($);
  await threeFiles($, (n) => LONG + n);
  await w.clock.advance(60_000);
  await write($, 'b.ts', 'toolu_5', LONG + LONG);
  await w.clock.advance(1_000);
  const before = await shown($);
  expect(before).toEqual({ number: '#5', status: 'typing' });
  const byTurn = await rows($);

  await pressPane($, 'group:file');
  await w.clock.settle();
  expect(await shown($)).toEqual(before);
  expect(await rows($)).toEqual(byTurn);
  await w.clock.advance(60_000);
  expect(await shown($)).toEqual({ number: '#5', status: 'idle' });
});

test('Play from first types the file\'s first change next, then every later change whatever its file', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on);
  await start($);
  await threeFiles($, (n) => LONG + n);
  await w.clock.advance(120_000);
  await pressPane($, 'group:file');
  await w.clock.settle();
  expect(await shown($)).toEqual({ number: '#4', status: 'idle' });

  await pressPane($, 'play-file:/w/b.ts');
  await w.clock.advance(60);
  expect(await shown($)).toEqual({ number: '#2', status: 'typing · 2 queued' });
  // b.ts's change is followed by a.ts's second and test/a.test.ts's.
  await w.clock.advance(60_000);
  expect(await shown($)).toEqual({ number: '#4', status: 'idle' });
});

test('Play from first while paused cues the file\'s first change as Next and stays paused', async ($, on) => {
  const w = world(on);
  await start($);
  await threeFiles($);
  await w.clock.advance(60_000);
  await pressPane($, 'group:file');
  await pressPane($, 'pause');

  await pressPane($, 'play-file:/w/a.ts');
  await w.clock.advance(5_000);
  expect(await shown($)).toEqual({ number: '#1', status: 'paused · 4 queued' });
  expect((await rows($)).get('change:toolu_1')).toContain('Next');
});

test('the dropped note sits above the first file group, and Play from first starts at a file\'s first kept change', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on);
  await start($);
  for (let i = 1; i <= 3; i++) await write($, 'same.ts', `toolu_${i}`, `${i}\n`);
  for (let i = 4; i <= 202; i++) await write($, `f${i}.ts`, `toolu_${i}`);
  await pressPane($, 'group:file');
  await pressPane($, 'start');
  await w.clock.advance(60);
  expect((await lines($)).slice(0, 4)).toEqual(['dropped', 'file /w/same.ts', '#3', 'file /w/f4.ts']);
  expect((await fileHeaders($))[0]).toBe('same.ts1 changePlay from first');

  await pressPane($, 'pause');
  await pressPane($, 'play-file:/w/same.ts');
  expect((await shown($)).number).toBe('#3');
  expect((await rows($)).get('change:toolu_3')).toContain('Next');
});

test('a switch or Play from first brings a scrolled list back to following playback', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on);
  await start($);
  for (let i = 1; i <= 30; i++) await write($, `a${i}.ts`, `toolu_${i}`);
  await w.clock.advance(60_000);
  await pressPane($, 'group:file');
  await w.clock.settle();
  expect((await lines($)).at(-1)).toBe('#30');
  await scroll($, -20);
  expect(await lines($)).not.toContain('#30');

  // Switching brings #30 back into view.
  await pressPane($, 'group:turn');
  await w.clock.settle();
  expect((await lines($)).at(-1)).toBe('#30');

  await pressPane($, 'group:file');
  await w.clock.settle();
  // Lines: a<k>'s header on line 2k - 2, #k on line 2k - 1; the window shows 8 from line 30.
  await scroll($, -22);
  expect(await lines($)).toEqual(['file /w/a16.ts', '#16', 'file /w/a17.ts', '#17', 'file /w/a18.ts', '#18', 'file /w/a19.ts', '#19']);
  // #16 goes a third of the way down the window, and the list follows playback on from there.
  await pressPane($, 'play-file:/w/a16.ts');
  expect(await lines($)).toEqual(['#15', 'file /w/a16.ts', '#16', 'file /w/a17.ts', '#17', 'file /w/a18.ts', '#18', 'file /w/a19.ts']);
  await w.clock.advance(60_000);
  expect((await lines($)).at(-1)).toBe('#30');
});

test('pressing the grouping already chosen brings a scrolled list back, without a write', async ($, on) => {
  const w = world(on);
  const writes = groupingState(on);
  await start($);
  for (let i = 1; i <= 30; i++) await write($, `a${i}.ts`, `toolu_${i}`);
  await w.clock.advance(60_000);
  expect((await lines($)).at(-1)).toBe('#30');
  await scroll($, -20);
  expect(await lines($)).not.toContain('#30');

  await pressPane($, 'group:turn');
  await w.clock.settle();
  expect((await lines($)).at(-1)).toBe('#30');
  expect(writes).toEqual([]);
});

test('the chosen grouping survives a reload', async ($, on) => {
  const w = world(on);
  const saved = {
    changes: [
      { id: 'toolu_a', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1 },
      { id: 'toolu_b', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2 },
      { id: 'toolu_c', number: 3, tool: 'Edit', path: '/w/a.ts', kind: 'modify', time: 3 },
    ],
    played: 3,
    recorded: 3,
    isPaused: false,
  };
  seed(on, { shape: 'saved-4', value: saved }, { 'toolu_a:before': '', 'toolu_a:after': 'a\n', 'toolu_b:before': '', 'toolu_b:after': 'b\n', 'toolu_c:before': 'a\n', 'toolu_c:after': 'aa\n' });
  groupingState(on, { shape: 'grouping-1', value: 'file' });
  await start($);
  await w.clock.settle();

  expect((await switcher($))[1]).toEqual(['By file', 'primary', 'By file, shown']);
  expect(await lines($)).toEqual(['file /w/a.ts', '#1', '#3', 'file /w/b.ts', '#2']);
});
