import { COMMAND_TOOLS, EDIT_TOOLS, type SubagentInfo, type ToolCall, type Turn } from './transcripts';
import type { ChangeEvent, Timeline } from './timeline';

/**
 * What the agent was doing when it made a change. Captions read `narration`;
 * chapters group by `turn.id`. A hook capture path can build the same thing
 * from the session and tool call ids it is handed.
 */
export interface AgentContext {
  /** Claude Code session id. */
  session: string;
  turn: Turn;
  /** The call that made the change; absent when only the turn is known. */
  tool?: { id: string; name: string; time: number; detail?: string };
  /** The latest text the agent wrote in the turn at or before the call. */
  narration?: string;
  /** Set when a subagent made the change. */
  subagent?: SubagentInfo;
  /** 'edit': an edit tool call on the change's file. 'command': the command running when the file was written. */
  via: 'edit' | 'command';
}

/** A call may start this long after the write it made: the transcript line and the file's mtime come from different writes. */
export const START_SLACK_MS = 1000;
/** A write may be recorded this long after its call ended. */
export const END_SLACK_MS = 2000;
/** A call with no result counts as running for this long at most. */
export const RUNNING_MAX_MS = 10 * 60 * 1000;

/** A recorded change as matching sees it: its absolute paths (the old one too, for a rename) and write time. */
export interface ChangeRef {
  paths: readonly string[];
  time: number;
}

/**
 * The context of the call that made `change`, if one can be told. `claimed`
 * holds edit calls already given to a change. `caseInsensitive` compares
 * paths as Windows does.
 */
export function matchChange(
  change: ChangeRef,
  calls: Iterable<ToolCall>,
  claimed: ReadonlySet<string>,
  now: number,
  caseInsensitive = process.platform === 'win32',
): AgentContext | undefined {
  const norm = (p: string) => {
    const slashed = p.replace(/\\/g, '/');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  const paths = new Set(change.paths.map(norm));
  const t = change.time;
  const covers = (c: ToolCall) => c.start <= t + START_SLACK_MS && t <= (c.end ?? Math.min(c.start + RUNNING_MAX_MS, now)) + END_SLACK_MS;
  const edits: ToolCall[] = [];
  const commands: ToolCall[] = [];
  for (const c of calls) {
    if (!c.turn || !covers(c)) continue;
    if (EDIT_TOOLS.has(c.name)) {
      if (c.file !== undefined && !claimed.has(c.id) && paths.has(norm(c.file))) edits.push(c);
    } else if (COMMAND_TOOLS.has(c.name)) commands.push(c);
  }
  if (edits.length > 0) {
    const before = edits.filter((c) => c.start <= t);
    const pick = before.length > 0 ? before.reduce((a, b) => (b.start > a.start ? b : a)) : edits.reduce((a, b) => (b.start < a.start ? b : a));
    return contextOf(pick, 'edit');
  }
  if (commands.length === 0) return undefined;
  if (new Set(commands.map((c) => c.session)).size > 1) return undefined;
  if (commands.length === 1) return contextOf(commands[0], 'command');
  const turns = new Set(commands.map((c) => c.turn!.id));
  if (turns.size > 1) return undefined;
  const subagents = new Set(commands.map((c) => c.subagent?.id));
  const first = commands[0];
  return { session: first.session, turn: first.turn!, ...(subagents.size === 1 && first.subagent && { subagent: first.subagent }), via: 'command' };
}

function contextOf(c: ToolCall, via: AgentContext['via']): AgentContext {
  return {
    session: c.session,
    turn: c.turn!,
    tool: { id: c.id, name: c.name, time: c.start, ...(c.detail !== undefined && { detail: c.detail }) },
    ...(c.narration !== undefined && { narration: c.narration }),
    ...(c.subagent && { subagent: c.subagent }),
    via,
  };
}

/** The transcript index as the correlator uses it. */
export interface CallSource {
  refresh(roots: readonly string[], since: number): Promise<void>;
  calls(): Iterable<ToolCall>;
  prune(before: number): void;
}

/** A change is retried for this long after it was written, then left without context. */
export const SETTLE_MS = 30_000;
/** Wait after the timeline changes before a pass. */
export const DEBOUNCE_MS = 250;
/** Wait between passes while changes are still waiting. */
export const RETRY_MS = 2000;
/** Transcripts not written to for this long are forgotten after a pass. */
export const FORGET_MS = 15 * 60 * 1000;

export interface CorrelatorOptions {
  timeline: Timeline;
  index: CallSource;
  /** Folders whose sessions may edit recorded files: recorded checkouts and workspace folders. */
  roots: () => readonly string[];
  /** A change's URI as an absolute path, or undefined for one that is not a file. */
  pathOf: (uri: string) => string | undefined;
  enabled: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

function keyOf(e: ChangeEvent): string {
  return `${e.seq}:${e.time}:${e.uri}`;
}

/**
 * Watches the timeline and attaches agent context to recorded changes from
 * the Claude Code transcripts. It never changes what is recorded or played:
 * it only adds `agent` to changes already in the timeline.
 */
export class Correlator {
  /** Changes matched or given up on. */
  private settled = new Set<string>();
  private timer: unknown;
  private running = false;
  private again = false;
  private lastSeq: number | undefined;
  private disposed = false;
  private readonly sub: { dispose(): void };
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly o: CorrelatorOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.sub = o.timeline.onDidChange(() => this.onTimeline());
    this.onTimeline();
  }

  /** Call when the setting changes: turning it on looks for matches at once. */
  settingsChanged(): void {
    if (this.o.enabled()) this.schedule(0);
    else this.cancel();
  }

  /** Resolves once no pass is running; for tests. */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setImmediate(r));
  }

  /** Runs a pass now; for tests and the scheduler. */
  async pass(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || !this.o.enabled()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.match();
    } catch (err) {
      this.o.log?.(`Agent context: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
    if (this.again) {
      this.again = false;
      this.schedule(0);
    }
  }

  private onTimeline(): void {
    const seq = this.o.timeline.all().at(-1)?.seq;
    if (seq === this.lastSeq) return;
    this.lastSeq = seq;
    if (this.o.enabled()) this.schedule(DEBOUNCE_MS);
  }

  private waiting(events: readonly ChangeEvent[]): ChangeEvent[] {
    return events.filter((e) => e.agent === undefined && !this.settled.has(keyOf(e)));
  }

  private async match(): Promise<void> {
    const { timeline, index } = this.o;
    let events = timeline.all();
    const present = new Set(events.map(keyOf));
    for (const k of this.settled) if (!present.has(k)) this.settled.delete(k);
    const open = this.waiting(events);
    if (open.length === 0) return;
    const since = open.reduce((m, e) => Math.min(m, e.time), Infinity);
    await index.refresh(this.o.roots(), since);
    if (this.disposed || !this.o.enabled()) return;
    const now = this.now();
    // The timeline may have changed while the transcripts were read.
    events = timeline.all();
    const claimed = new Set<string>();
    for (const e of events) if (e.agent?.via === 'edit' && e.agent.tool) claimed.add(e.agent.tool.id);
    const calls = [...index.calls()];
    const found: Array<{ seq: number; agent: AgentContext }> = [];
    let left = false;
    for (const e of this.waiting(events)) {
      const paths = [this.o.pathOf(e.uri), e.fromUri !== undefined ? this.o.pathOf(e.fromUri) : undefined].filter((p): p is string => p !== undefined);
      const agent = paths.length > 0 ? matchChange({ paths, time: e.time }, calls, claimed, now) : undefined;
      if (agent) {
        found.push({ seq: e.seq, agent });
        if (agent.via === 'edit' && agent.tool) claimed.add(agent.tool.id);
        this.settled.add(keyOf(e));
      } else if (now - e.time >= SETTLE_MS) this.settled.add(keyOf(e));
      else left = true;
    }
    timeline.annotate(found);
    index.prune(now - FORGET_MS);
    if (left) this.schedule(RETRY_MS);
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      if (ms > 0) return;
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => void this.pass(), ms);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.sub.dispose();
  }
}
