// What sits beneath the plugin in its tests: an in-memory file system, the
// file tools acting on it, and the engine calls the plugin makes at start.

import type { On, Shaped, ToolCallResult } from 'claude-code';
import { mock, type Engine, type MockClock } from 'claude-code/testing';

import { emptyDeck, type Deck } from '../hooks/replay';

export const PANE_ID = 'agent-typewriter';

export type World = {
  files: Map<string, string>;
  clock: MockClock;
  /** The plugin's deck as it last wrote it. */
  deck: Deck;
  /** Pane ids `$.ui.open` was called with, in order. */
  opens: string[];
  /** Paths `$.fs.write` was called with; the plugin must never write. */
  writes: string[];
  /** Makes every later `$.fs.read` fail. */
  breakReads: () => void;
};

/** Answers a Write in place of the in-memory one, as a refusal or a tool of its own would. */
type WriteAnswer = (e: { file_path: string; content: string }, files: Map<string, string>) => ToolCallResult;

export function world(on: On, files: Record<string, string> = {}, write?: WriteAnswer): World {
  const w: World = {
    files: new Map(Object.entries(files)),
    clock: mock.clock(on),
    deck: emptyDeck,
    opens: [],
    writes: [],
    breakReads: () => (isBroken = true),
  };
  let isBroken = false;

  on('fs.stat', (_, e) => {
    const text = w.files.get(e.path);
    if (text === undefined) return { deny: `ENOENT: ${e.path}` };
    return { value: { kind: 'file', size: new TextEncoder().encode(text).length, mtimeMs: 0, isLink: false } };
  });
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path);
    if (isBroken || text === undefined) return { deny: `EACCES: ${e.path}` };
    return { value: text };
  });
  on('fs.write', (_, e) => {
    w.writes.push(e.path);
    return { value: undefined };
  });
  on('state.set', { plugin: 'agent-typewriter', key: 'deck' }, (_, e, next) => {
    w.deck = (e.value as Shaped<Deck>).value;
    return next(e);
  });
  on('command.register', () => ({ value: { command: 'typewriter' } }));
  on('ui.open', (_, e) => {
    w.opens.push(e.id);
    return { value: { isPlaced: true } };
  });
  on('session.start', (_, e) => ({ cwd: e.cwd }));

  // The file tools, acting on the in-memory files.
  on('tool.call', { tool: 'Edit' }, (_, e) => {
    const text = w.files.get(e.file_path);
    if (text === undefined || !text.includes(e.old_string)) return { result: {}, isError: true, text: 'old_string not found' };
    const next = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
    w.files.set(e.file_path, next);
    return { result: {} };
  });
  on('tool.call', { tool: 'Write' }, (_, e) => {
    if (write) return write(e, w.files);
    w.files.set(e.file_path, e.content);
    return { result: {} };
  });
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }));

  return w;
}

export async function start($: Engine, surface: 'terminal' | 'desktop' | 'vscode' = 'desktop') {
  await $.session.start({ cwd: '/w', surface, isInteractive: true });
}
