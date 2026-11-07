import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Correlator, matchChange, RETRY_MS, RUNNING_MAX_MS, SETTLE_MS, type AgentContext, type CallSource } from '../src/agentContext';
import { Timeline, toSession, type NewChangeEvent } from '../src/timeline';
import { encodeProjectPath, TranscriptIndex, type ToolCall, type Turn } from '../src/transcripts';
import { ChangeItem } from '../src/timelineView';
import { SessionLines, tempDir, writeLines } from './transcriptFixture';

const T = Date.parse('2026-11-01T10:00:00Z');
const turn: Turn = { id: 'p1', time: T - 1000, prompt: 'Fix it' };

function call(id: string, name: string, start: number, end: number | undefined, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, session: 's1', start, ...(end !== undefined && { end }), turn, ...extra };
}
const edit = (id: string, file: string, start: number, end?: number, extra: Partial<ToolCall> = {}) => call(id, 'Edit', start, end, { file, detail: path.basename(file), ...extra });
const bash = (id: string, start: number, end?: number, extra: Partial<ToolCall> = {}) => call(id, 'Bash', start, end, { detail: 'Format', ...extra });
const none = new Set<string>();

test('an edit call on the file, running when it was written, matches', () => {
  const got = matchChange({ paths: ['/w/a.ts'], time: T + 50 }, [edit('e1', '/w/a.ts', T, T + 90, { narration: 'Renaming.' })], none, T + 1000, false);
  assert.deepEqual(got, { session: 's1', turn, tool: { id: 'e1', name: 'Edit', time: T, detail: 'a.ts' }, narration: 'Renaming.', via: 'edit' });
});

test('two edits to one file go to their own changes', () => {
  const calls = [edit('e1', '/w/a.ts', T, T + 90), edit('e2', '/w/a.ts', T + 3000, T + 3090)];
  const claimed = new Set<string>();
  const first = matchChange({ paths: ['/w/a.ts'], time: T + 50 }, calls, claimed, T + 5000, false)!;
  claimed.add(first.tool!.id);
  const second = matchChange({ paths: ['/w/a.ts'], time: T + 3050 }, calls, claimed, T + 5000, false)!;
  assert.equal(first.tool!.id, 'e1');
  assert.equal(second.tool!.id, 'e2');
});

test('a claimed call is not given to another change', () => {
  const calls = [edit('e1', '/w/a.ts', T, T + 90)];
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T + 50 }, calls, new Set(['e1']), T + 1000, false), undefined);
});

test('of several calls, the latest one started at or before the write wins', () => {
  const calls = [edit('e1', '/w/a.ts', T - 500, T + 2000), edit('e2', '/w/a.ts', T - 100, T + 2000), edit('e3', '/w/a.ts', T + 500, T + 2000)];
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T }, calls, none, T + 5000, false)!.tool!.id, 'e2');
  // None started before: the earliest within the slack.
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T - 700 }, calls, none, T + 5000, false)!.tool!.id, 'e1');
});

test('a call started more than a second after the write does not match', () => {
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T }, [edit('e1', '/w/a.ts', T + 1500, T + 1600)], none, T + 5000, false), undefined);
});

test('a rename matches an edit call on either path', () => {
  const calls = [edit('e1', '/w/old.ts', T, T + 90)];
  assert.equal(matchChange({ paths: ['/w/new.ts', '/w/old.ts'], time: T + 50 }, calls, none, T + 1000, false)!.tool!.id, 'e1');
});

test('paths compare without case and with either separator on Windows', () => {
  const calls = [edit('e1', 'C:\\Work\\A.ts', T, T + 90)];
  assert.ok(matchChange({ paths: ['c:\\work\\a.ts'], time: T + 50 }, calls, none, T + 1000, true));
  assert.equal(matchChange({ paths: ['/w/A.ts'], time: T + 50 }, [edit('e1', '/w/a.ts', T, T + 90)], none, T + 1000, false), undefined);
});

test('a user edit a minute after the last edit call ended gets nothing', () => {
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T + 60_000 }, [edit('e1', '/w/a.ts', T, T + 90)], none, T + 61_000, false), undefined);
});

test('a call with no result counts as running for ten minutes at most', () => {
  const calls = [bash('b1', T)];
  assert.ok(matchChange({ paths: ['/w/b.ts'], time: T + 5 * 60_000 }, calls, none, T + 6 * 60_000, false));
  assert.equal(matchChange({ paths: ['/w/b.ts'], time: T + RUNNING_MAX_MS + 5000 }, calls, none, T + RUNNING_MAX_MS + 6000, false), undefined);
});

test('a file written while a command runs gets the command', () => {
  const got = matchChange({ paths: ['/w/b.ts'], time: T + 500 }, [bash('b1', T, T + 1000)], none, T + 2000, false)!;
  assert.equal(got.via, 'command');
  assert.deepEqual(got.tool, { id: 'b1', name: 'Bash', time: T, detail: 'Format' });
});

test('an edit call beats a running command', () => {
  const got = matchChange({ paths: ['/w/b.ts'], time: T + 500 }, [bash('b1', T, T + 1000), edit('e1', '/w/b.ts', T + 400, T + 600)], none, T + 2000, false)!;
  assert.equal(got.via, 'edit');
});

test('commands running in two sessions give nothing', () => {
  const calls = [bash('b1', T, T + 1000), bash('b2', T, T + 1000, { session: 's2' })];
  assert.equal(matchChange({ paths: ['/w/b.ts'], time: T + 500 }, calls, none, T + 2000, false), undefined);
});

test('parallel commands in one turn give the turn without a tool', () => {
  const calls = [bash('b1', T, T + 1000), bash('b2', T + 10, T + 1000)];
  assert.deepEqual(matchChange({ paths: ['/w/b.ts'], time: T + 500 }, calls, none, T + 2000, false), { session: 's1', turn, via: 'command' });
});

test('parallel commands in two turns of one session give nothing', () => {
  const calls = [bash('b1', T, T + 1000), bash('b2', T + 10, T + 1000, { turn: { ...turn, id: 'p2' } })];
  assert.equal(matchChange({ paths: ['/w/b.ts'], time: T + 500 }, calls, none, T + 2000, false), undefined);
});

test('a call without a turn is not matched', () => {
  assert.equal(matchChange({ paths: ['/w/a.ts'], time: T + 50 }, [edit('e1', '/w/a.ts', T, T + 90, { turn: undefined })], none, T + 1000, false), undefined);
});

// ---------------------------------------------------------------- timeline

function ev(rel: string, time: number, extra: Partial<NewChangeEvent> = {}): NewChangeEvent {
  return { uri: 'file:///w/' + rel, relPath: rel, time, kind: 'modify', before: 'a', after: 'b', eol: '\n', linesAdded: 1, linesRemoved: 1, ...extra };
}
const ctx: AgentContext = { session: 's1', turn, tool: { id: 'e1', name: 'Edit', time: T, detail: 'a.ts' }, narration: 'Renaming.', via: 'edit' };

test('annotate attaches context once, keeping text, order and the cursor', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', T));
  t.push(ev('b.ts', T + 1));
  const cursor = t.cursor;
  let emits = 0;
  t.onDidChange(() => emits++);
  t.annotate([{ seq: 1, agent: ctx }, { seq: 99, agent: ctx }]);
  assert.equal(emits, 1);
  assert.deepEqual(t.get(1)!.agent, ctx);
  assert.equal(t.get(1)!.before, 'a');
  assert.equal(t.get(2)!.agent, undefined);
  assert.equal(t.cursor, cursor);
  t.annotate([]);
  assert.equal(emits, 1);
});

test('a saved session holds no agent context', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', T));
  t.annotate([{ seq: 1, agent: ctx }]);
  const { session } = toSession(t);
  assert.equal('agent' in session.events[0], false);
  assert.equal(JSON.stringify(session).includes('Renaming'), false);
  assert.equal(session.events[0].after, 'b');
});

test('the Changes view tooltip shows the prompt, tool and narration', () => {
  const t = new Timeline(100);
  t.push(ev('a.ts', T));
  t.annotate([{ seq: 1, agent: { ...ctx, subagent: { id: 'x', type: 'helper' } } }]);
  const tip = (new ChangeItem(t.get(1)!, 'pending').tooltip as { value: string }).value;
  assert.doesNotMatch(tip, /&nbsp;/);
  assert.match(tip, /\*\*Prompt:\*\* Fix it/);
  assert.match(tip, /\*\*Tool:\*\* Edit · a\\\.ts \\\(subagent helper\\\)/);
  assert.match(tip, /\*\*Agent:\*\* Renaming\\\./);
  const plain = (new ChangeItem({ ...t.get(1)!, agent: undefined }, 'pending').tooltip as { value: string }).value;
  assert.doesNotMatch(plain, /Prompt/);
});

// ---------------------------------------------------------------- correlator

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
  get pending(): number {
    return this.timers.length;
  }
  /** Moves time on, firing timers that come due, and lets their passes finish. */
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
  refreshes: Array<{ roots: readonly string[]; since: number }> = [];
  pruned: number[] = [];
  async refresh(roots: readonly string[], since: number) {
    this.refreshes.push({ roots, since });
  }
  calls() {
    return this.list;
  }
  prune(before: number) {
    this.pruned.push(before);
  }
}

function harness(enabled = { on: true }) {
  const clock = new FakeClock();
  const timeline = new Timeline(100);
  const source = new FakeSource();
  const correlator = new Correlator({
    timeline,
    index: source,
    roots: () => ['/w'],
    pathOf: (uri) => (uri.startsWith('file://') ? uri.slice('file://'.length) : undefined),
    enabled: () => enabled.on,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  return { clock, timeline, source, correlator, enabled };
}

test('a recorded change gets context after the debounce', async () => {
  const { clock, timeline, source, correlator } = harness();
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  timeline.push(ev('a.ts', T));
  assert.equal(timeline.get(1)!.agent, undefined);
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  assert.deepEqual(source.refreshes, [{ roots: ['/w'], since: T }]);
  assert.equal(clock.pending, 0);
  correlator.dispose();
});

test('a change is matched when its call reaches the transcript later', async () => {
  const { clock, timeline, source, correlator } = harness();
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  await clock.advance(RETRY_MS, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  correlator.dispose();
});

test('an unmatched change is given up after 30 seconds', async () => {
  const { clock, timeline, source, correlator } = harness();
  timeline.push(ev('a.ts', T));
  await clock.advance(SETTLE_MS + RETRY_MS * 2, correlator);
  assert.equal(clock.pending, 0);
  const passes = source.refreshes.length;
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  timeline.push(ev('b.ts', clock.now));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  assert.equal(source.refreshes.length, passes + 1);
  correlator.dispose();
});

test('a call already given to a change is not given to the next one', async () => {
  const { clock, timeline, source, correlator } = harness();
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 5000)];
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  timeline.push(ev('a.ts', T + 1000));
  await clock.advance(300, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  assert.equal(timeline.get(2)!.agent, undefined);
  correlator.dispose();
});

test('restored changes are matched again, and retried for 30 seconds like new ones', async () => {
  const { clock, timeline, source, correlator } = harness();
  clock.now = T + 3_600_000;
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  const old = new Timeline(100);
  old.push(ev('a.ts', T));
  old.push(ev('b.ts', T + 10));
  timeline.restore(old.all(), 1);
  await clock.advance(300, correlator);
  assert.equal(timeline.get(timeline.all()[0].seq)!.agent?.tool?.id, 'e1');
  assert.equal(timeline.all()[1].agent, undefined);
  assert.equal(clock.pending, 1);
  await clock.advance(SETTLE_MS + RETRY_MS, correlator);
  assert.equal(timeline.all()[1].agent, undefined);
  assert.equal(clock.pending, 0);
  correlator.dispose();
});

test('the 30 seconds count from when the change reached the timeline, not from its write', async () => {
  const { clock, timeline, source, correlator } = harness();
  clock.now = T + 25_000;
  // A held change: written at T, recorded 25 s later.
  timeline.push(ev('gone.ts', T, { kind: 'delete' }));
  await clock.advance(10_000, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  source.list = [bash('b1', T - 100, T + 500)];
  await clock.advance(RETRY_MS, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'b1');
  correlator.dispose();
});

test('transcripts are pruned only once no change is waiting', async () => {
  const { clock, timeline, source, correlator } = harness();
  timeline.push(ev('a.ts', T));
  await clock.advance(300 + RETRY_MS * 3, correlator);
  assert.ok(source.refreshes.length >= 3);
  assert.deepEqual(source.pruned, []);
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  await clock.advance(RETRY_MS, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  assert.equal(source.pruned.length, 1);
  correlator.dispose();
});

test('turned off, it reads nothing; turned on, it looks at once', async () => {
  const enabled = { on: false };
  const { clock, timeline, source, correlator } = harness(enabled);
  source.list = [edit('e1', '/w/a.ts', T - 100, T + 50)];
  timeline.push(ev('a.ts', T));
  await clock.advance(5000, correlator);
  assert.equal(source.refreshes.length, 0);
  enabled.on = true;
  correlator.settingsChanged();
  await clock.advance(0, correlator);
  assert.equal(timeline.get(1)!.agent?.tool?.id, 'e1');
  enabled.on = false;
  timeline.push(ev('a.ts', T + 10));
  correlator.settingsChanged();
  assert.equal(clock.pending, 0);
  correlator.dispose();
});

test('changes with no file path get no context and settle', async () => {
  const { clock, timeline, source, correlator } = harness();
  source.list = [bash('b1', T - 100)];
  timeline.push(ev('a.ts', T, { uri: 'vscode-remote://x/a.ts' }));
  await clock.advance(SETTLE_MS + RETRY_MS * 2, correlator);
  assert.equal(timeline.get(1)!.agent, undefined);
  assert.equal(clock.pending, 0);
  correlator.dispose();
});

test('end to end: a transcript on disk gives a recorded change its context', async () => {
  const projects = tempDir('at-corr-');
  const s = new SessionLines('live');
  writeLines(path.join(projects, encodeProjectPath('/w'), 'live.jsonl'), [
    s.prompt(T - 1000, 'Rename the helper', 'p9'),
    s.text(T - 500, 'Renaming.'),
    s.use(T - 100, 'e9', 'Edit', { file_path: '/w/a.ts' }),
    s.result(T + 80, 'e9'),
  ]);
  const clock = new FakeClock();
  const timeline = new Timeline(100);
  const correlator = new Correlator({
    timeline,
    index: new TranscriptIndex(() => projects),
    roots: () => ['/w'],
    pathOf: (uri) => uri.slice('file://'.length),
    enabled: () => true,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  timeline.push(ev('a.ts', T));
  await clock.advance(300, correlator);
  const agent = timeline.get(1)!.agent!;
  assert.equal(agent.turn.prompt, 'Rename the helper');
  assert.equal(agent.tool?.name, 'Edit');
  assert.equal(agent.narration, 'Renaming.');
  correlator.dispose();
});
