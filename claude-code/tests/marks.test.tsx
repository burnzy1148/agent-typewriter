// The code view's file tabs, pinning a tab, the diff marks, the beat before a
// long deletion, and Clear marks (at-o3z.16).

import type { On } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, readDiff, seed, start, world } from './world';

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Agent Typewriter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const;

/** What the pane draws: its tabs (each label, with `*` on the one marked shown), the Viewing line, the header's name, and the code read back. */
async function look($: Engine, bodyColumns = 80) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } } as never);
  const buttons = await ui.findAll({ type: 'Button' });
  const tabs = buttons.filter((b) => b.key?.startsWith('tab:')).map((b) => (String(b.props.label).endsWith(', shown') ? `${b.text}*` : b.text));
  const all = await ui.findAll({ type: 'Text' });
  const texts = all.map((t) => t.text);
  const viewing = texts.find((t) => t.startsWith('Viewing '));
  const more = texts.find((t) => /^\d+ more$/.test(t));
  const name = all.find((t) => t.props.bold === true)?.text;
  const props = (await ui.find({ type: 'Code' }))?.props as { source: string; path: string; format?: string } | undefined;
  const hasFollow = buttons.some((b) => b.key === 'follow');
  await ui.unmount();
  const code = props && { ...readDiff(props.source), path: props.path, format: props.format, source: props.source };
  return { tabs, viewing, more, name, code, hasFollow, marks: code?.rows.filter((r) => !r.startsWith(' ')) ?? [] };
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  await ui.press({ key });
  await ui.unmount();
}

/** Presses the list's row for change number `n`. */
async function pressRow($: Engine, n: number) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const row = (await ui.findAll({ type: 'Button' })).find((b) => b.key?.startsWith('change:') && b.text.includes(`#${n} `));
  expect(row?.key).toBeDefined();
  await ui.press({ key: row!.key! });
  await ui.unmount();
}

async function pressChip($: Engine, id: string) {
  const props = { tool_use_id: id, tool: 'Write', input: {}, isRunning: false, isErrored: false, isInterrupted: false };
  const ui = await $.ui.mount({ plugin: 'agent-typewriter', component: 'ToolUse', requestId: id, surface: 'desktop', props } as never);
  await ui.press({ key: `chip:${id}` });
  await ui.unmount();
}

async function write($: Engine, name: string, content: string, id = `toolu_${name}`) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: id });
}

async function edit($: Engine, name: string, from: string, to: string, id?: string) {
  await $.tool.call({ tool: 'Edit', file_path: `/w/${name}`, old_string: from, new_string: to, ...(id !== undefined && { tool_use_id: id }) });
}

/** Answers the plugin's read of the atom `key` with `stored` until it writes it, as a reload finds it. */
function stored(on: On, key: 'marks' | 'tabs', value: unknown) {
  let isWritten = false;
  // One key at a time: the matcher's type narrows by a single key.
  const at = { plugin: 'agent-typewriter', key: key as 'marks' } as const;
  on('state.set', at, (_, e, next) => {
    isWritten = true;
    return next(e);
  });
  on('state.get', at, async (_, e, next) => {
    const got = await next(e);
    if (isWritten || got.deny !== undefined) return got;
    return { value: { value, version: got.value.version } };
  });
}

const LONG = 'b'.repeat(400) + '\n';

/** a.ts played, b.ts being typed, c.ts waiting. */
async function threeFiles($: Engine, w: ReturnType<typeof world>) {
  await start($);
  await write($, 'src/a.ts', 'a\n');
  await write($, 'src/b.ts', LONG);
  await write($, 'c.ts', 'c\n');
  await w.clock.advance(1_000);
}

test('a tab per file typed, in the order typed, the shown one marked; a waiting file has none', async ($, on) => {
  const w = world(on);
  await threeFiles($, w);
  const v = await look($);
  expect(v.tabs).toEqual(['a.ts', 'b.ts*']);
  expect(v.viewing).toBeUndefined();
});

test('pressing a tab pins its file: it shows as last typed, with its marks and no caret, and typing goes on', async ($, on) => {
  const w = world(on);
  await threeFiles($, w);
  await press($, 'tab:/w/src/a.ts');
  const v = await look($);
  expect(v.tabs).toEqual(['a.ts*', 'b.ts']);
  expect(v.viewing).toBe('Viewing a.ts as last typed. Playback is in src/b.ts.');
  expect(v.hasFollow).toBe(true);
  expect(v.name).toBe('src/b.ts');
  expect(v.code?.path).toBe('/w/src/a.ts');
  expect(v.code?.rows).toEqual(['+a', ' ']);
  expect(v.code?.source).not.toContain('▍');

  await press($, 'follow');
  const typed = (await look($)).code!.text.length;
  await press($, 'tab:/w/src/a.ts');
  await w.clock.advance(2_000);
  const later = await look($);
  expect(later.code?.path).toBe('/w/src/a.ts');
  expect(later.viewing).toBe('Viewing a.ts as last typed. Playback is in src/b.ts.');
  await press($, 'follow');
  expect((await look($)).code!.text.length).toBeGreaterThan(typed);
});

test('a pin ends on Follow playback, on the playback tab, and on any press that moves playback, but not on Pause', async ($, on) => {
  const w = world(on);
  // The engine's drawing of a call row, which the chip goes under.
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await threeFiles($, w);
  const pinned = async () => (await look($)).viewing !== undefined;
  const pin = async () => {
    await press($, 'tab:/w/src/a.ts');
    expect(await pinned()).toBe(true);
  };

  await pin();
  await press($, 'follow');
  expect(await pinned()).toBe(false);
  expect((await look($)).code?.path).toBe('/w/src/b.ts');

  await pin();
  await press($, 'tab:/w/src/b.ts');
  expect(await pinned()).toBe(false);

  await pin();
  await press($, 'pause');
  expect(await pinned()).toBe(true);
  await press($, 'pause');
  expect(await pinned()).toBe(true);

  await pin();
  await pressRow($, 2);
  expect(await pinned()).toBe(false);

  await pin();
  await pressChip($, 'toolu_src/b.ts');
  expect(await pinned()).toBe(false);

  await pin();
  await press($, 'finish');
  expect(await pinned()).toBe(false);

  await w.clock.advance(1_000);
  await pin();
  await press($, 'skip');
  expect(await pinned()).toBe(false);

  await pin();
  await press($, 'start');
  expect(await pinned()).toBe(false);
});

test('the code view is a unified diff: a changed line shows removed then added, and removed lines stay in view', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'one\ntwo\nthree\nfour\nfive\n' });
  await start($);
  await edit($, 'a.ts', 'two\n', 'TWO\n');
  await w.clock.advance(5_000);
  let v = await look($);
  expect(v.code?.format).toBe('diff');
  expect(v.marks).toEqual(['-two', '+TWO']);

  await edit($, 'a.ts', 'four\nfive\n', '');
  await w.clock.advance(5_000);
  v = await look($);
  expect(v.marks).toEqual(['-two', '+TWO', '-four', '-five']);
  expect(v.code?.text).toBe('one\nTWO\nthree\n');
});

test('lines a long deletion removes are drawn removed for 400 ms before they go', async ($, on) => {
  const w = world(on);
  await start($);
  const body = 'keep\n' + 'gone line 1();\ngone line 2();\ngone line 3();\n' + 'end\n';
  await write($, 'a.ts', body);
  await w.clock.advance(10_000);
  await edit($, 'a.ts', 'gone line 1();\ngone line 2();\ngone line 3();\n', '');
  const seen: number[] = [];
  for (let t = 50; t <= 3_000; t += 50) {
    await w.clock.advance(50);
    const v = await look($);
    if (v.code?.rows.includes('-gone line 1();')) seen.push(t);
  }
  expect(seen.length * 50).toBe(400);
  expect(seen.at(-1)! - seen[0]! + 50).toBe(400);
  // They were typed since the baseline, so once gone they leave no mark.
  expect((await look($)).marks).toEqual(['+keep', '+end']);
});

test('Clear marks leaves no marks, and a change after it is marked against what was there', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'a\n', '/w/b.ts': 'b\n' });
  await start($);
  await edit($, 'a.ts', 'a\n', 'a\nA\n');
  await edit($, 'b.ts', 'b\n', 'b\nB\n');
  await w.clock.advance(5_000);
  expect((await look($)).marks).toEqual(['+B']);
  await press($, 'clear-marks');
  expect((await look($)).marks).toEqual([]);
  await press($, 'tab:/w/a.ts');
  expect((await look($)).marks).toEqual([]);
  await press($, 'follow');

  await edit($, 'a.ts', 'a\nA\n', 'a\nA\nAA\n');
  await w.clock.advance(5_000);
  expect((await look($)).marks).toEqual(['+AA']);
});

test('a seek back past a clear brings the marks back', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'top\n' });
  await start($);
  await edit($, 'a.ts', 'top\n', 'top\nL1\n');
  await edit($, 'a.ts', 'L1\n', 'L1\nL2\n');
  await edit($, 'a.ts', 'L2\n', 'L2\nL3\n');
  await w.clock.advance(5_000);
  await press($, 'clear-marks');
  expect((await look($)).marks).toEqual([]);
  await pressRow($, 2);
  await w.clock.advance(5_000);
  expect((await look($)).marks).toEqual(['+L1', '+L2', '+L3']);
});

test('clears survive a reload; a pin does not', async ($, on) => {
  const w = world(on);
  const saved = {
    changes: [
      { id: 'toolu_1', number: 1, tool: 'Write', path: '/w/a.ts', kind: 'create', time: 1 },
      { id: 'toolu_2', number: 2, tool: 'Write', path: '/w/b.ts', kind: 'create', time: 2 },
    ],
    played: 2,
    recorded: 2,
    isPaused: false,
  };
  seed(on, { shape: 'saved-4', value: saved }, { 'toolu_1:before': '', 'toolu_1:after': 'a\n', 'toolu_2:before': '', 'toolu_2:after': 'b\n' });
  stored(on, 'marks', { shape: 'marks-1', value: { clears: [{ at: 3 }] } });
  stored(on, 'tabs', { shape: 'tabs-1', value: { tabs: [{ path: '/w/a.ts', last: 1 }, { path: '/w/b.ts', last: 2 }], shown: '/w/b.ts', pinned: '/w/a.ts' } });
  await start($);
  await w.clock.settle();
  const v = await look($);
  expect(v.marks).toEqual([]);
  expect(v.viewing).toBeUndefined();
  expect(v.tabs).toEqual(['a.ts', 'b.ts*']);
});

test('tabs that do not fit two rows leave out the files typed longest ago, keep the shown one, and say how many are left out', async ($, on) => {
  const w = world(on);
  await start($);
  for (let i = 1; i <= 30; i++) await write($, `file${i}.ts`, `${i}\n`);
  await press($, 'skip');
  await w.clock.advance(0);
  const v = await look($, 40);
  expect(v.tabs.at(-1)).toBe('file30.ts*');
  expect(v.more).toMatch(/^\d+ more$/);
  expect(v.tabs.length + Number(v.more!.split(' ')[0])).toBe(30);
  expect(v.tabs.length).toBeLessThanOrEqual(6);
  expect(v.tabs).not.toContain('file1.ts');
});
