import * as http from 'node:http';
import * as path from 'node:path';
import { EDIT_TOOLS } from './transcripts';

/** Where Claude Code's HTTP hook posts. */
export const HOOK_PATH = '/agent-typewriter/hook';
/** Where other windows follow the window that holds the port. */
export const EVENTS_PATH = '/agent-typewriter/events';
/** Marks an events stream as Agent Typewriter's, not another program's. */
export const MARK_HEADER = 'x-agent-typewriter';
/** The port the setup command picks when none is set. */
export const DEFAULT_HOOK_PORT = 47323;
/** Larger hook bodies are refused. `tool_response` can hold a whole file. */
export const MAX_BODY = 16 * 1024 * 1024;
/** Wait before trying again after the window holding the port went away. */
export const RETRY_MS = 1000;
/** Wait before trying again while another program holds the port. */
export const BUSY_RETRY_MS = 10_000;
/** Version of the events stream's lines. */
const LINE_VERSION = 1;

/** One edit tool call as Claude Code's `PostToolUse` hook reported it. */
export interface HookEvent {
  session: string;
  /** Claude Code's `prompt_id`: the turn. */
  prompt?: string;
  /** The session transcript Claude Code named. */
  transcript?: string;
  /** Tool name, one of EDIT_TOOLS. */
  tool: string;
  /** Tool call id. */
  id: string;
  /** Absolute path of the file the call wrote. */
  file: string;
  subagent?: { id: string; type?: string };
  /** When the request arrived, stamped by the window that took it. */
  time: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The event a hook input stands for, or undefined when it is not a
 * `PostToolUse` of an edit tool naming a session, a call and a file. The
 * tool's input text and response are not kept.
 */
export function parseHookInput(body: unknown, time: number): HookEvent | undefined {
  if (!isObject(body)) return undefined;
  if (body.hook_event_name !== undefined && body.hook_event_name !== 'PostToolUse') return undefined;
  const tool = str(body.tool_name);
  const session = str(body.session_id);
  const id = str(body.tool_use_id);
  if (!tool || !EDIT_TOOLS.has(tool) || !session || !id) return undefined;
  const input = isObject(body.tool_input) ? body.tool_input : {};
  const raw = str(input.file_path) ?? str(input.notebook_path);
  if (!raw) return undefined;
  const cwd = str(body.cwd);
  const file = isAbsolute(raw) ? raw : cwd ? path.resolve(cwd, raw) : undefined;
  if (!file) return undefined;
  const prompt = str(body.prompt_id);
  const transcript = str(body.transcript_path);
  const agent = str(body.agent_id);
  const agentType = str(body.agent_type);
  return {
    session,
    ...(prompt && { prompt }),
    ...(transcript && { transcript }),
    tool,
    id,
    file,
    ...(agent && { subagent: { id: agent, ...(agentType && { type: agentType }) } }),
    time,
  };
}

/** Absolute on either platform: Claude Code may run on Windows while this reads POSIX rules, or the other way. */
function isAbsolute(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** A line from an events stream back into an event, or undefined for one this version does not understand. */
export function parseEventLine(line: string): HookEvent | undefined {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(o) || o.v !== LINE_VERSION || !isObject(o.event)) return undefined;
  const e = o.event;
  if (typeof e.session !== 'string' || typeof e.tool !== 'string' || typeof e.id !== 'string' || typeof e.file !== 'string' || typeof e.time !== 'number') return undefined;
  return e as unknown as HookEvent;
}

function eventLine(e: HookEvent): string {
  return JSON.stringify({ v: LINE_VERSION, event: e }) + '\n';
}

export type HookRole = 'hub' | 'follower' | 'waiting';

export interface HookListenerOptions {
  port: number;
  onEvent: (e: HookEvent) => void;
  log?: (line: string) => void;
  /** Host to listen on; tests only. */
  host?: string;
  now?: () => number;
  retryMs?: number;
  busyRetryMs?: number;
}

/**
 * Takes Claude Code hook requests on 127.0.0.1. Of the windows with the same
 * port set, the first to listen is the hub: it takes the requests and streams
 * each event to the others, which follow it. When the hub goes away, the
 * followers try to listen again and one takes over.
 */
export class HookListener {
  private server: http.Server | undefined;
  private readonly streams = new Set<http.ServerResponse>();
  private follow: http.ClientRequest | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private loggedBusy = false;
  private _role: HookRole = 'waiting';
  private readonly host: string;
  private readonly now: () => number;

  constructor(private readonly o: HookListenerOptions) {
    this.host = o.host ?? '127.0.0.1';
    this.now = o.now ?? Date.now;
    this.start();
  }

  get role(): HookRole {
    return this._role;
  }

  get port(): number {
    return this.o.port;
  }

  private start(): void {
    if (this.disposed) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      if (this.server === server) this.server = undefined;
      if (this.disposed) return;
      if (err.code === 'EADDRINUSE') this.followHub();
      else {
        this.o.log?.(`Claude Code hook: could not listen on port ${this.o.port} (${err.message}).`);
        this.retry(this.o.busyRetryMs ?? BUSY_RETRY_MS);
      }
    });
    server.listen(this.o.port, this.host, () => {
      if (this.disposed) {
        server.close();
        return;
      }
      this.server = server;
      this._role = 'hub';
      this.loggedBusy = false;
      this.o.log?.(`Claude Code hook: listening on http://${this.host}:${this.o.port}${HOOK_PATH}.`);
    });
  }

  private followHub(): void {
    if (this.disposed) return;
    let settled = false;
    const fail = (busy: boolean) => {
      if (settled) return;
      settled = true;
      this.follow = undefined;
      if (this.disposed) return;
      this._role = 'waiting';
      if (busy && !this.loggedBusy) {
        this.loggedBusy = true;
        this.o.log?.(`Claude Code hook: port ${this.o.port} is in use by another program. Set agentTypewriter.hookPort to a free port.`);
      }
      this.retry(busy ? (this.o.busyRetryMs ?? BUSY_RETRY_MS) : (this.o.retryMs ?? RETRY_MS));
    };
    const req = http.get({ host: this.host, port: this.o.port, path: EVENTS_PATH, headers: { accept: 'application/x-ndjson' } }, (res) => {
      if (res.statusCode !== 200 || res.headers[MARK_HEADER] !== '1') {
        res.resume();
        fail(true);
        return;
      }
      this._role = 'follower';
      this.loggedBusy = false;
      res.setEncoding('utf8');
      let partial = '';
      res.on('data', (chunk: string) => {
        partial += chunk;
        let nl: number;
        while ((nl = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, nl);
          partial = partial.slice(nl + 1);
          const e = line ? parseEventLine(line) : undefined;
          if (e) this.o.onEvent(e);
        }
        // A runaway line from something that is not a hub.
        if (partial.length > MAX_BODY) req.destroy();
      });
      res.on('end', () => fail(false));
      res.on('error', () => fail(false));
      res.on('close', () => fail(false));
    });
    req.on('error', (err: NodeJS.ErrnoException) => fail(err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET'));
    this.follow = req;
  }

  private retry(ms: number): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, ms);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '').split('?')[0];
    if (req.headers.origin !== undefined) return refuse(req, res, 403);
    if (url === EVENTS_PATH && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', [MARK_HEADER]: '1', 'cache-control': 'no-store' });
      res.flushHeaders();
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (url !== HOOK_PATH) return refuse(req, res, 404);
    if (req.method !== 'POST') return refuse(req, res, 405);
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return refuse(req, res, 415);
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return refuse(req, res, 413);
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        refuse(req, res, 413);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(req, res, 400);
      }
      if (!isObject(body)) return refuse(req, res, 400);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      const e = parseHookInput(body, this.now());
      if (e) this.deliver(e);
    });
  }

  private deliver(e: HookEvent): void {
    const line = eventLine(e);
    for (const s of this.streams) s.write(line);
    this.o.onEvent(e);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.follow?.destroy();
    this.follow = undefined;
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections?.();
    }
    this.server = undefined;
    this._role = 'waiting';
  }
}

function refuse(req: http.IncomingMessage, res: http.ServerResponse, status: number): void {
  if (!res.headersSent) {
    res.writeHead(status, { connection: 'close' });
    res.end();
  }
  req.resume();
}

/** The Claude Code settings that post edit tool calls to the listener on `port`. */
export function hookSettings(port: number): { hooks: Record<string, unknown> } {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: [...EDIT_TOOLS].join('|'),
          hooks: [{ type: 'http', url: `http://127.0.0.1:${port}${HOOK_PATH}`, timeout: 5 }],
        },
      ],
    },
  };
}

/** Hook events from the last FORGET_MS, newest last, bounded in number. */
export class HookLog {
  private events: HookEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly keepMs = 15 * 60 * 1000,
    private readonly max = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  add(e: HookEvent): void {
    this.events.push(e);
    this.trim();
    for (const l of this.listeners) l();
  }

  all(): readonly HookEvent[] {
    this.trim();
    return this.events;
  }

  clear(): void {
    this.events = [];
  }

  onDidAdd(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private trim(): void {
    const cutoff = this.now() - this.keepMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].time < cutoff) drop++;
    drop = Math.max(drop, this.events.length - this.max);
    if (drop > 0) this.events = this.events.slice(drop);
  }
}
