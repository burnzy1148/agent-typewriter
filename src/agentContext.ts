import * as path from 'node:path';
import { COMMAND_TOOLS, EDIT_TOOLS, RUNNING_MAX_MS, type SubagentInfo, type ToolCall, type Turn } from './transcripts';
import type { HookEvent } from './hookListener';

export { RUNNING_MAX_MS };
import type { ChangeEvent, Timeline } from './timeline';

/**
 * What the agent was doing when it made a change. Captions read `narration`;
 * chapters group by `turn.id`. A hook capture path can build the same thing
 * from the session and tool call ids it is handed.
 */
export interface AgentContext {
  /** Claude Code session id. */
  session: string;
  /** Unknown only for a hook match whose transcript call was not found. */
  turn?: Turn;
  /** The call that made the change; absent when only the turn is known. */
  tool?: { id: string; name: string; time: number; detail?: string };
  /** The latest text the agent wrote in the turn at or before the call. */
  narration?: string;
  /** Set when a subagent made the change. */
  subagent?: SubagentInfo;
  /**
   * 'hook': a Claude Code hook reported the call. 'edit': an edit tool call on
   * the change's file in a transcript. 'command': the command running when the
   * file was written.
   */
  via: 'hook' | 'edit' | 'command';
}

/** A call may start this long after the write it made: the transcript line and the file's mtime come from different writes. */
export const START_SLACK_MS = 1000;
/** A write may be recorded this long after its call ended. */
export const END_SLACK_MS = 2000;

/** A hook event may arrive this long after the write it reports. */
export const HOOK_LATE_MS = 10_000;

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
  const norm = normalizer(caseInsensitive);
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

function normalizer(caseInsensitive: boolean): (p: string) => string {
  return (p) => {
    const slashed = p.replace(/\\/g, '/');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
}

/**
 * The hook event that reported the write behind `change`: an unclaimed edit
 * event on one of its paths, arriving from START_SLACK_MS before the write to
 * HOOK_LATE_MS after it. The request follows the write it reports, so the
 * earliest event at or after the write wins, else the latest before it. An
 * event belongs to the latest write on its file before it arrived: one is
 * skipped when another of `writes` on its file came after `change` and
 * before the event.
 */
export function matchHook(
  change: ChangeRef,
  events: Iterable<HookEvent>,
  claimed: ReadonlySet<string>,
  writes: Iterable<ChangeRef> = [],
  caseInsensitive = process.platform === 'win32',
): HookEvent | undefined {
  const norm = normalizer(caseInsensitive);
  const paths = new Set(change.paths.map(norm));
  const t = change.time;
  const later = [...writes].filter((w) => w.time > t);
  let after: HookEvent | undefined;
  let before: HookEvent | undefined;
  for (const e of events) {
    if (claimed.has(e.id) || e.time < t - START_SLACK_MS || e.time > t + HOOK_LATE_MS || !paths.has(norm(e.file))) continue;
    if (laterWrite(e, later, norm)) continue;
    if (e.time >= t) {
      if (!after || e.time < after.time) after = e;
    } else if (!before || e.time > before.time) before = e;
  }
  return after ?? before;
}

/** Whether one of `later` wrote `e`'s file before `e` arrived: the event is that write's. */
function laterWrite(e: HookEvent, later: readonly ChangeRef[], norm: (p: string) => string): boolean {
  const file = norm(e.file);
  return later.some((w) => w.time <= e.time && w.paths.some((p) => norm(p) === file));
}

/**
 * Whether `e` may still belong to a write not yet in the timeline: it arrived
 * more than START_SLACK_MS after `change`'s write, and a later write on its
 * file could still be recorded within `writeLag` of its arrival.
 */
export function hookHeld(change: ChangeRef, e: HookEvent, writeLag: number, now: number): boolean {
  return e.time > change.time + START_SLACK_MS && now < e.time + writeLag;
}

/** The context a hook event gives, filled in from its transcript call when that is known. */
export function hookContext(e: HookEvent, call: ToolCall | undefined): AgentContext {
  const subagent = call?.subagent ?? e.subagent;
  return {
    session: e.session,
    ...(call?.turn && { turn: call.turn }),
    tool: { id: e.id, name: e.tool, time: call?.start ?? e.time, detail: call?.detail ?? path.basename(e.file.replace(/\\/g, '/')) },
    ...(call?.narration !== undefined && { narration: call.narration }),
    ...(subagent && { subagent: { ...e.subagent, ...subagent } }),
    via: 'hook',
  };
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
  /** Reads transcripts under `roots` written since `since`, and the transcript `files` whatever their folder. */
  refresh(roots: readonly string[], since: number, files?: readonly string[]): Promise<void>;
  calls(): Iterable<ToolCall>;
  prune(before: number): void;
}

/** A change is retried for this long after the correlator first sees it, then left without context. */
export const SETTLE_MS = 30_000;
/** Wait after the timeline changes before a pass. */
export const DEBOUNCE_MS = 250;
/** Wait between passes while changes are still waiting. */
export const RETRY_MS = 2000;
/** Transcripts not written to for this long are forgotten after a pass. */
export const FORGET_MS = 15 * 60 * 1000;
/** `writeLag` when none is given: the default reorder window and debounce, and slack. */
export const WRITE_LAG_MS = 2500;

export interface CorrelatorOptions {
  timeline: Timeline;
  index: CallSource;
  /** Folders whose sessions may edit recorded files: recorded checkouts and workspace folders. */
  roots: () => readonly string[];
  /** A change's URI as an absolute path, or undefined for one that is not a file. */
  pathOf: (uri: string) => string | undefined;
  enabled: () => boolean;
  /** Recent Claude Code hook events, when the hook listener is on. */
  hooks?: HookSource;
  /** How long after a write it may reach the timeline: the reorder window, the recorder's debounce, and slack. */
  writeLag?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

/** Hook events as the correlator uses them. */
export interface HookSource {
  all(): readonly HookEvent[];
  onDidAdd(fn: () => void): { dispose(): void };
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
  /** When each change still waiting was first seen: it reaches the timeline after its write, sometimes long after. */
  private seen = new Map<string, number>();
  private timer: unknown;
  /** When the pending timer fires. */
  private timerAt = 0;
  private running = false;
  private again = false;
  private lastSeq: number | undefined;
  private disposed = false;
  /** Per waiting change, the hook event it matched while its transcript call is not found yet. */
  private pendingHook = new Map<string, string>();
  private readonly subs: Array<{ dispose(): void }>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly o: CorrelatorOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.subs = [o.timeline.onDidChange(() => this.onTimeline())];
    // A change may be waiting for this event: look soon, sooner than a pending retry.
    if (o.hooks) this.subs.push(o.hooks.onDidAdd(() => this.o.enabled() && this.schedule(DEBOUNCE_MS, true)));
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
    for (const k of this.seen.keys()) if (!present.has(k)) this.seen.delete(k);
    for (const k of this.pendingHook.keys()) if (!present.has(k)) this.pendingHook.delete(k);
    const open = this.waiting(events);
    if (open.length === 0) return;
    const firstSeen = this.now();
    for (const e of open) if (!this.seen.has(keyOf(e))) this.seen.set(keyOf(e), firstSeen);
    const since = open.reduce((m, e) => Math.min(m, e.time), Infinity);
    const hooks = this.o.hooks?.all() ?? [];
    // Only the transcripts of events a waiting change may take, or holds.
    const norm = normalizer(process.platform === 'win32');
    const openPaths = new Set(open.flatMap((e) => this.pathsOf(e)).map(norm));
    const heldIds = new Set(this.pendingHook.values());
    const transcripts = [
      ...new Set(hooks.filter((h) => heldIds.has(h.id) || openPaths.has(norm(h.file))).map((h) => h.transcript).filter((t): t is string => t !== undefined)),
    ];
    await index.refresh(this.o.roots(), since, transcripts);
    if (this.disposed || !this.o.enabled()) return;
    const now = this.now();
    // The timeline may have changed while the transcripts were read.
    events = timeline.all();
    const claimed = new Set<string>();
    for (const e of events) if (e.agent?.tool && e.agent.via !== 'command') claimed.add(e.agent.tool.id);
    // A change waiting for its hook event's transcript call keeps the event.
    for (const id of this.pendingHook.values()) claimed.add(id);
    const calls = [...index.calls()];
    const byId = new Map(calls.map((c) => [c.id, c]));
    const hookById = new Map(hooks.map((h) => [h.id, h]));
    const writes: ChangeRef[] = events.map((e) => ({ paths: this.pathsOf(e), time: e.time }));
    const writeLag = this.o.writeLag?.() ?? WRITE_LAG_MS;
    const found: Array<{ seq: number; agent: AgentContext }> = [];
    let left = false;
    for (const e of this.waiting(events)) {
      const key = keyOf(e);
      const due = now - (this.seen.get(key) ?? now) >= SETTLE_MS;
      const paths = this.pathsOf(e);
      const ref = { paths, time: e.time };
      const held = this.pendingHook.get(key);
      let hook = held !== undefined ? hookById.get(held) : paths.length > 0 ? matchHook(ref, hooks, claimed, writes) : undefined;
      // An event that came well after this write may be a later write's still on its way to the timeline.
      let wait = false;
      if (hook && held === undefined && !due && hookHeld(ref, hook, writeLag, now)) {
        hook = undefined;
        wait = true;
      }
      let agent: AgentContext | undefined;
      if (hook) {
        claimed.add(hook.id);
        const call = byId.get(hook.id);
        // The transcript line may come after the hook request; wait for it, as long as any change waits.
        if (call || due) agent = hookContext(hook, call);
        else {
          this.pendingHook.set(key, hook.id);
          left = true;
          continue;
        }
      } else if (paths.length > 0) agent = matchChange(ref, calls, claimed, now);
      if (agent) {
        found.push({ seq: e.seq, agent });
        if (agent.tool && agent.via !== 'command') claimed.add(agent.tool.id);
        this.settle(key);
      } else if (due && !wait) this.settle(key);
      else {
        if (!this.seen.has(key)) this.seen.set(key, now);
        left = true;
      }
    }
    timeline.annotate(found);
    // Not while changes wait: after a restore they are old, and pruning would drop the
    // transcripts the next retry reads again.
    if (left) this.schedule(RETRY_MS);
    else index.prune(now - FORGET_MS);
  }

  /** A change's absolute paths, the old one too for a rename. */
  private pathsOf(e: ChangeEvent): string[] {
    return [this.o.pathOf(e.uri), e.fromUri !== undefined ? this.o.pathOf(e.fromUri) : undefined].filter((p): p is string => p !== undefined);
  }

  private settle(key: string): void {
    this.settled.add(key);
    this.seen.delete(key);
    this.pendingHook.delete(key);
  }

  /** Runs a pass in `ms`. A pending one stands, unless `ms` is 0 or `sooner` and it comes later. */
  private schedule(ms: number, sooner = false): void {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      if (ms > 0 && !(sooner && this.timerAt > this.now() + ms)) return;
      this.clearTimer(this.timer);
    }
    this.timerAt = this.now() + ms;
    this.timer = this.setTimer(() => void this.pass(), ms);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    for (const s of this.subs) s.dispose();
  }
}
