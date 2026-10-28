import { expect, test } from 'claude-code/testing';

import { start, world } from './world';

test('an Edit is recorded with the text before and after it', async ($, on) => {
  const w = world(on, { '/w/app.ts': 'const a = 1;\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/app.ts', old_string: '1', new_string: '2' });

  const { queue } = w.deck;
  expect(queue.length).toBe(1);
  expect(queue[0]).toMatchObject({ path: '/w/app.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' });
  expect(w.writes).toEqual([]);
});

test('a Write of a new file is recorded with empty before text', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/notes.md', content: '# Notes\n' });

  const { queue } = w.deck;
  expect(queue[0]).toMatchObject({ path: '/w/notes.md', before: '', after: '# Notes\n' });
});

test("a subagent's Write is recorded", async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/sub.md', content: 'hi\n', agentId: 'a1' });

  expect(w.deck.queue.length).toBe(1);
});

test('two edits to one file are recorded as two changes', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  await start($);
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'A', new_string: 'B' });
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'B', new_string: 'C' });

  const { queue } = w.deck;
  expect(queue.map((c) => [c.before, c.after])).toEqual([
    ['A\n', 'B\n'],
    ['B\n', 'C\n'],
  ]);
});

test('a refused call records nothing and its refusal reaches Claude', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' }, () => ({ deny: 'The user declined.' }));
  await start($);
  const ran = await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'B\n' });

  expect(ran.deny).toBe('The user declined.');
  expect(w.deck.queue.length).toBe(0);
  expect(w.files.get('/w/a.ts')).toBe('A\n');
});

test('a failed Edit records nothing', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'A\n' });
  await start($);
  const ran = await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'missing', new_string: 'x' });

  expect(ran.isError).toBe(true);
  expect(w.deck.queue.length).toBe(0);
});

test('a Write that leaves the file unchanged records nothing', async ($, on) => {
  const w = world(on, { '/w/a.ts': 'same\n' });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: 'same\n' });

  expect(w.deck.recorded).toBe(0);
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
  expect(w.deck.queue.length).toBe(0);
});

test('a Bash write is not recorded', async ($, on) => {
  const w = world(on);
  await start($);
  await $.tool.call({ tool: 'Bash', command: 'echo hi > out.txt' });

  expect(w.deck.recorded).toBe(0);
});

test('a file over the replay limit is recorded without its text', async ($, on) => {
  const w = world(on, { '/w/big.json': '' });
  await start($);
  await $.tool.call({ tool: 'Write', file_path: '/w/big.json', content: 'x'.repeat(1_000_001) });

  const { queue } = w.deck;
  expect(queue[0]).toMatchObject({ path: '/w/big.json', before: '', after: '', isTooLarge: true });
});
