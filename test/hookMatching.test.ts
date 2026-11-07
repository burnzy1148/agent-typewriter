import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Correlator, HOOK_LATE_MS, RETRY_MS, SETTLE_MS, hookContext, matchHook, type CallSource } from '../src/agentContext';
import { HookLog, type HookEvent } from '../src/hookListener';
import { Timeline, type NewChangeEvent } from '../src/timeline';
import { TranscriptIndex, type ToolCall, type Turn } from '../src/transcripts';
import { ChangeItem } from '../src/timelineView';
import { SessionLines, tempDir, writeLines } from './transcriptFixture';
import { hookPortOf, readSettings } from '../src/config';
import { mock } from './vscode-mock';

const T = Date.parse('2026-11-01T10:00:00Z');
const turn: Turn = { id: 'p1', time: T - 1000, prompt: 'Fix it' };
const none = new Set<string>();

function hook(id: string, file: string, time: number, extra: Partial<HookEvent> = {}): HookEvent {
  return { session: 's1', prompt: 'p1', transcript: '/t/s1.jsonl', tool: 'Edit', id, file, time, ...extra };
}

function call(id: string, file: string, start: number, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'Edit', session: 's1', file, detail: path.basename(file), start, end: start + 100, turn, ...extra };
}

// ------------------------------------------------------------ matchHook

test('a hook event on the file, just after the write, matches', () => {
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, [hook('e1', '/w/a.ts', T + 40)], none, false)?.id, 'e1');
});

test('two hook events on one file go to their own changes', () => {
  const events = [hook('e1', '/w/a.ts', T + 40), hook('e2', '/w/a.ts', T + 1040)];
  const first = matchHook({ paths: ['/w/a.ts'], time: T }, events, none, false)!;
  const second = matchHook({ paths: ['/w/a.ts'], time: T + 1000 }, events, new Set([first.id]), false)!;
  assert.equal(first.id, 'e1');
  assert.equal(second.id, 'e2');
});

test('the earliest event at or after the write wins, else the latest before it', () => {
  const events = [hook('e0', '/w/a.ts', T - 800), hook('e1', '/w/a.ts', T - 300), hook('e2', '/w/a.ts', T + 50), hook('e3', '/w/a.ts', T + 900)];
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, events, none, false)?.id, 'e2');
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, events, new Set(['e2', 'e3']), false)?.id, 'e1');
});

test('events more than 1 s before or 10 s after the write do not match', () => {
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, [hook('e1', '/w/a.ts', T - 1001)], none, false), undefined);
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, [hook('e1', '/w/a.ts', T + HOOK_LATE_MS + 1)], none, false), undefined);
});

test('a claimed event, or one on another file, does not match', () => {
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, [hook('e1', '/w/a.ts', T + 40)], new Set(['e1']), false), undefined);
  assert.equal(matchHook({ paths: ['/w/a.ts'], time: T }, [hook('e1', '/w/b.ts', T + 40)], none, false), undefined);
});

test('a rename matches an event on either path; Windows paths compare without case', () => {
  assert.equal(matchHook({ paths: ['/w/new.ts', '/w/old.ts'], time: T }, [hook('e1', '/w/old.ts', T + 40)], none, false)?.id, 'e1');
  assert.equal(matchHook({ paths: ['c:\\work\\a.ts'], time: T }, [hook('e1', 'C:\\Work\\A.ts', T + 40)], none, true)?.id, 'e1');
});

test('hookContext takes the turn, narration, start and subagent description from the transcript call', () => {
  const e = hook('e1', '/w/a.ts', T + 40, { subagent: { id: 'a7', type: 'Explore' } });
  const c = call('e1', '/w/a.ts', T - 100, { narration: 'Fixing.', subagent: { id: 'a7', description: 'Look around' } });
  assert.deepEqual(hookContext(e, c), {
    session: 's1',
    turn,
    tool: { id: 'e1', name: 'Edit', time: T - 100, detail: 'a.ts' },
    narration: 'Fixing.',
    subagent: { id: 'a7', type: 'Explore', description: 'Look around' },
    via: 'hook',
  });
});

test('hookContext without a transcript call has the session, call and subagent, and no turn', () => {
  const e = hook('e1', 'C:\\w\\a.ts', T + 40, { subagent: { id: 'a7', type: 'Explore' } });
  assert.deepEqual(hookContext(e, undefined), {
    session: 's1',
    tool: { id: 'e1', name: 'Edit', time: T + 40, detail: 'a.ts' },
    subagent: { id: 'a7', type: 'Explore' },
    via: 'hook',
  });
});

test('the Changes view tooltip without a turn shows the tool and no prompt', () => {
  const t = new Timeline(10);
  t.push(ev('a.ts', T));
  t.annotate([{ seq: 1, agent: hookContext(hook('e1', '/w/a.ts', T + 40), undefined) }]);
  const tip = (new ChangeItem(t.get(1)!, 'played').tooltip as { value: string }).value;
  assert.ok(!tip.includes('Prompt'));
  assert.match(tip, /\*\*Tool:\*\* Edit · a\\\.ts/);
});

// ------------------------------------------------------------ correlator

function ev(rel: string, time: number, extra: Partial<NewChangeEvent> = {}): NewChangeEvent {
  return { uri: 'file:///w/' + rel, relPath: rel, time, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, ...extra };
}

class FakeClock {
  now = T;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private id = 0;
  set = (fn: () => void, ms: number) => {
    const id = ++this.id;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  };
  clear = (h: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  async advance(ms: number, correlator: Correlator): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
      await correlator.idle();
    }
    this.now = end;
  }
}

class FakeSource implements CallSource {
  list: ToolCall[] = [];
  files: Array<readonly string[] | undefined> = [];
  async refresh(_roots: readonly string[], _since: number, files?: readonly string[]) {
    this.files.push(files);
  }
  calls() {
    return this.list;
  }
  prune() {}
}

function harness() {
  const clock = new FakeClock();
  const timeline = new Timeline(100);
  const source = new FakeSource();
  const hooks = new HookLog(15 * 60 * 1000, 5000, () => clock.now);
  const correlator = new Correlator({
    timeline,
    index: source,
    hooks,
    roots: () => ['/w'],
    pathOf: (uri) => (uri.startsWith('file://') ? uri.slice('file://'.length) : undefined),
    enabled: () => true,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  return { clock, timeline, source, hooks, correlator };
}

test('a hook event and its transcript call give the change its context, matched by a hook', async () => {
  const { clock, timeline, source, hooks, correlator } = harness();
  hooks.add(hook('e1', '/w/a.ts', T + 40));
  source.list = [call('e1', '/w/a.ts', T - 100, { narration: 'Fixing.' })];
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  const agent = timeline.get(1)!.agent!;
  assert.equal(agent.via, 'hook');
  assert.equal(agent.tool?.id, 'e1');
  assert.equal(agent.turn?.prompt, 'Fix it');
  assert.equal(agent.narration, 'Fixing.');
  assert.deepEqual(source.files.at(-1), ['/t/s1.jsonl']);
  correlator.dispose();
});

test('a hook event arriving after the change is picked up without waiting for a retry', async () => {
  const { clock, timeline, source, hooks, correlator } = harness();
  // Known to the transcript under another file, so only the hook event can match it.
  source.list = [call('e1', '/w/elsewhere.ts', T - 100)];
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  hooks.add(hook('e1', '/w/a.ts', T + 40));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent?.via, 'hook');
  correlator.dispose();
});

test('a hook match waits for its transcript call, then takes the turn', async () => {
  const { clock, timeline, source, hooks, correlator } = harness();
  hooks.add(hook('e1', '/w/a.ts', T + 40));
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  source.list = [call('e1', '/w/a.ts', T - 100)];
  await clock.advance(RETRY_MS, correlator);
  assert.equal(timeline.get(1)!.agent?.turn?.id, 'p1');
  assert.equal(timeline.get(1)!.agent?.via, 'hook');
  correlator.dispose();
});

test('a hook match whose transcript call never shows gets the event alone after 30 s', async () => {
  const { clock, timeline, hooks, correlator } = harness();
  hooks.add(hook('e1', '/w/a.ts', T + 40, { subagent: { id: 'a7' } }));
  timeline.push(ev('a.ts', T));
  await clock.advance(SETTLE_MS - 1000, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  await clock.advance(RETRY_MS * 2, correlator);
  const agent = timeline.get(1)!.agent!;
  assert.equal(agent.via, 'hook');
  assert.equal(agent.turn, undefined);
  assert.equal(agent.tool?.id, 'e1');
  assert.deepEqual(agent.subagent, { id: 'a7' });
  correlator.dispose();
});

test('an event held by a waiting change is not given to the next change on the file', async () => {
  const { clock, timeline, hooks, correlator } = harness();
  hooks.add(hook('e1', '/w/a.ts', T + 40));
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  timeline.push(ev('a.ts', T + 500));
  await clock.advance(SETTLE_MS + RETRY_MS * 2, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  assert.equal(timeline.get(2)!.agent, undefined);
  correlator.dispose();
});

test('a call given to a change by its hook event is not given to another by the transcript', async () => {
  const { clock, timeline, source, hooks, correlator } = harness();
  hooks.add(hook('e1', '/w/a.ts', T + 40));
  // Still running by the transcript, so it would cover the second write too.
  source.list = [{ ...call('e1', '/w/a.ts', T - 100), end: undefined }];
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  timeline.push(ev('a.ts', T + 1500));
  await clock.advance(SETTLE_MS + RETRY_MS * 2, correlator);
  assert.equal(timeline.get(1)!.agent?.via, 'hook');
  assert.equal(timeline.get(2)!.agent, undefined);
  correlator.dispose();
});

test('without a hook event, the transcript rules apply as before', async () => {
  const { clock, timeline, source, correlator } = harness();
  source.list = [call('e1', '/w/a.ts', T - 100)];
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent?.via, 'edit');
  correlator.dispose();
});

// ------------------------------------------------------------ transcripts hooks name

test('the index reads a transcript a hook names outside any candidate folder, with its subagents', async () => {
  const projects = tempDir('at-hook-projects-');
  const elsewhere = tempDir('at-hook-elsewhere-');
  const file = path.join(elsewhere, 's9.jsonl');
  const s = new SessionLines('s9');
  writeLines(file, [s.prompt(T - 1000, 'Do it', 'p9'), s.use(T - 500, 'ag1', 'Agent', { prompt: 'go' }), s.use(T - 100, 'e9', 'Edit', { file_path: '/w/a.ts' })]);
  const sub = path.join(elsewhere, 's9', 'subagents', 'agent-a7.jsonl');
  const sa = new SessionLines('s9');
  writeLines(sub, [sa.use(T - 50, 'e10', 'Write', { file_path: '/w/b.ts' }, { agentId: 'a7' })]);
  fs.writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ toolUseId: 'ag1', agentType: 'Explore' }));
  // Far from its mtime, and the roots name no folder for it.
  fs.utimesSync(file, new Date(T - 3600_000), new Date(T - 3600_000));
  const index = new TranscriptIndex(() => projects);
  await index.refresh(['/w'], T);
  assert.equal(index.calls().length, 0);
  await index.refresh(['/w'], T, [file, 'relative.jsonl', path.join(elsewhere, 'missing.jsonl')]);
  const byId = new Map(index.calls().map((c) => [c.id, c]));
  assert.equal(byId.get('e9')?.turn?.prompt, 'Do it');
  assert.equal(byId.get('e10')?.turn?.id, 'p9');
  assert.equal(byId.get('e10')?.subagent?.type, 'Explore');
});

// ------------------------------------------------------------ settings

test('hookPort counts only from user settings, and only as a port from 1024 to 65535', () => {
  assert.deepEqual([47323, 1024, 65535].map(hookPortOf), [47323, 1024, 65535]);
  assert.deepEqual([0, 80, 65536, 47323.5, '47323', undefined, null].map(hookPortOf), [0, 0, 0, 0, 0, 0, 0]);
  // The mock gives configuration values as workspace values.
  mock.config.set('agentTypewriter.hookPort', 47323);
  try {
    assert.equal(readSettings().hookPort, 0);
  } finally {
    mock.config.delete('agentTypewriter.hookPort');
  }
});
