import { expect, test, type Engine } from 'claude-code/testing';

import { PANE_ID, start, world } from './world';

// The plugin draws nothing on the terminal; that is the VS Code extension's.
const SURFACES = ['desktop', 'vscode', 'mobile'] as const;
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
async function look($: Engine, surface: Surface | 'terminal') {
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

  expect((await look($, 'desktop')).name).toBe('/tmp/scratch.ts');
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
  // The pane cuts the line at its width; the view holds all of it.
  expect(LINE.startsWith(code!.source.split('\n')[0]!)).toBe(true);
  expect(w.views[w.views.length - 1]!.lines.join('\n')).toBe(LINE);
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

test('/typewriter in a terminal session points to the VS Code extension and opens nothing', async ($, on) => {
  const w = world(on);
  w.surfaces = ['terminal'];
  await start($, 'terminal');
  const ran = await $.command.run({
    command: 'typewriter',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 200 },
  });
  expect(ran.text).toContain('Agent Typewriter extension for VS Code');
  expect(ran.text).toContain('desktop app');
  expect(w.opens).toEqual([]);
});

test('a session on the terminal and the desktop records and draws on the desktop, and draws nothing on the terminal', async ($, on) => {
  const w = world(on, { '/w/src/app.ts': BEFORE });
  w.surfaces = ['terminal', 'desktop'];
  // Stands in for what the engine draws when no plugin draws the pane.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, () => ({ type: 'Box' }));
  await start($, 'terminal');
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/app.ts', old_string: BEFORE, new_string: AFTER });
  await w.clock.advance(60_000);

  expect(w.saved.recorded).toBe(1);
  expect(w.opens).toEqual([PANE_ID]);
  const desktop = await look($, 'desktop');
  expect(desktop.name).toBe('src/app.ts');
  expect(desktop.code?.source).toBe(AFTER);

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.drawn()).toMatchObject({ type: 'Box' });
  for (const type of ['Text', 'Button', 'Code'] as const) expect(await ui.findAll({ type })).toEqual([]);
  await ui.unmount();
});

test('a file too large to replay is named and skipped', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'x'.repeat(1_000_001) });
  await $.tool.call({ tool: 'Write', file_path: '/w/next.ts', content: 'n\n' });
  await w.clock.advance(60);

  expect((await look($, 'desktop')).note).toBe('big.json is too large to replay.');
  await w.clock.advance(5_000);
  expect((await look($, 'desktop')).code?.source).toBe('n\n');
});

/**
 * Answers the plugin's reads of `saved` and of its `text` members with what an
 * earlier load stored, until it writes them itself, as a reload finds them.
 */
function seed(on: Parameters<typeof world>[0], saved: unknown, texts: Record<string, string> = {}) {
  let isSavedWritten = false;
  const written = new Set<string>();
  on('state.set', { plugin: 'agent-typewriter', key: 'saved' }, (_, e, next) => {
    isSavedWritten = true;
    return next(e);
  });
  on('state.set', { plugin: 'agent-typewriter', key: 'text' }, (_, e, next) => {
    written.add(String(e.id));
    return next(e);
  });
  on('state.get', { plugin: 'agent-typewriter', key: 'saved' }, async (_, e, next) => {
    const stored = await next(e);
    if (isSavedWritten || stored.deny !== undefined) return stored;
    return { value: { value: saved, version: stored.value.version } };
  });
  on('state.get', { plugin: 'agent-typewriter', key: 'text' }, async (_, e, next) => {
    const stored = await next(e);
    const id = String(e.id);
    if (written.has(id) || stored.deny !== undefined || !(id in texts)) return stored;
    return { value: { value: texts[id], version: stored.value.version } };
  });
}

const R = { id: 'r', path: '/w/r.ts', kind: 'create', time: 1_000 } as const;
const S = { id: 's', path: '/w/s.ts', kind: 'modify', time: 2_000 } as const;
const RS_TEXTS = { 'r:before': '', 'r:after': 'kept\n', 's:before': 'old\n', 's:after': 'new\n' };

test('after a reload, the saved changes play, the one that was being typed from its start', async ($, on) => {
  const w = world(on);
  seed(on, { shape: 'saved-2', value: { changes: [R, S], played: 0, recorded: 2, isPaused: false } }, RS_TEXTS);
  await start($);
  await w.clock.advance(60);
  expect((await look($, 'desktop')).name).toBe('r.ts');

  await w.clock.advance(10_000);
  const { name, code } = await look($, 'desktop');
  expect(name).toBe('s.ts');
  expect(code?.source).toBe('new\n');
});

test('after a reload, played changes stay played with their texts, kind and time, and only the waiting ones play', async ($, on) => {
  const w = world(on);
  const saved = { changes: [R, S], played: 1, recorded: 2, isPaused: false };
  seed(on, { shape: 'saved-2', value: saved }, RS_TEXTS);
  await start($);
  await w.clock.settle();
  expect(w.saved).toEqual(saved);
  // The pane picks up on the played change until the waiting one starts.
  const shown = await look($, 'desktop');
  expect([shown.name, shown.status, shown.code?.source]).toEqual(['r.ts', 'idle · 1 queued', 'kept\n']);

  await w.clock.advance(10_000);
  expect((await look($, 'desktop')).code?.source).toBe('new\n');
  expect(w.views.some((v) => v.path === '/w/r.ts' && v.isTyping)).toBe(false);
  expect(w.saved).toEqual({ ...saved, played: 2 });
  expect(w.texts.size).toBe(0);
});

test('after a reload with every change played, the pane shows the last one done and types nothing', async ($, on) => {
  const w = world(on);
  seed(on, { shape: 'saved-2', value: { changes: [R, S], played: 2, recorded: 2, isPaused: false } }, RS_TEXTS);
  await start($);
  await w.clock.advance(5_000);

  const { name, status, code } = await look($, 'desktop');
  expect([name, status, code?.source]).toEqual(['s.ts', 'idle', 'new\n']);
  expect(w.views.length > 0 && w.views.every((v) => !v.isTyping)).toBe(true);
});

test('after a reload, changes saved by the earlier saved-1 shape play', async ($, on) => {
  const w = world(on);
  seed(
    on,
    { shape: 'saved-1', value: { changes: [{ id: 'r', path: '/w/r.ts' }, { id: 's', path: '/w/s.ts' }], recorded: 2, isPaused: false } },
    RS_TEXTS,
  );
  await start($);
  await w.clock.advance(60);
  expect((await look($, 'desktop')).name).toBe('r.ts');

  await w.clock.advance(10_000);
  expect((await look($, 'desktop')).code?.source).toBe('new\n');
  expect(w.saved.changes).toEqual([
    { id: 'r', path: '/w/r.ts', kind: 'modify', time: 0 },
    { id: 's', path: '/w/s.ts', kind: 'modify', time: 0 },
  ]);
  expect(w.saved.played).toBe(2);
});

test('after a reload, a pause is kept', async ($, on) => {
  const w = world(on);
  seed(on, { shape: 'saved-2', value: { changes: [R], played: 0, recorded: 1, isPaused: true } }, { 'r:before': '', 'r:after': 'x\n' });
  await start($);
  await w.clock.advance(5_000);

  expect((await look($, 'desktop')).status).toBe('paused · 1 queued');
});

test('after a reload, saved changes in another shape are dropped', async ($, on) => {
  const w = world(on);
  seed(on, { queue: [{ id: 'r', path: '/w/r.ts', before: '', after: 'old\n' }] });
  await start($);
  await w.clock.advance(5_000);

  expect((await look($, 'desktop')).name).toBe('No changes yet');
});

test('natural order works in a CRLF file', async ($, on) => {
  const w = world(on, { '/w/win.ts': 'top\r\n' });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/win.ts', content: 'top\r\nfunction f() {\r\n  return 1;\r\n}\r\n' });
  await w.clock.advance(10_000);

  const frames = w.views.map((v) => v.lines.join('\n'));
  expect(frames.some((t) => t.includes('}') && !t.includes('return'))).toBe(true);
  expect(frames[frames.length - 1]).toBe('top\nfunction f() {\n  return 1;\n}\n');
});

test('a file with control characters still draws, each shown as a symbol', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/ff.py', content: 'a = 1\n\f\nb = 2\x1b\n' });
  await w.clock.advance(5_000);

  for (const surface of SURFACES) {
    const { code } = await look($, surface);
    expect(code?.source).toBe('a = 1\n\u240c\nb = 2\u241b\n');
  }
});

test('an edit far along a long line keeps the caret in view while typing', async ($, on) => {
  const line = 'word '.repeat(1_400);
  const w = world(on, { '/w/long.txt': line + '\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/long.txt', old_string: line, new_string: line.slice(0, 5_000) + 'HEREISTHEEDIT ' + line.slice(5_000) });
  await w.clock.advance(500);

  const { status, code } = await look($, 'desktop');
  expect(status).toBe('typing');
  expect(code!.source.length < 1_000).toBe(true);
  expect(code!.source).toMatch(/HE[A-Z]*▍/);
});

test('a change inserting more than 6,000 characters is shown at once', async ($, on) => {
  const line = 'x'.repeat(300_000);
  const w = world(on, { '/w/min.js': line + '\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/min.js', old_string: 'xxxx', new_string: 'HERE' });
  await w.clock.advance(100);

  const { status, code } = await look($, 'desktop');
  expect(status).toBe('idle');
  expect(code!.source.length < 1_000).toBe(true);
});
