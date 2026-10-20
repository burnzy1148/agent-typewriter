import * as vscode from 'vscode';
import { PathFilter } from './filter';
import { countChanges, detectEol, normalizeEol, type Eol } from './planner';
import type { ChangeKind, Timeline } from './timeline';
import type { Settings } from './config';

const BASELINE_MAX_FILES = 5000;
const OWN_SAVE_WINDOW_MS = 2000;

/**
 * Watches the workspace and turns each settled file write into a timeline
 * event carrying the full before/after text.
 *
 * It keeps a snapshot of every matching file, so the "before" side is known
 * at the moment a change lands, not at the moment it is played. That is what
 * makes the buffer replayable in exact order across many files.
 */
export class Recorder implements vscode.Disposable {
  /** LF-normalized text plus the file's real line ending. */
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; created: boolean }>();
  private readonly ownSaves = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private filter: PathFilter;
  private running = false;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly timeline: Timeline,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
  ) {
    this.filter = new PathFilter(settings());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get watchedCount(): number {
    return this.snapshots.size;
  }

  describeFilter(): string {
    return this.filter.describe();
  }

  /** True if this workspace path passes the current filters. */
  matches(uri: vscode.Uri): boolean {
    return this.filter.matches(relPathOf(uri));
  }

  async start(): Promise<void> {
    if (this.running) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error('Open a folder or workspace first.');
    this.running = true;
    this.filter = new PathFilter(this.settings());

    for (const folder of folders) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      watcher.onDidCreate((uri) => this.schedule(uri, true), null, this.subscriptions);
      watcher.onDidChange((uri) => this.schedule(uri, false), null, this.subscriptions);
      watcher.onDidDelete((uri) => this.schedule(uri, false), null, this.subscriptions);
      this.subscriptions.push(watcher);
    }
    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        if (doc.uri.scheme === 'file') this.ownSaves.set(doc.uri.toString(), Date.now());
      },
      null,
      this.subscriptions,
    );

    await this.captureBaseline();
    this.log.appendLine(`Watching ${this.snapshots.size} files (${this.filter.describe()}).`);
  }

  stop(): void {
    this.running = false;
    for (const d of this.subscriptions.splice(0)) d.dispose();
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.snapshots.clear();
    this.ownSaves.clear();
  }

  /** Re-reads filter settings. Newly matching files get a baseline so their next change is recorded. */
  async refreshFilter(): Promise<void> {
    this.filter = new PathFilter(this.settings());
    if (!this.running) return;
    for (const key of [...this.snapshots.keys()]) {
      if (!this.filter.matches(relPathOf(vscode.Uri.parse(key)))) this.snapshots.delete(key);
    }
    await this.captureBaseline();
    this.log.appendLine(`Filter changed: watching ${this.snapshots.size} files (${this.filter.describe()}).`);
  }

  dispose(): void {
    this.stop();
  }

  private async captureBaseline(): Promise<void> {
    const s = this.settings();
    const exclude = s.exclude.length > 0 ? `{${s.exclude.join(',')}}` : undefined;
    const uris: vscode.Uri[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        exclude,
        BASELINE_MAX_FILES * 4,
      );
      for (const uri of found) {
        if (this.filter.matches(relPathOf(uri)) && !this.snapshots.has(uri.toString())) uris.push(uri);
      }
    }
    if (uris.length > BASELINE_MAX_FILES) {
      this.log.appendLine(
        `Baseline capped at ${BASELINE_MAX_FILES} of ${uris.length} matching files. ` +
          'Narrow the include or extension filters; changes to files without a baseline are only recorded from their second change on.',
      );
      uris.length = BASELINE_MAX_FILES;
    }
    const batch = 32;
    for (let i = 0; i < uris.length; i += batch) {
      await Promise.all(
        uris.slice(i, i + batch).map(async (uri) => {
          const snap = await this.readText(uri, s);
          if (snap !== undefined) this.snapshots.set(uri.toString(), snap);
        }),
      );
    }
  }

  private schedule(uri: vscode.Uri, created: boolean): void {
    if (!this.running || uri.scheme !== 'file') return;
    if (!this.filter.matches(relPathOf(uri))) return;
    const key = uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.flush(uri, created || (existing?.created ?? false)).catch((err) =>
        this.log.appendLine(`Failed to record ${relPathOf(uri)}: ${String(err)}`),
      );
    }, this.settings().debounceMs);
    this.timers.set(key, { timer, created: created || (existing?.created ?? false) });
  }

  private async flush(uri: vscode.Uri, created: boolean): Promise<void> {
    if (!this.running) return;
    const key = uri.toString();
    const relPath = displayPathOf(uri);
    const s = this.settings();
    const previous = this.snapshots.get(key);

    const exists = await stat(uri);
    if (!exists) {
      if (previous !== undefined) {
        this.snapshots.delete(key);
        this.record(uri, relPath, 'delete', previous.text, '', previous.eol);
      }
      return;
    }
    if (exists.type !== vscode.FileType.File) return;

    const snap = await this.readText(uri, s, exists.size);
    if (snap === undefined) {
      this.snapshots.delete(key);
      return;
    }

    const savedAt = this.ownSaves.get(key);
    if (s.ignoreOwnSaves && savedAt !== undefined && Date.now() - savedAt < OWN_SAVE_WINDOW_MS) {
      this.ownSaves.delete(key);
      this.snapshots.set(key, snap);
      return;
    }

    // Always store the new snapshot, so a line-ending-only rewrite updates eol
    // for the next change without being recorded itself.
    this.snapshots.set(key, snap);
    if (previous === undefined) {
      // No baseline: a brand-new file is typed from empty; an unknown existing
      // file just gets its baseline now.
      if (created) this.record(uri, relPath, 'create', '', snap.text, snap.eol);
      else this.log.appendLine(`Baseline captured for ${relPath}; its next change will be replayed.`);
      return;
    }
    if (previous.text === snap.text) return;
    this.record(uri, relPath, 'modify', previous.text, snap.text, snap.eol);
  }

  private record(uri: vscode.Uri, relPath: string, kind: ChangeKind, before: string, after: string, eol: Eol): void {
    const { added, removed } = countChanges(before, after);
    this.timeline.push({
      uri: uri.toString(),
      relPath,
      time: Date.now(),
      kind,
      before,
      after,
      eol,
      linesAdded: added,
      linesRemoved: removed,
    });
  }

  private async readText(uri: vscode.Uri, s: Settings, knownSize?: number): Promise<Snapshot | undefined> {
    try {
      const size = knownSize ?? (await vscode.workspace.fs.stat(uri)).size;
      if (size > s.maxFileSizeKB * 1024) return undefined;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = this.decoder.decode(bytes);
      if (text.slice(0, 8000).includes('\u0000')) return undefined;
      return { text: normalizeEol(text), eol: detectEol(text) };
    } catch {
      return undefined;
    }
  }
}

interface Snapshot {
  text: string;
  eol: Eol;
}

async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/** Path used for filtering: relative to its workspace folder, so globs like src/** work in every folder. */
export function relPathOf(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

/** Path used for display and mirror documents: prefixed with the folder name in multi-root workspaces so files never collide. */
export function displayPathOf(uri: vscode.Uri): string {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
}
