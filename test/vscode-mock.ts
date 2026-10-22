/**
 * A minimal 'vscode' module for unit tests that run the real Recorder against
 * real files (see test/recorder.test.ts). The test script aliases 'vscode' to
 * this file. Only what the recorder uses is here; `mock` lets a test drive it.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}

  static file(fsPath: string): Uri {
    let p = fsPath.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(p)) p = '/' + p;
    return new Uri('file', p);
  }

  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
    if (!m) throw new Error(`not a URI: ${value}`);
    return new Uri(m[1], decodeURI(m[2]));
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, nodePath.posix.join(base.path, ...parts));
  }

  get fsPath(): string {
    const p = /^\/[a-zA-Z]:/.test(this.path) ? this.path.slice(1) : this.path;
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }

  toString(): string {
    return `${this.scheme}://${encodeURI(this.path)}`;
  }
}

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>, thisArg?: unknown, disposables?: { dispose(): unknown }[]) => {
    const bound: Listener<T> = (e) => listener.call(thisArg, e);
    this.listeners.add(bound);
    const d = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(d);
    return d;
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class RelativePattern {
  readonly baseUri: Uri;
  constructor(
    base: Uri | { uri: Uri },
    readonly pattern: string,
  ) {
    this.baseUri = base instanceof Uri ? base : base.uri;
  }
}

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface MockWatcher {
  base: Uri;
  disposed: boolean;
  create: EventEmitter<Uri>;
  change: EventEmitter<Uri>;
  delete: EventEmitter<Uri>;
}

/** Test controls: folders, settings, watchers, and a gate that holds directory reads. */
export const mock = {
  folders: [] as WorkspaceFolder[],
  /** `section.key` -> value, as getConfiguration(section).get(key) reads it. */
  config: new Map<string, unknown>(),
  watchers: [] as MockWatcher[],
  /** While set, every readDirectory waits for it. */
  readDirectoryGate: undefined as Promise<void> | undefined,
  /** While set, every readFile waits for it; `onReadFile` hears each read as it starts waiting. */
  readFileGate: undefined as Promise<void> | undefined,
  onReadFile: undefined as ((fsPath: string) => void) | undefined,
  configEmitter: new EventEmitter<{ affectsConfiguration(section: string): boolean }>(),
  /** Sets the folders, as a window opened on them. */
  open(...dirs: string[]): void {
    this.folders = dirs.map((d, index) => ({ uri: Uri.file(d), name: nodePath.basename(d), index }));
  },
  reset(): void {
    this.folders = [];
    this.config.clear();
    this.watchers = [];
    this.readDirectoryGate = undefined;
    this.readFileGate = undefined;
    this.onReadFile = undefined;
  },
  /** Fires a watcher event on every live watcher whose base holds the file. */
  fire(kind: 'create' | 'change' | 'delete', fsPath: string): void {
    const uri = Uri.file(fsPath);
    for (const w of this.watchers) if (!w.disposed && uri.path.startsWith(w.base.path.replace(/\/$/, '') + '/')) w[kind].fire(uri);
  },
  /** Changes a setting and tells listeners, as a settings edit does. */
  set(key: string, value: unknown): void {
    this.config.set(key, value);
    this.configEmitter.fire({ affectsConfiguration: (section) => key === section || key.startsWith(section + '.') });
  },
};

function folderOf(uri: Uri): WorkspaceFolder | undefined {
  let best: WorkspaceFolder | undefined;
  for (const f of mock.folders) {
    const base = f.uri.path.replace(/\/$/, '');
    if ((uri.path === base || uri.path.startsWith(base + '/')) && (!best || base.length > best.uri.path.length)) best = f;
  }
  return best;
}

function typeOf(p: string): FileType {
  const l = fs.lstatSync(p);
  if (!l.isSymbolicLink()) return l.isDirectory() ? FileType.Directory : l.isFile() ? FileType.File : FileType.Unknown;
  try {
    const t = fs.statSync(p);
    return FileType.SymbolicLink | (t.isDirectory() ? FileType.Directory : t.isFile() ? FileType.File : FileType.Unknown);
  } catch {
    return FileType.SymbolicLink;
  }
}

const noop = new EventEmitter<unknown>();

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined {
    return mock.folders.length > 0 ? mock.folders : undefined;
  },
  textDocuments: [] as unknown[],
  getWorkspaceFolder: folderOf,
  asRelativePath(target: Uri | string, includeWorkspaceFolder = true): string {
    const uri = typeof target === 'string' ? Uri.file(target) : target;
    const folder = folderOf(uri);
    if (!folder) return uri.fsPath;
    const rel = uri.path.slice(folder.uri.path.replace(/\/$/, '').length + 1);
    return includeWorkspaceFolder && mock.folders.length > 1 ? `${folder.name}/${rel}` : rel;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const k = `${section}.${key}`;
        return mock.config.has(k) ? (mock.config.get(k) as T) : fallback;
      },
      inspect(key: string) {
        const k = `${section}.${key}`;
        return mock.config.has(k) ? { key: k, workspaceValue: mock.config.get(k) } : { key: k };
      },
    };
  },
  fs: {
    async stat(uri: Uri) {
      const st = fs.statSync(uri.fsPath, { throwIfNoEntry: false }) ?? fs.lstatSync(uri.fsPath);
      return { type: typeOf(uri.fsPath), size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      mock.onReadFile?.(uri.fsPath);
      await mock.readFileGate;
      return new Uint8Array(fs.readFileSync(uri.fsPath));
    },
    async readDirectory(uri: Uri): Promise<[string, FileType][]> {
      await mock.readDirectoryGate;
      return fs.readdirSync(uri.fsPath).map((name) => [name, typeOf(nodePath.join(uri.fsPath, name))]);
    },
  },
  createFileSystemWatcher(pattern: RelativePattern) {
    const w: MockWatcher = {
      base: pattern.baseUri,
      disposed: false,
      create: new EventEmitter<Uri>(),
      change: new EventEmitter<Uri>(),
      delete: new EventEmitter<Uri>(),
    };
    mock.watchers.push(w);
    return {
      onDidCreate: w.create.event,
      onDidChange: w.change.event,
      onDidDelete: w.delete.event,
      dispose: () => (w.disposed = true),
    };
  },
  onWillSaveTextDocument: noop.event,
  onDidSaveTextDocument: noop.event,
  onDidChangeWorkspaceFolders: noop.event,
  onDidChangeConfiguration: mock.configEmitter.event,
};
