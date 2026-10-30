import { expect, test } from 'claude-code/testing';

import { start, waiting, world } from './world';

test('an Edit is recorded with the text before and after it', async ($, on) => {
  const w = world(on, { '/w/app.ts': 'const a = 1;\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/app.ts', old_string: '1', new_string: '2' });

  expect(waiting(w)).toEqual([{ id: expect.any(String), path: '/w/app.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' }]);
  expect(w.writes).toEqual([]);
});

test('a Write of a new file is recorded with empty before text', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/notes.md', content: '# Notes\n' });

  expect(waiting(w)[0]).toMatchObject({ path: '/w/notes.md', before: '', after: '# Notes\n' });
});

test("a subagent's Write is recorded", async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/sub.md', content: 'hi\n', agentId: 'a1' });

  expect(w.saved.changes.length).toBe(1);
});

test('two edits to one file are recorded as two changes', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'A', new_string: 'B' });
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'B', new_string: 'C' });

  expect(waiting(w).map((c) => [c.before, c.after])).toEqual([
    ['A\n', 'B\n'],
    ['B\n', 'C\n'],
  ]);
});

test('CRLF line endings are recorded as LF', async ($, on) => {
  const w = world(on, { '/w/win.ts': 'a\r\nb\r\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/win.ts', old_string: 'b', new_string: 'c' });

  expect(waiting(w)[0]).toMatchObject({ before: 'a\nb\n', after: 'a\nc\n' });
});

test('a refused call records nothing and its refusal reaches Claude', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' }, () => ({ deny: 'The user declined.' }));
  await start($);
  const ran = await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'B\n' });

  expect(ran.deny).toBe('The user declined.');
  expect(w.saved.recorded).toBe(0);
  expect(w.files.get('/w/a.ts')).toBe('A\n');
});

test('a failed Edit records nothing', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  await start($);
  const ran = await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'missing', new_string: 'x' });

  expect(ran.isError).toBe(true);
  expect(w.saved.recorded).toBe(0);
});

test('a Write that leaves the file unchanged records nothing', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'same\n' });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'same\n' });

  expect(w.saved.recorded).toBe(0);
  expect(w.texts.size).toBe(0);
});

test('when the file cannot be read after the tool, its result reaches Claude unchanged', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' }, (e, files) => {
    files.set(e.file_path, e.content);
    w.breakReads();
    return { result: { marker: 'from the tool' } };
  });
  await start($);
  const ran = await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'B\n' });

  expect(ran.deny).toBe(undefined);
  expect(ran.result).toEqual({ marker: 'from the tool' });
  expect(w.saved.recorded).toBe(0);
});

test('a terminal session records nothing, reads nothing and opens nothing', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  w.surfaces = ['terminal'];
  await start($, 'terminal');
  const edited = await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'A', new_string: 'B' });
  const written = await $.tool.call({ tool: 'Write', file_path: '/w/b.ts', content: 'b\n' });

  expect(edited.result).toEqual({});
  expect(written.result).toEqual({});
  expect(w.files.get('/w/a.ts')).toBe('B\n');
  expect(w.files.get('/w/b.ts')).toBe('b\n');
  expect(w.saved.recorded).toBe(0);
  expect(w.texts.size).toBe(0);
  expect(w.reads).toEqual([]);
  expect(w.opens).toEqual([]);
});

test('a session with no surface still records', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  w.surfaces = [];
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'A', new_string: 'B' });

  expect(waiting(w)).toEqual([{ id: expect.any(String), path: '/w/a.ts', before: 'A\n', after: 'B\n' }]);
});

test('a Bash write is not recorded', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Bash', command: 'echo hi > out.txt' });

  expect(w.saved.recorded).toBe(0);
});

test('a file over the replay limit is recorded without its text', async ($, on) => {
  const w = world(on, { '/w/big.json': '' });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'x'.repeat(1_000_001) });

  expect(w.saved.changes).toEqual([{ id: expect.any(String), path: '/w/big.json', isTooLarge: true }]);
  expect(w.texts.size).toBe(0);
});

test('once a file was over the limit, neither text is read', async ($, on) => {
  const w = world(on, { '/w/big.json': 'x'.repeat(1_000_001) });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'small\n' });

  expect(w.reads).toEqual([]);
  expect(w.saved.changes).toEqual([{ id: expect.any(String), path: '/w/big.json', isTooLarge: true }]);
});

test('a large file left with the same size and time records nothing', async ($, on) => {
  const big = 'x'.repeat(1_000_001);
  const w = world(on, { '/w/big.json': big }, () => ({ result: {} }));
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: big });

  expect(w.saved.recorded).toBe(0);
  expect(w.reads).toEqual([]);
});

test('a finished change has its texts cleared', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'a\n' });
  const [id] = w.saved.changes.map((c) => c.id);
  expect(w.texts.get(`${id}:after`)).toBe('a\n');

  await w.clock.advance(5_000);
  expect(w.saved.changes).toEqual([]);
  expect(w.texts.get(`${id}:before`)).toBe('');
  expect(w.texts.get(`${id}:after`)).toBe('');
});

// The review's repro: a single $.state value is capped at 4,194,304 characters,
// and 45 queued changes to a 50 KB file hold about 5 MB of text.
test('many edits to a large file are all recorded and played', { options: { charsPerMinute: 60_000 }, timeoutMs: 60_000 }, async ($, on) => {
  const base = Array.from({ length: 1_500 }, (_, i) => `const line${i} = ${i}; // padding to make the file larger`).join('\n') + '\n';
  const w = world(on, { '/w/big.ts': base });
  await start($);
  for (let i = 0; i < 45; i++) {
    const block = Array.from({ length: 20 }, (_, j) => `// edit ${i} line ${j}`).join('\n') + '\n';
    await $.tool.call({ tool: 'Edit', file_path: '/w/big.ts', old_string: `const line${i * 30} = `, new_string: `${block}const line${i * 30} = ` });
  }
  expect(w.saved.recorded).toBe(45);
  expect(w.saved.changes.length).toBe(45);

  await w.clock.advance(60_000);
  const last = w.views[w.views.length - 1]!;
  expect(last.status).toBe('idle');
  expect(last.lines.join('\n')).toContain('// edit 44 line 19');
});
