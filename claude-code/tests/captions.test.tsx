// Captions: what the agent wrote before each Edit or Write call, read from the
// rows each loop keeps, shown over the code and in a hover card on the row.

import type { On } from 'claude-code';
import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, kept, seed, start, world } from './world';

const PANE = {
  plugin: 'agent-typewriter',
  component: 'Pane',
  requestId: PANE_ID,
  props: {
    title: 'Agent Typewriter',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

type Block = { type: string; [field: string]: unknown };
const say = (text: string): Block => ({ type: 'text', text });
const edit = (id: string): Block => ({ type: 'tool_use', id, name: 'Edit', input: {} });
const writeCall = (id: string): Block => ({ type: 'tool_use', id, name: 'Write', input: {} });

/** What the engine stores for each row, by default the row as it came; a test may change it. */
type Store = { rows: { door: string; content: Block[]; agentId?: string }[]; keep: (content: Block[]) => unknown };

/** Watches the rows the engine keeps beneath the plugin, and rewrites them there as `keep` says, as another plugin could. */
function conversation(on: On): Store {
  const store: Store = { rows: [], keep: (content) => content };
  on('session.append', (_, e, next) => {
    store.rows.push({ door: e.door, content: e.message.content as Block[], ...(e.agentId !== undefined && { agentId: e.agentId }) });
    return next({ ...e, message: { ...e.message, content: store.keep(e.message.content as Block[]) as Block[] } });
  });
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, () => ({}));
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  return store;
}

let uuid = 0;

/** The engine keeps a row of the loop of `agentId` (main when absent) that came in by `door`; resolves to what the plugin hands back. */
async function keep($: Engine, door: string, content: Block[], agentId?: string) {
  const append = $.session.append as unknown as (e: object) => Promise<unknown>;
  const message = door === 'response' ? { type: 'assistant', role: 'assistant', content } : { type: 'user', role: 'user', content };
  const origin = door === 'response' ? { kind: 'model', model: 'm' } : { kind: 'tool', tool: 'Edit' };
  return append({ message, door, origin, uuid: `u${++uuid}`, ...(agentId !== undefined && { agentId }) });
}

/** Writes `/w/<name>` from the call `id`, in the loop of `agentId`. */
async function write($: Engine, name: string, id: string, agentId?: string, content = `${name}\n`) {
  await $.tool.call({ tool: 'Write', file_path: `/w/${name}`, content, tool_use_id: id, ...(agentId !== undefined && { agentId }) });
}

/** The caption saved for change `id`, as its `text` member holds it. */
function captionOf(w: ReturnType<typeof world>, id: string) {
  return w.texts.get(`${id}:caption`) || undefined;
}

/** What the pane draws: the caption band's text, and the Code element's first line. */
async function look($: Engine, bodyRows = 20, bodyColumns = 80) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns, scroll: { offset: 0, bodyRows } } } as never);
  const band = (await ui.findAll({ type: 'Text' })).find((t) => t.props.italic && t.text.startsWith('“'));
  const code = (await ui.find({ type: 'Code' }))?.props as { source: string } | undefined;
  const note = (await ui.find({ type: 'Text', text: /too large/ }))?.text;
  await ui.unmount();
  return { band: band?.text, codeRows: code?.source.split('\n').length, note };
}

/** The hover card under the row of change `id`, if the pane draws one. */
async function card($: Engine, id: string, bodyRows = 20) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, scroll: { offset: 0, bodyRows } } } as never);
  const row = byKey(await ui.drawn(), `row:${id}`);
  await ui.unmount();
  expect(row).toBeDefined();
  const found = row!.children?.find((c): c is Drawn => (c as Drawn)?.props?.position === 'absolute');
  return found && { props: found.props!, hover: found.hover, text: textOf(found) };
}

/** An element of a drawn tree; the surface's `hover` overrides sit beside its props. */
type Drawn = { type?: string; key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] };

/** The element keyed `key` in a drawn tree. */
function byKey(x: unknown, key: string): Drawn | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const d = x as Drawn;
  if (d.key === key || d.props?.key === key) return d;
  for (const c of d.children ?? []) {
    const found = byKey(c, key);
    if (found) return found;
  }
  return undefined;
}

/** The strings beneath a drawn element, in order. */
function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  const children = (x as { children?: unknown[] })?.children;
  return Array.isArray(children) ? children.map(textOf).join('') : '';
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  await ui.press({ key });
  await ui.unmount();
}

test('a main conversation change keeps the text before its call', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say("Now I'll guard the login route."), writeCall('toolu_a')]);
  await write($, 'login.ts', 'toolu_a');

  expect(captionOf(w, 'toolu_a')).toBe("Now I'll guard the login route.");
});

test("two subagents' captions stay with their own changes", async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Covering the refill.')], 'a1');
  await keep($, 'response', [say('Signup gets the same guard.')], 'a2');
  await keep($, 'response', [writeCall('toolu_t')], 'a1');
  await keep($, 'response', [writeCall('toolu_s')], 'a2');
  await write($, 'limiter.test.ts', 'toolu_t', 'a1');
  await write($, 'signup.ts', 'toolu_s', 'a2');

  expect(captionOf(w, 'toolu_t')).toBe('Covering the refill.');
  expect(captionOf(w, 'toolu_s')).toBe('Signup gets the same guard.');
});

test('a caption kept after its change was recorded is set on it', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await write($, 'a.ts', 'toolu_a', undefined, 'x'.repeat(299) + '\n');
  expect(captionOf(w, 'toolu_a')).toBeUndefined();
  await keep($, 'response', [say('Late words.'), writeCall('toolu_a')]);
  await w.clock.advance(100);

  expect(captionOf(w, 'toolu_a')).toBe('Late words.');
  expect((await look($)).band).toBe('“Late words.”');
});

test('a call with no text before it, or after a tool result, has no caption', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Let me read the file.'), { type: 'tool_use', id: 'toolu_r', name: 'Read', input: {} }]);
  await keep($, 'tool-result', [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'text' }]);
  await keep($, 'response', [writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');
  await w.clock.advance(100);

  expect(captionOf(w, 'toolu_a')).toBeUndefined();
  expect((await look($)).band).toBeUndefined();
});

test("a turn's end forgets its loop's text", async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Dangling words.')]);
  await ($.turn.complete as unknown as (e: object) => Promise<unknown>)({ turnId: 't1', reason: 'answer', answer: '' });
  await keep($, 'response', [writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');

  expect(captionOf(w, 'toolu_a')).toBeUndefined();
});

test("the conversation's rows are stored and handed back as the engine keeps them", async ($, on) => {
  world(on);
  const store = conversation(on);
  // Another plugin's rewrite, made where the row is stored.
  store.keep = (content) => content.map((b) => (b.type === 'text' ? { ...b, text: String(b.text).replace('hunter2', '***') } : b));
  await start($);
  const blocks = [say('Rotate hunter2 now.'), edit('toolu_e')];
  const handed = await keep($, 'response', blocks);

  expect(store.rows).toEqual([{ door: 'response', content: blocks }]);
  expect(handed).toMatchObject({ message: { type: 'assistant', role: 'assistant', content: [say('Rotate *** now.'), edit('toolu_e')] }, uuid: `u${uuid}` });
});

test('the caption is the text as the conversation keeps it', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'key = hunter2\n' });
  const store = conversation(on);
  store.keep = (content) => content.map((b) => (b.type === 'text' ? { ...b, text: String(b.text).replace('hunter2', '***') } : b));
  await start($);
  await keep($, 'response', [say('Rotate hunter2\n\nnow.'), edit('toolu_e')]);
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'hunter2', new_string: 'x', tool_use_id: 'toolu_e' });

  expect(captionOf(w, 'toolu_e')).toBe('Rotate *** now.');
});

test('rows of other blocks and doors leave the recording alone', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [{ type: 'redacted_thinking', data: 'x' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]);
  await keep($, 'attachment', [say('a reminder')]);
  await keep($, 'response', [writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');

  expect(kept(w).map((c) => c.id)).toEqual(['toolu_a']);
  expect(captionOf(w, 'toolu_a')).toBeUndefined();
});

test('nothing is recorded or captioned in a session drawn only on the terminal', async ($, on) => {
  const w = world(on);
  conversation(on);
  w.surfaces = ['terminal'];
  await start($, 'terminal');
  await keep($, 'response', [say('Words.'), writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');

  expect(w.texts.size).toBe(0);
});

test('a reload keeps the caption, in the pane and in the row', async ($, on) => {
  world(on);
  const saved = { changes: [{ id: 'r', number: 1, tool: 'Write', path: '/w/r.ts', kind: 'create', time: 1 }], played: 1, recorded: 1, isPaused: false };
  seed(on, { shape: 'saved-4', value: saved }, { 'r:before': '', 'r:after': 'kept\n', 'r:caption': 'Keep it.' });
  await start($);

  expect((await look($)).band).toBe('“Keep it.”');
  expect((await card($, 'r'))?.text).toBe('Keep it.');
});

test('changes saved before captions load with no caption', async ($, on) => {
  const changes = [
    { id: 'r', number: 1, tool: 'Write', path: '/w/r.ts', kind: 'create', time: 1, turnId: 't1', mainTurnId: 't1' },
    { id: 's', number: 2, tool: 'Edit', path: '/w/s.ts', kind: 'modify', time: 2 },
  ];
  const w = world(on);
  seed(on, { shape: 'saved-4', value: { changes, played: 1, recorded: 2, isPaused: true } }, { 'r:before': '', 'r:after': 'kept\n', 's:before': 'old\n', 's:after': 'new\n' });
  await start($);
  await w.clock.advance(100);

  expect(w.saved).toEqual({ changes, played: 1, recorded: 2, isPaused: true });
  expect((await look($)).band).toBeUndefined();
  expect(await card($, 'r')).toBeUndefined();
  expect(await card($, 's')).toBeUndefined();
});

test('a dropped change blanks its caption with its texts', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('First.'), writeCall('toolu_0')]);
  await write($, 'f0.ts', 'toolu_0');
  expect(captionOf(w, 'toolu_0')).toBe('First.');
  for (let i = 1; i <= 200; i++) await write($, `f${i}.ts`, `toolu_${i}`);
  await w.clock.advance(100);

  expect(w.saved.changes.some((c) => c.id === 'toolu_0')).toBe(false);
  expect(w.texts.get('toolu_0:caption')).toBe('');
});

test('the band shows the caption in quotes over the code while typing, paused, cued and done', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Export it from the auth index.'), writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a', undefined, 'x'.repeat(299) + '\n');
  await keep($, 'response', [writeCall('toolu_b')]);
  await keep($, 'tool-result', [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '' }]);
  await keep($, 'response', [writeCall('toolu_c')]);
  await write($, 'c.ts', 'toolu_c', undefined, 'y\n');
  await w.clock.advance(200);

  const typing = await look($);
  expect(typing.band).toBe('“Export it from the auth index.”');
  await press($, 'pause');
  expect((await look($)).band).toBe('“Export it from the auth index.”');
  await press($, 'finish');
  expect((await look($)).band).toBe('“Export it from the auth index.”');
  await press($, 'pause');
  await w.clock.advance(5_000);
  // The next change has no caption: no band, and the code takes its row back.
  expect((await look($)).band).toBeUndefined();

  await press($, 'pause');
  await press($, `change:toolu_a`);
  expect((await look($)).band).toBe('“Export it from the auth index.”');
  await press($, 'pause');
  await press($, 'skip');
  expect((await look($)).band).toBeUndefined();
});

test('the code gives up the rows the band takes', async ($, on) => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  world(on, { '/w/p.ts': long, '/w/q.ts': long });
  conversation(on);
  await start($);
  const change = (path: string, id: string) =>
    $.tool.call({ tool: 'Edit', file_path: path, old_string: 'line 20', new_string: 'line twenty', tool_use_id: id });
  await change('/w/p.ts', 'toolu_p');
  await keep($, 'response', [say('One line.'), edit('toolu_q')]);
  await change('/w/q.ts', 'toolu_q');
  await press($, 'pause');
  await press($, 'change:toolu_p');
  const plain = await look($);
  await press($, 'change:toolu_q');
  const captioned = await look($);

  expect(plain.band).toBeUndefined();
  expect(captioned.band).toBe('“One line.”');
  expect(captioned.codeRows).toBe(plain.codeRows! - 1);
});

test('a long caption shows three lines, the last cut with an ellipsis', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('word '.repeat(200)), writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');
  await w.clock.advance(100);
  const { band } = await look($, 20, 40);

  const lines = band!.split('\n');
  expect(lines.length).toBe(3);
  expect(lines.every((l) => l.length <= 38)).toBe(true);
  expect(lines[2]!.endsWith('…')).toBe(true);
});

test('a too-large change shows its caption above the note', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Regenerate the lockfile.'), writeCall('toolu_big')]);
  await write($, 'big.json', 'toolu_big', undefined, 'x'.repeat(1_000_001));
  await w.clock.advance(100);

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text);
  await ui.unmount();
  const band = texts.findIndex((t) => t === '“Regenerate the lockfile.”');
  const note = texts.findIndex((t) => /too large to replay/.test(t));
  expect(band).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(band);
});

test("the list's wheel scrolls the right rows with a band over the code", async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  for (let i = 1; i <= 30; i++) {
    await keep($, 'response', [say(`Change ${i}.`), writeCall(`toolu_${i}`)]);
    await write($, `f${i}.ts`, `toolu_${i}`);
  }
  await press($, 'start');
  const scroll = $.ui.scroll as unknown as (e: object) => Promise<unknown>;
  const numbers = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
    const rows = (await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('change:')).map((b) => Number(/#(\d+) /.exec(b.text)![1]));
    await ui.unmount();
    return rows;
  };
  expect((await look($)).band).toBe('“Change 1.”');
  const before = await numbers();
  expect(before).toEqual([1, 2, 3, 4, 5, 6, 7]);
  // Rows: the header, the band, the code, the controls, the Changes line, then the list.
  const wheel = (row: number) =>
    scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by: 5, bodyRows: 20, contentRows: 19, origin: { kind: 'person' }, pointer: { row, column: 4 } });
  await wheel(4);
  expect(await numbers()).toEqual(before);
  await wheel(5);
  expect(await numbers()).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  await w.clock.advance(0);
});

test('a row with a caption has a card hidden until hovered, above the row; a row without has none', async ($, on) => {
  world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('Trust the proxy so the limiter sees client addresses.'), writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');
  await keep($, 'tool-result', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '' }]);
  await write($, 'b.ts', 'toolu_b');

  const a = await card($, 'toolu_a');
  expect(a?.text).toBe('Trust the proxy so the limiter sees client addresses.');
  expect(a?.props).toMatchObject({ position: 'absolute', display: 'none', bottom: 1 });
  expect(a?.hover).toEqual({ display: 'flex' });
  expect(a?.props.top).toBeUndefined();
  expect(await card($, 'toolu_b')).toBeUndefined();
});

test('a long caption fits the card, and pressing a row with a card still plays from it', async ($, on) => {
  const w = world(on);
  conversation(on);
  await start($);
  await keep($, 'response', [say('word '.repeat(200)), writeCall('toolu_a')]);
  await write($, 'a.ts', 'toolu_a');
  await write($, 'b.ts', 'toolu_b', undefined, 'x'.repeat(299) + '\n');
  await w.clock.advance(60_000);

  const a = await card($, 'toolu_a');
  const lines = a!.text.split('\n');
  expect(lines.length).toBeLessThanOrEqual(6);
  expect(lines.at(-1)!.endsWith('…')).toBe(true);

  await press($, 'change:toolu_a');
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never);
  const number = (await ui.find({ type: 'Text', text: /^#\d+$/ }))?.text;
  await ui.unmount();
  expect(number).toBe('#1');
});
