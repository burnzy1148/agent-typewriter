import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Lines in the shapes Claude Code writes to a session transcript. */
export class SessionLines {
  private n = 0;
  constructor(readonly session: string) {}

  private base(type: string, at: number, extra: Record<string, unknown> = {}) {
    return { type, sessionId: this.session, uuid: `${this.session}-u${++this.n}`, timestamp: new Date(at).toISOString(), ...extra };
  }

  prompt(at: number, content: unknown, promptId?: string): string {
    return JSON.stringify(this.base('user', at, { ...(promptId && { promptId }), message: { role: 'user', content } }));
  }

  text(at: number, text: string): string {
    return JSON.stringify(this.base('assistant', at, { message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  }

  use(at: number, id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify(this.base('assistant', at, { ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  }

  result(at: number, id: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify(this.base('user', at, { ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  }

  /** A request blob repeating a tool_use, which must not count as a call. */
  blob(id: string, name: string, input: Record<string, unknown>): string {
    return JSON.stringify({ type: 'api-request-blob', sessionId: this.session, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeLines(file: string, lines: string[], append = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.map((l) => l + '\n').join('');
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
}
