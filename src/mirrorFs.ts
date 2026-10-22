import * as vscode from 'vscode';
import type { Eol } from './planner';

export const MIRROR_SCHEME = 'agent-typewriter';

/**
 * A tiny in-memory filesystem that backs the replay editors.
 *
 * The real files are never touched. Each watched file gets a mirror document
 * at agent-typewriter:/<relative path>, so tabs show the real file name and
 * VS Code picks the right language mode and syntax highlighting from the
 * extension. Files are read-only to the editor: the user can't type into a
 * mirror, it never becomes dirty, so closing a tab never prompts, and VS Code
 * leaves its text alone (no save participants, no stripping of unusual line
 * terminators). The player still edits the open documents through
 * workspace.applyEdit, and keeps the text stored here with store().
 *
 * Reads wait until open() is called, so a mirror tab VS Code restores while
 * the extension activates is not answered before the mirrors are refilled
 * from the restored timeline.
 */
export class MirrorFileSystem implements vscode.FileSystemProvider {
  private files = new Map<string, { data: Uint8Array; mtime: number; ctime: number }>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Pending until open(); undefined once open. */
  private gate: Promise<void> | undefined;
  private release: () => void = () => undefined;

  constructor() {
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  /** Lets reads through. Safe to call more than once. */
  open(): void {
    this.gate = undefined;
    this.release();
  }

  static uriFor(relPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: MIRROR_SCHEME, path: '/' + relPath.replace(/^\/+/, '') });
  }

  has(uri: vscode.Uri): boolean {
    return this.files.has(uri.path);
  }

  clear(): void {
    const uris = [...this.files.keys()].map((p) => vscode.Uri.from({ scheme: MIRROR_SCHEME, path: p }));
    this.files.clear();
    this.emitter.fire(uris.map((uri) => ({ type: vscode.FileChangeType.Deleted, uri })));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this.whenOpen(() => this.statNow(uri));
  }

  private statNow(uri: vscode.Uri): vscode.FileStat {
    const f = this.files.get(uri.path);
    if (f) {
      return { type: vscode.FileType.File, ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength, permissions: vscode.FilePermission.Readonly };
    }
    if (this.isDirectory(uri.path)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    return this.whenOpen(() => this.readDirectoryNow(uri));
  }

  private readDirectoryNow(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
    const out = new Map<string, vscode.FileType>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) out.set(rest, vscode.FileType.File);
      else out.set(rest.slice(0, slash), vscode.FileType.Directory);
    }
    return [...out];
  }

  createDirectory(): void {
    // Directories are implicit.
  }

  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    return this.whenOpen(() => {
      const f = this.files.get(uri.path);
      if (!f) throw vscode.FileSystemError.FileNotFound(uri);
      return f.data;
    });
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const now = Date.now();
    const existing = this.files.get(uri.path);
    this.files.set(uri.path, { data: content, mtime: now, ctime: existing?.ctime ?? now });
    this.emitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  /**
   * Replaces a file's bytes without telling VS Code, so an open document that
   * is being typed into is not reloaded. A document that is opened or reverted
   * later reads these bytes.
   */
  store(uri: vscode.Uri, content: Uint8Array): void {
    const existing = this.files.get(uri.path);
    if (!existing) {
      this.writeFile(uri, content);
      return;
    }
    // A strictly newer mtime, so a later reload never mistakes new bytes for the old ones.
    this.files.set(uri.path, { data: content, mtime: Math.max(Date.now(), existing.mtime + 1), ctime: existing.ctime });
  }

  delete(uri: vscode.Uri): void {
    const prefix = uri.path + '/';
    for (const p of [...this.files.keys()]) {
      if (p === uri.path || p.startsWith(prefix)) this.files.delete(p);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const f = this.files.get(oldUri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.files.delete(oldUri.path);
    this.files.set(newUri.path, f);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  /** Runs a read now when open, otherwise once open() is called. */
  private whenOpen<T>(read: () => T): T | Thenable<T> {
    return this.gate ? this.gate.then(read) : read();
  }

  private isDirectory(path: string): boolean {
    if (path === '/' || path === '') return true;
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    return false;
  }
}

const encoder = new TextEncoder();

/** A mirror file's bytes: LF-normalized text with the recorded line ending put back. */
export function mirrorBytes(text: string, eol: Eol): Uint8Array {
  return encoder.encode(eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
}

/** Read-only before/after snapshots for the "Show Diff" command. */
export const SNAPSHOT_SCHEME = 'agent-typewriter-snapshot';

export class SnapshotProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly lookup: (seq: number) => { before: string; after: string } | undefined) {}

  static uriFor(seq: number, side: 'before' | 'after', relPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: '/' + relPath, query: `seq=${seq}&side=${side}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const e = this.lookup(Number(params.get('seq')));
    if (!e) return '(this change is no longer in the buffer)';
    return params.get('side') === 'before' ? e.before : e.after;
  }
}
