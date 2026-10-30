// What sits beneath the plugin in its tests: an in-memory file system, the
// file tools acting on it, and the engine calls the plugin makes at start.
// It also watches what the plugin writes to $.state.

import type { On, RenderSurface, Shaped, ToolCallResult } from 'claude-code';
import { mock, type Engine, type MockClock } from 'claude-code/testing';

import type { Saved, View } from '../types';

export const PANE_ID = 'agent-typewriter';

export type World = {
  files: Map<string, string>;
  clock: MockClock;
  /** The plugin's `saved` as it last wrote it. */
  saved: Saved;
  /** The plugin's `text` members as it last wrote them, by member id. */
  texts: Map<string, string>;
  /** Every `view` the plugin wrote, in order. */
  views: View[];
  /** Pane ids `$.ui.open` was called with, in order. */
  opens: string[];
  /** Paths `$.fs.read` was called with, in order. */
  reads: string[];
  /** Paths `$.fs.write` was called with; the plugin must never write. */
  writes: string[];
  /** Makes every later `$.fs.read` fail. */
  breakReads: () => void;
  /** What `$.session.surfaces()` answers; a test may change it. */
  surfaces: RenderSurface[];
};

/** Answers a Write in place of the in-memory one, as a refusal or a tool of its own would. */
type WriteAnswer = (e: { file_path: string; content: string }, files: Map<string, string>) => ToolCallResult;

export function world(on: On, files: Record<string, string> = {}, write?: WriteAnswer): World {
  const w: World = {
    files: new Map(Object.entries(files)),
    clock: mock.clock(on),
    saved: { changes: [], recorded: 0, isPaused: false },
    texts: new Map(),
    views: [],
    opens: [],
    reads: [],
    writes: [],
    breakReads: () => (isBroken = true),
    surfaces: ['desktop'],
  };
  let isBroken = false;
  // Each write to a file moves its modification time on.
  const mtimes = new Map<string, number>();
  let now = 1;
  const put = (path: string, content: string) => {
    w.files.set(path, content);
    mtimes.set(path, now++);
  };

  on('fs.stat', (_, e) => {
    const content = w.files.get(e.path);
    if (content === undefined) return { deny: `ENOENT: ${e.path}` };
    const size = new TextEncoder().encode(content).length;
    return { value: { kind: 'file', size, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } };
  });
  on('fs.read', (_, e) => {
    w.reads.push(e.path);
    const content = w.files.get(e.path);
    if (isBroken || content === undefined) return { deny: `EACCES: ${e.path}` };
    return { value: content };
  });
  on('fs.write', (_, e) => {
    w.writes.push(e.path);
    return { value: undefined };
  });
  on('state.set', { plugin: 'agent-typewriter', key: 'saved' }, (_, e, next) => {
    w.saved = (e.value as Shaped<Saved>).value;
    return next(e);
  });
  on('state.set', { plugin: 'agent-typewriter', key: 'text' }, (_, e, next) => {
    w.texts.set(String(e.id), e.value as string);
    return next(e);
  });
  on('state.set', { plugin: 'agent-typewriter', key: 'view' }, (_, e, next) => {
    w.views.push((e.value as Shaped<View>).value);
    return next(e);
  });
  on('command.register', () => ({ value: { command: 'typewriter' } }));
  on('ui.open', (_, e) => {
    w.opens.push(e.id);
    return { value: { isPlaced: true } };
  });
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.surfaces', () => ({ value: w.surfaces }));

  // The file tools, acting on the in-memory files.
  on('tool.call', { tool: 'Edit' }, (_, e) => {
    const content = w.files.get(e.file_path);
    if (content === undefined || !content.includes(e.old_string)) return { result: {}, isError: true, text: 'old_string not found' };
    put(e.file_path, e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, () => e.new_string));
    return { result: {} };
  });
  on('tool.call', { tool: 'Write' }, (_, e) => {
    if (write) return write(e, w.files);
    put(e.file_path, e.content);
    return { result: {} };
  });
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }));

  return w;
}

/** The waiting changes the plugin saved, with the texts it saved for them. */
export function waiting(w: World) {
  return w.saved.changes.map((c) => ({ ...c, before: w.texts.get(`${c.id}:before`), after: w.texts.get(`${c.id}:after`) }));
}

export async function start($: Engine, surface: 'terminal' | 'desktop' | 'vscode' = 'desktop') {
  await $.session.start({ cwd: '/w', surface, isInteractive: true });
}
