import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Tools that write one file named in their input. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Tools that run a command, which may write any file while it runs. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/** Prompts and narration are cut to this many characters. */
export const TEXT_MAX = 1000;
/** A tool call's detail is cut to this many characters. */
export const DETAIL_MAX = 200;
/** Files last written this long before the oldest change waiting for a match are not read. */
export const MTIME_SLACK_MS = 5000;
/** A session's subagent transcripts are looked at while the session's own transcript was written this recently. */
const SUBAGENT_WINDOW_MS = 60 * 60 * 1000;
/** How long the list of project folders is reused. */
const LIST_TTL_MS = 10_000;
const CHUNK = 1024 * 1024;

/** A turn: a prompt and everything the agent did after it. */
export interface Turn {
  /** The prompt's `promptId`, or its line's `uuid` when it has none. */
  id: string;
  time: number;
  /** The prompt's text without system reminders, cut to TEXT_MAX. */
  prompt: string;
}

export interface SubagentInfo {
  id: string;
  type?: string;
  description?: string;
}

/** A tool call from a transcript. */
export interface ToolCall {
  id: string;
  name: string;
  /** Claude Code session id. */
  session: string;
  /** Absolute path an edit tool writes. */
  file?: string;
  detail?: string;
  /** When the call was written to the transcript, before the tool ran. */
  start: number;
  /** When its result was written; undefined while it runs. */
  end?: number;
  /** Undefined until known: a subagent's calls wait for the call that started it. */
  turn?: Turn;
  /** The latest text the agent wrote in the turn at or before the call. */
  narration?: string;
  subagent?: SubagentInfo;
}

/** `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`. */
export function projectsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const config = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(config ? config : path.join(home, '.claude'), 'projects');
}

/** The name Claude Code gives the project folder of a session started in `dir`. */
export function encodeProjectPath(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

/** `p` and each folder above it, nearest first, without the filesystem root. Either separator counts. */
export function selfAndAncestors(p: string): string[] {
  const out: string[] = [];
  let cur = p.replace(/[\\/]+$/, '');
  while (cur && /[\\/]/.test(cur)) {
    out.push(cur);
    cur = cur.slice(0, cur.search(/[\\/][^\\/]*$/));
  }
  // A drive or share name with nothing below it ("C:") is not a folder sessions start in.
  if (cur && !/^[A-Za-z]:$/.test(cur) && out.length === 0) out.push(cur);
  return out;
}

/**
 * Project folder names that may hold sessions editing files under `roots`:
 * those named for a root or a folder above one, or starting with a root's
 * name and a `-` (a folder inside it, or an unrelated one that only looks
 * like it, which costs a read but never a wrong match).
 */
export function candidateDirs(names: readonly string[], roots: readonly string[]): string[] {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const root of roots) {
    for (const dir of selfAndAncestors(root)) exact.add(encodeProjectPath(dir));
    prefixes.push(encodeProjectPath(root.replace(/[\\/]+$/, '')) + '-');
  }
  return names.filter((n) => exact.has(n) || prefixes.some((p) => n.startsWith(p)));
}

/** A prompt's text, or undefined when the line does not start a turn. */
export function promptText(content: unknown): string | undefined {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => isObject(b) && b.type === 'tool_result')) return undefined;
    text = content
      .filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  } else return undefined;
  const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return stripped ? cut(stripped, TEXT_MAX) : undefined;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What the index keeps about one transcript file. */
interface FileState {
  /** Bytes read so far. */
  offset: number;
  /** An incomplete last line, as bytes so a split character is not lost. */
  partial: Buffer;
  mtime: number;
  /** Set for a subagent transcript. */
  subagent?: SubagentInfo;
  /** The call that started this subagent. */
  parentCall?: string;
  turn?: Turn;
  narration?: string;
  /** Ids of the calls read from this file. */
  calls: string[];
}

type Fs = Pick<typeof fs.promises, 'readdir' | 'stat' | 'open' | 'readFile'>;

/**
 * Turns and tool calls read from Claude Code transcripts. Each refresh reads
 * only the bytes appended to a file since it was last read, and only from
 * files written near the oldest change waiting for a match.
 */
export class TranscriptIndex {
  private readonly files = new Map<string, FileState>();
  private readonly byId = new Map<string, ToolCall>();
  /** Per subagent call, the call that started its subagent. */
  private readonly parents = new Map<string, string>();
  /** The turn of every call in a session's own transcript, kept ones or not: a subagent's calls take the turn of the call that started it. */
  private readonly turnOfCall = new Map<string, Turn>();
  private listed: { at: number; names: string[] } | undefined;
  /** Files whose read error was already reported. */
  private readonly failed = new Set<string>();

  constructor(
    private readonly dir: () => string = () => projectsDir(),
    private readonly onError: (file: string, err: unknown) => void = () => {},
    private readonly fsp: Fs = fs.promises,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every call whose turn is known. */
  calls(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const c of this.byId.values()) {
      if (!c.turn && c.subagent) c.turn = this.subagentTurn(c);
      if (c.turn) out.push(c);
    }
    return out;
  }

  /** Reads what was appended to the transcripts of sessions that may have edited files under `roots`, written to since `since`. */
  async refresh(roots: readonly string[], since: number): Promise<void> {
    if (roots.length === 0) return;
    const base = this.dir();
    const names = await this.projectNames(base);
    for (const name of candidateDirs(names, roots)) {
      const dir = path.join(base, name);
      let entries: fs.Dirent[];
      try {
        entries = await this.fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, e.name);
        const mtime = await this.mtimeOf(file);
        if (mtime === undefined) continue;
        if (mtime >= since - MTIME_SLACK_MS) await this.read(file, mtime);
        if (mtime >= since - SUBAGENT_WINDOW_MS) await this.refreshSubagents(path.join(dir, e.name.slice(0, -'.jsonl'.length), 'subagents'), since);
      }
    }
  }

  /** Forgets files not written to since `before`, and their calls; a later refresh reads them again from the start. */
  prune(before: number): void {
    for (const [file, st] of this.files) {
      if (st.mtime >= before) continue;
      this.forgetCalls(st);
      this.files.delete(file);
    }
  }

  private forgetCalls(st: FileState): void {
    for (const id of st.calls) {
      this.byId.delete(id);
      this.parents.delete(id);
      this.turnOfCall.delete(id);
    }
  }

  private async projectNames(base: string): Promise<string[]> {
    const now = this.now();
    if (this.listed && now - this.listed.at < LIST_TTL_MS) return this.listed.names;
    let names: string[] = [];
    try {
      names = (await this.fsp.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // No transcripts on this machine.
    }
    this.listed = { at: now, names };
    return names;
  }

  private async refreshSubagents(dir: string, since: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await this.fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      const mtime = await this.mtimeOf(file);
      if (mtime !== undefined && mtime >= since - MTIME_SLACK_MS) await this.read(file, mtime, true);
    }
  }

  private async mtimeOf(file: string): Promise<number | undefined> {
    try {
      return (await this.fsp.stat(file)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async read(file: string, mtime: number, subagent = false): Promise<void> {
    let st = this.files.get(file);
    try {
      if (!st) {
        st = { offset: 0, partial: Buffer.alloc(0), mtime, calls: [] };
        if (subagent) await this.readMeta(file, st);
        this.files.set(file, st);
      }
      st.mtime = mtime;
      const handle = await this.fsp.open(file, 'r');
      try {
        const size = (await handle.stat()).size;
        if (size < st.offset) {
          // Rewritten from the start: read it again.
          this.forgetCalls(st);
          Object.assign(st, { offset: 0, partial: Buffer.alloc(0), turn: undefined, narration: undefined, calls: [] });
        }
        while (st.offset < size) {
          const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - st.offset));
          const { bytesRead } = await handle.read(buf, 0, buf.length, st.offset);
          if (bytesRead === 0) break;
          st.offset += bytesRead;
          this.feed(st, buf.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (!this.failed.has(file)) {
        this.failed.add(file);
        this.onError(file, err);
      }
    }
  }

  private async readMeta(file: string, st: FileState): Promise<void> {
    const id = /agent-([^/\\]+)\.jsonl$/.exec(file)?.[1] ?? path.basename(file, '.jsonl');
    st.subagent = { id };
    try {
      const meta: unknown = JSON.parse(await this.fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (isObject(meta)) {
        if (typeof meta.toolUseId === 'string') st.parentCall = meta.toolUseId;
        if (typeof meta.agentType === 'string') st.subagent.type = meta.agentType;
        if (typeof meta.description === 'string') st.subagent.description = meta.description;
      }
    } catch {
      // Without it the subagent's calls never get a turn.
    }
  }

  private feed(st: FileState, chunk: Buffer): void {
    let buf = st.partial.length > 0 ? Buffer.concat([st.partial, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl < 0) break;
      if (nl > start) this.line(st, buf.toString('utf8', start, nl));
      start = nl + 1;
    }
    buf = buf.subarray(start);
    st.partial = Buffer.from(buf);
  }

  /** Takes in one transcript line. */
  private line(st: FileState, text: string): void {
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(o) || (o.type !== 'user' && o.type !== 'assistant')) return;
    const time = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const session = typeof o.sessionId === 'string' ? o.sessionId : undefined;
    const message = o.message;
    if (Number.isNaN(time) || !session || !isObject(message)) return;
    const content = message.content;
    // Older versions kept subagent lines in the session's own transcript.
    const sidechain = !st.subagent && o.isSidechain === true;
    const subagent = st.subagent ?? (sidechain ? { id: typeof o.agentId === 'string' ? o.agentId : 'sidechain' } : undefined);
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (isObject(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const call = this.byId.get(b.tool_use_id);
            if (call && call.end === undefined) call.end = time;
          }
        }
      }
      if (st.subagent || sidechain || o.isMeta === true || o.isCompactSummary === true) return;
      const prompt = promptText(content);
      if (prompt === undefined) return;
      const id = typeof o.promptId === 'string' ? o.promptId : typeof o.uuid === 'string' ? o.uuid : `${session}:${time}`;
      st.turn = { id, time, prompt };
      st.narration = undefined;
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!isObject(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string' && !sidechain) {
        const said = b.text.trim();
        if (said) st.narration = cut(said, TEXT_MAX);
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const known = this.byId.has(b.id) || this.turnOfCall.has(b.id);
        if (!st.subagent && st.turn) this.turnOfCall.set(b.id, st.turn);
        const call = toolCall(b.id, b.name, b.input, session, time);
        if (call) {
          if (!st.subagent) call.turn = st.turn;
          if (!sidechain && st.narration !== undefined) call.narration = st.narration;
          if (subagent) call.subagent = subagent;
          this.byId.set(call.id, call);
        }
        if (!known && (call || this.turnOfCall.has(b.id))) st.calls.push(b.id);
        if (!call) continue;
        if (st.subagent && st.parentCall) this.parents.set(call.id, st.parentCall);
      }
    }
  }

  private subagentTurn(c: ToolCall): Turn | undefined {
    const parent = this.parents.get(c.id);
    return parent === undefined ? undefined : this.turnOfCall.get(parent);
  }
}

/** A tool call worth keeping: an edit with its file, or a command. Others are left out. */
function toolCall(id: string, name: string, input: unknown, session: string, start: number): ToolCall | undefined {
  const args = isObject(input) ? input : {};
  if (EDIT_TOOLS.has(name)) {
    const file = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : undefined;
    if (!file) return undefined;
    return { id, name, session, file, detail: cut(path.basename(file), DETAIL_MAX), start };
  }
  if (COMMAND_TOOLS.has(name)) {
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const command = typeof args.command === 'string' ? args.command.trim().split('\n')[0] : '';
    const detail = description || command;
    return { id, name, session, ...(detail && { detail: cut(detail, DETAIL_MAX) }), start };
  }
  return undefined;
}
