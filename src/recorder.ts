import * as vscode from 'vscode';
import { PathFilter } from './filter';
import { countChanges, detectEol, normalizeEol, type Eol } from './planner';
import { ReorderBuffer, clampOrderKey } from './reorder';
import type { ChangeKind, NewChangeEvent, Timeline } from './timeline';
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
  private readonly timers = new Map<string, Burst>();
  /** Holds recorded changes briefly so they reach the timeline in write order. */
  private readonly reorder: ReorderBuffer<NewChangeEvent>;
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
    this.reorder = new ReorderBuffer(
      (events) => {
        for (const e of events) this.timeline.push(e);
      },
      () => this.settings().reorderWindowMs,
    );
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
    // Mark before the write as well as after: the watcher can report the write
    // before onDidSaveTextDocument fires, and the save would then look external.
    const markOwnSave = (doc: vscode.TextDocument) => {
      if (doc.uri.scheme === 'file') this.ownSaves.set(doc.uri.toString(), Date.now());
    };
    vscode.workspace.onWillSaveTextDocument((e) => markOwnSave(e.document), null, this.subscriptions);
    vscode.workspace.onDidSaveTextDocument(markOwnSave, null, this.subscriptions);

    await this.captureBaseline();
    this.log.appendLine(`Watching ${this.snapshots.size} files (${this.filter.describe()}).`);
  }

  stop(): void {
    this.running = false;
    for (const d of this.subscriptions.splice(0)) d.dispose();
    for (const burst of this.timers.values()) {
      clearTimeout(burst.timer);
      burst.done();
    }
    this.timers.clear();
    this.reorder.drain();
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

  /** Adds every held change to the timeline now, in write order. */
  drainHeld(): void {
    this.reorder.drain();
  }

  dispose(): void {
    this.stop();
    this.reorder.dispose();
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
    const now = Date.now();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const burst: Burst = {
      timer: setTimeout(() => {
        this.timers.delete(key);
        this.flush(uri, burst)
          .catch((err) => this.log.appendLine(`Failed to record ${relPathOf(uri)}: ${String(err)}`))
          .finally(burst.done);
      }, this.settings().debounceMs),
      created: created || (existing?.created ?? false),
      firstArrival: existing?.firstArrival ?? now,
      lastArrival: now,
      done: existing?.done ?? this.reorder.pending(now),
    };
    this.timers.set(key, burst);
  }

  private async flush(uri: vscode.Uri, burst: Burst): Promise<void> {
    if (!this.running) return;
    const key = uri.toString();
    const relPath = displayPathOf(uri);
    const s = this.settings();
    const previous = this.snapshots.get(key);

    const exists = await stat(uri);
    if (!exists) {
      if (previous !== undefined) {
        this.snapshots.delete(key);
        this.record(uri, relPath, 'delete', previous.text, '', previous.eol, burst.firstArrival);
      }
      return;
    }
    if (exists.type !== vscode.FileType.File) return;
    const writtenAt = clampOrderKey(exists.mtime, burst.firstArrival, burst.lastArrival, s.reorderWindowMs);

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
      if (burst.created) this.record(uri, relPath, 'create', '', snap.text, snap.eol, writtenAt);
      else this.log.appendLine(`Baseline captured for ${relPath}; its next change will be replayed.`);
      return;
    }
    if (previous.text === snap.text) return;
    this.record(uri, relPath, 'modify', previous.text, snap.text, snap.eol, writtenAt);
  }

  /** Hands a change to the reorder buffer; `writtenAt` orders it and becomes its recorded time. */
  private record(
    uri: vscode.Uri,
    relPath: string,
    kind: ChangeKind,
    before: string,
    after: string,
    eol: Eol,
    writtenAt: number,
  ): void {
    const { added, removed } = countChanges(before, after);
    const event: NewChangeEvent = {
      uri: uri.toString(),
      relPath,
      time: writtenAt,
      kind,
      before,
      after,
      eol,
      linesAdded: added,
      linesRemoved: removed,
    };
    this.reorder.add(event, writtenAt, event.uri);
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

/** Watcher events for one file merged by the debounce timer. */
interface Burst {
  timer: NodeJS.Timeout;
  created: boolean;
  /** When the first and latest watcher events of this burst arrived. */
  firstArrival: number;
  lastArrival: number;
  /** Tells the reorder buffer this burst has been read. */
  done: () => void;
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
