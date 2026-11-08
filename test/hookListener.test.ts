import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { EVENTS_PATH, HOOK_PATH, HookListener, HookLog, MAX_BODY, hookSettings, parseEventLine, parseHookInput, type HookEvent } from '../src/hookListener';

const T = Date.parse('2026-11-01T10:00:00Z');

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 's1',
    prompt_id: 'p1',
    transcript_path: '/home/me/.claude/projects/-w/s1.jsonl',
    cwd: '/w',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/w/a.ts', old_string: 'secret old', new_string: 'secret new' },
    tool_response: { originalFile: 'whole file' },
    tool_use_id: 'e1',
    ...extra,
  };
}

test('parseHookInput keeps the session, prompt, transcript, tool, call, file and time', () => {
  assert.deepEqual(parseHookInput(input(), T), {
    session: 's1',
    prompt: 'p1',
    transcript: '/home/me/.claude/projects/-w/s1.jsonl',
    tool: 'Edit',
    id: 'e1',
    file: '/w/a.ts',
    time: T,
  });
});

test('parseHookInput keeps no tool input text or response', () => {
  const text = JSON.stringify(parseHookInput(input(), T));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('whole file'));
});

test('parseHookInput takes NotebookEdit notebook_path, a subagent, and a path relative to cwd', () => {
  const nb = parseHookInput(input({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n/x.ipynb' }, agent_id: 'a7', agent_type: 'Explore' }), T)!;
  assert.equal(nb.tool, 'NotebookEdit');
  assert.equal(nb.file, '/w/n/x.ipynb');
  assert.deepEqual(nb.subagent, { id: 'a7', type: 'Explore' });
  assert.equal(parseHookInput(input({ tool_input: { file_path: 'C:\\w\\a.ts' } }), T)!.file, 'C:\\w\\a.ts');
});

test('parseHookInput drops other tools, other events, and inputs missing a session, call or file', () => {
  assert.equal(parseHookInput(input({ tool_name: 'Bash', tool_input: { command: 'ls' } }), T), undefined);
  assert.equal(parseHookInput(input({ hook_event_name: 'PreToolUse' }), T), undefined);
  assert.equal(parseHookInput(input({ session_id: undefined }), T), undefined);
  assert.equal(parseHookInput(input({ tool_use_id: '' }), T), undefined);
  assert.equal(parseHookInput(input({ tool_input: {} }), T), undefined);
  assert.equal(parseHookInput(input({ cwd: undefined, tool_input: { file_path: 'a.ts' } }), T), undefined);
  assert.equal(parseHookInput([], T), undefined);
});

test('parseEventLine reads version 1 lines and ignores others', () => {
  const e: HookEvent = { session: 's1', tool: 'Edit', id: 'e1', file: '/w/a.ts', time: T };
  assert.deepEqual(parseEventLine(JSON.stringify({ v: 1, event: e })), e);
  assert.equal(parseEventLine(JSON.stringify({ v: 2, event: e })), undefined);
  assert.equal(parseEventLine('not json'), undefined);
  assert.equal(parseEventLine(JSON.stringify({ v: 1, event: { session: 's1' } })), undefined);
});

test('hookSettings posts the edit tools to the port', () => {
  const s = hookSettings(47323) as { hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; url: string }> }> } };
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Edit|MultiEdit|Write|NotebookEdit');
  assert.deepEqual(s.hooks.PostToolUse[0].hooks[0], { type: 'http', url: `http://127.0.0.1:47323${HOOK_PATH}`, timeout: 5 });
});

test('HookLog keeps 15 minutes and at most max events, and tells listeners', () => {
  let now = T;
  const log = new HookLog(15 * 60 * 1000, 3, () => now);
  let told = 0;
  log.onDidAdd(() => told++);
  const e = (id: string, time: number): HookEvent => ({ session: 's', tool: 'Edit', id, file: '/w/a.ts', time });
  log.add(e('a', T - 16 * 60 * 1000));
  log.add(e('b', T));
  assert.deepEqual(log.all().map((x) => x.id), ['b']);
  log.add(e('c', T));
  log.add(e('d', T));
  log.add(e('f', T));
  assert.deepEqual(log.all().map((x) => x.id), ['c', 'd', 'f']);
  assert.equal(told, 5);
  now = T + 16 * 60 * 1000;
  assert.equal(log.all().length, 0);
});

// ------------------------------------------------------------ over HTTP

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function post(port: number, body: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/json' }, url = HOOK_PATH): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? resolve({ status: 413, body: '' }) : reject(err)));
    req.end(body);
  });
}

function listener(port: number, got: HookEvent[], logs: string[] = []): HookListener {
  return new HookListener({ port, onEvent: (e) => got.push(e), log: (l) => logs.push(l), retryMs: 50, busyRetryMs: 100 });
}

test('a hook request is answered 200 {} and its event kept', async () => {
  const port = await freePort();
  const got: HookEvent[] = [];
  const l = listener(port, got);
  try {
    await until(() => l.role === 'hub');
    const res = await post(port, JSON.stringify(input()));
    assert.deepEqual(res, { status: 200, body: '{}' });
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'e1');
    // A valid request that is not an edit is answered the same and kept nowhere.
    assert.deepEqual(await post(port, JSON.stringify(input({ tool_name: 'Bash' }))), { status: 200, body: '{}' });
    assert.equal(got.length, 1);
  } finally {
    l.dispose();
  }
});

test('requests from web pages, not JSON, too large, or not an object are refused and kept nowhere', async () => {
  const port = await freePort();
  const got: HookEvent[] = [];
  const l = listener(port, got);
  try {
    await until(() => l.role === 'hub');
    const body = JSON.stringify(input());
    assert.equal((await post(port, body, { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(port, body, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(port, '[1]')).status, 400);
    assert.equal((await post(port, '{nope')).status, 400);
    assert.equal((await post(port, body, { 'content-type': 'application/json' }, '/other')).status, 404);
    assert.equal((await post(port, Buffer.alloc(MAX_BODY + 1, 32))).status, 413);
    assert.equal(got.length, 0);
  } finally {
    l.dispose();
  }
});

test('windows on one port all get every event, and one takes over when the hub goes', async () => {
  const port = await freePort();
  const a: HookEvent[] = [];
  const b: HookEvent[] = [];
  const c: HookEvent[] = [];
  const la = listener(port, a);
  await until(() => la.role === 'hub');
  const lb = listener(port, b);
  const lc = listener(port, c);
  try {
    await until(() => lb.role === 'follower' && lc.role === 'follower');
    await post(port, JSON.stringify(input()));
    await until(() => a.length === 1 && b.length === 1 && c.length === 1);
    assert.equal(b[0].time, a[0].time, 'followers get the hub\u2019s arrival time');
    la.dispose();
    await until(() => [lb.role, lc.role].sort().join() === 'follower,hub');
    await post(port, JSON.stringify(input({ tool_use_id: 'e2' })));
    await until(() => b.length === 2 && c.length === 2);
    assert.equal(a.length, 1);
  } finally {
    la.dispose();
    lb.dispose();
    lc.dispose();
  }
});

test('a port held by another program is logged once, then taken when it is free', async () => {
  const port = await freePort();
  const other = http.createServer((_req, res) => res.end('hello'));
  await new Promise<void>((r) => other.listen(port, '127.0.0.1', () => r()));
  const got: HookEvent[] = [];
  const logs: string[] = [];
  const l = listener(port, got, logs);
  try {
    await until(() => logs.some((x) => x.includes('in use by another program')));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(logs.filter((x) => x.includes('in use')).length, 1);
    assert.equal(l.role, 'waiting');
    await new Promise<void>((r) => other.close(() => r()));
    await until(() => l.role === 'hub');
    await post(port, JSON.stringify(input()));
    assert.equal(got.length, 1);
  } finally {
    l.dispose();
    other.close();
  }
});

test('dispose closes the port', async () => {
  const port = await freePort();
  const l = listener(port, []);
  await until(() => l.role === 'hub');
  l.dispose();
  await until(() => true);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: EVENTS_PATH }, resolve);
      req.on('error', reject);
    }),
  );
});
