import { expect, test, type Engine } from 'claude-code/testing';

import { emptyDeck, enqueue } from '../hooks/replay';
import { PANE_ID, start, world } from './world';

const SURFACES = ['terminal', 'desktop', 'vscode'] as const;
type Surface = (typeof SURFACES)[number];

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

/** What the pane draws on `surface`: the file's name, the status line, and the Code element's props. */
async function look($: Engine, surface: Surface) {
  const ui = await $.ui.mount({ ...PANE, surface });
  const name = (await ui.find({ type: 'Text', text: /^(?!.*(typing|paused|idle))/ }))?.text;
  const status = (await ui.find({ type: 'Text', text: /^(typing|paused|idle)/ }))?.text;
  const code = (await ui.find({ type: 'Code' }))?.props as { source: string; startLine: number; path: string } | undefined;
  const note = (await ui.find({ type: 'Text', text: /too large|typed out here/ }))?.text;
  await ui.unmount();
  return { name, status, code, note };
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  await ui.press({ key });
  await ui.unmount();
}

const BEFORE = 'function add(a, b) {\n  return a + b;\n}\n';
const AFTER = 'function add(a, b, c = 0) {\n  // sum\n  return a + b + c;\n}\n';

test('before anything is recorded, the pane says what it will show', async ($, on) => {
  world(on);
  await start($);
  for (const surface of SURFACES) {
    const { name, status, note } = await look($, surface);
    expect(name).toBe('No changes yet');
    expect(status).toBe('idle');
    expect(note).toBe('Edits Claude makes with Edit or Write are typed out here.');
  }
});

test('an edit is typed out with a caret and ends on the after text, on every surface', async ($, on) => {
  const w = world(on, { '/w/src/app.ts': BEFORE });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/app.ts', old_string: BEFORE, new_string: AFTER });

  await w.clock.advance(400);
  for (const surface of SURFACES) {
    const { name, status, code } = await look($, surface);
    expect(name).toBe('src/app.ts');
    expect(status).toBe('typing');
    expect(code?.source).toContain('▍');
    expect(code?.path).toBe('/w/src/app.ts');
  }

  await w.clock.advance(60_000);
  for (const surface of SURFACES) {
    const { status, code } = await look($, surface);
    expect(status).toBe('idle');
    expect(code?.source).toBe(AFTER);
    expect(code?.startLine).toBe(1);
  }
  expect(w.files.get('/w/src/app.ts')).toBe(AFTER);
  expect(w.writes).toEqual([]);
});

test('a file outside the working directory is named by its absolute path', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/tmp/scratch.ts', content: 'x\n' });
  await w.clock.advance(5_000);

  expect((await look($, 'terminal')).name).toBe('/tmp/scratch.ts');
});

test('the status counts the changes waiting to play', async ($, on) => {
  const w = world(on);
  await start($);
  for (const f of ['a', 'b', 'c']) await $.tool.call({ tool: 'Write', file_path: `/w/${f}.ts`, content: `${f}\n` });
  await w.clock.advance(60);

  expect((await look($, 'desktop')).status).toBe('typing · 2 queued');
});

test('an edit deep in a long file is shown around the caret with its line numbers', async ($, on) => {
  const text = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const w = world(on, { '/w/long.txt': text });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/long.txt', old_string: 'line 400\n', new_string: 'line 400 changed\n' });
  await w.clock.advance(60_000);

  const { code } = await look($, 'vscode');
  expect(code!.startLine > 380 && code!.startLine <= 400).toBe(true);
  expect(code!.source).toContain('line 400 changed');
  expect(code!.source).not.toContain('line 1\n');
});

const LINE = 'x'.repeat(299) + '\n';

test('at the default speed, 300 characters take about 18 seconds', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/s.ts', content: LINE });

  await w.clock.advance(17_000);
  expect((await look($, 'desktop')).status).toBe('typing');
  await w.clock.advance(2_000);
  expect((await look($, 'desktop')).status).toBe('idle');
});

test('charsPerMinute sets the speed', { options: { charsPerMinute: 3000 } }, async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/s.ts', content: LINE });

  await w.clock.advance(5_500);
  expect((await look($, 'desktop')).status).toBe('typing');
  await w.clock.advance(1_000);
  const { status, code } = await look($, 'desktop');
  expect(status).toBe('idle');
  expect(code?.source).toBe(LINE);
});

test('pause stops typing where it is and resume carries on', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/p.ts', content: 'one\ntwo\nthree\nfour\n' });
  await w.clock.advance(300);

  await press($, 'pause');
  const paused = await look($, 'desktop');
  expect(paused.status).toBe('paused');
  await w.clock.advance(5_000);
  expect((await look($, 'desktop')).code?.source).toBe(paused.code?.source);

  await press($, 'pause');
  await w.clock.advance(300);
  const resumed = await look($, 'desktop');
  expect(resumed.status).toBe('typing');
  expect(resumed.code?.source === paused.code?.source).toBe(false);
});

test('finish current shows that change done and the next one starts', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'alpha\nalpha\n' });
  await $.tool.call({ tool: 'Write', file_path: '/w/b.ts', content: 'beta\n' });
  await $.tool.call({ tool: 'Write', file_path: '/w/c.ts', content: 'gamma\n' });
  await w.clock.advance(120);

  await press($, 'finish');
  const done = await look($, 'desktop');
  expect(done.name).toBe('a.ts');
  expect(done.code?.source).toBe('alpha\nalpha\n');
  await w.clock.advance(60);
  const next = await look($, 'desktop');
  expect(next.name).toBe('b.ts');
  expect(next.status).toBe('typing · 1 queued');
});

test('skip to latest leaves nothing queued and shows the last change', async ($, on) => {
  const w = world(on);
  await start($);
  for (const f of ['a', 'b', 'c', 'd']) await $.tool.call({ tool: 'Write', file_path: `/w/${f}.ts`, content: `${f}\n` });
  await w.clock.advance(60);

  await press($, 'skip');
  const { name, status, code } = await look($, 'desktop');
  expect(name).toBe('d.ts');
  expect(status).toBe('idle');
  expect(code?.source).toBe('d\n');
});

test('the first recorded change opens the pane; later ones do not', async ($, on) => {
  const w = world(on);
  await start($);
  expect(w.opens).toEqual([]);
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'a\n' });
  await $.tool.call({ tool: 'Write', file_path: '/w/b.ts', content: 'b\n' });
  expect(w.opens).toEqual([PANE_ID]);
});

test('/typewriter opens the pane', async ($, on) => {
  const w = world(on);
  await start($);
  const ran = await $.command.run({
    command: 'typewriter',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  });
  expect(ran.text).toBe('Agent Typewriter pane opened.');
  expect(w.opens).toEqual([PANE_ID]);
});

test('a file too large to replay is named and skipped', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'x'.repeat(1_000_001) });
  await $.tool.call({ tool: 'Write', file_path: '/w/next.ts', content: 'n\n' });
  await w.clock.advance(60);

  expect((await look($, 'terminal')).note).toBe('big.json is too large to replay.');
  await w.clock.advance(5_000);
  expect((await look($, 'terminal')).code?.source).toBe('n\n');
});

/** Answers the plugin's reads of its deck with `value` until it first writes, as a reload finds what an earlier load stored. */
function seed(on: Parameters<typeof world>[0], value: unknown) {
  let isWritten = false;
  on('state.set', { plugin: 'agent-typewriter', key: 'deck' }, (_, e, next) => {
    isWritten = true;
    return next(e);
  });
  on('state.get', { plugin: 'agent-typewriter', key: 'deck' }, async (_, e, next) => {
    const stored = await next(e);
    if (isWritten || stored.deny !== undefined) return stored;
    return { value: { value, version: stored.value.version } };
  });
}

test('after a reload, a deck stored in this shape carries on', async ($, on) => {
  const w = world(on);
  seed(on, { shape: 'deck-2', value: enqueue(emptyDeck, { id: 'r', path: '/w/r.ts', before: '', after: 'kept\n' }) });
  await start($);
  await w.clock.advance(5_000);

  expect((await look($, 'desktop')).code?.source).toBe('kept\n');
});

test('after a reload, a deck stored in another shape is dropped', async ($, on) => {
  const w = world(on);
  seed(on, { queue: [{ id: 'r', path: '/w/r.ts', before: '', after: 'old\n' }] });
  await start($);
  await w.clock.advance(5_000);

  expect((await look($, 'desktop')).name).toBe('No changes yet');
});
