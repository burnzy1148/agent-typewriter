import * as vscode from 'vscode';
import { PathFilter } from './filter';
import { countChanges, detectEol, normalizeEol, type Eol } from './planner';
import { listCleanTracked, readBlob, selectWithinBudget, type BudgetCandidate } from './gitBaseline';
import { checkIgnored, listIgnored, type IgnoredPaths } from './gitIgnore';
import { activeProfileOf } from './profiles';
import { decideOwnSave } from './ownSave';
import { ReorderBuffer, clampOrderKey } from './reorder';
import type { ChangeKind, NewChangeEvent, Timeline } from './timeline';
import type { Settings } from './config';

/** How long a change read mid-save waits for the save to finish. */
const SAVE_SETTLE_MAX_MS = 1000;

/** How many recent watcher events and read outcomes the recorder keeps for diagnostics. */
const ACTIVITY_LIMIT = 200;

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
  /** Clean tracked files whose baseline is their git index blob instead of an in-memory snapshot. */
  private readonly gitBaselines = new Map<string, GitBaselineRef>();
  /** Set when git cannot run; git baselines stay off until the next start or toggle. */
  private gitUnavailable = false;
  /** Bumped by each baseline capture and by stop; an older capture stops writing once it is stale. */
  private baselineGen = 0;
  private readonly timers = new Map<string, Burst>();
  /** Holds recorded changes briefly so they reach the timeline in write order. */
  private readonly reorder: ReorderBuffer<NewChangeEvent>;
  /** Text the latest editor save wrote, per file, until the next change of that file is read. */
  private readonly ownSaves = new Map<string, OwnSave>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private filter: PathFilter;
  /** Name of the active filter profile the current filter came from, or ''. */
  private profileName = '';
  /** Gitignored paths per workspace folder (keyed by folder URI) while `respectGitignore` is on and git can tell. */
  private readonly ignored = new Map<string, IgnoredPaths>();
  /** Folders already logged as having no gitignore rules this session. */
  private readonly ignoreNoted = new Set<string>();
  private ignoreRefresh: NodeJS.Timeout | undefined;
  private running = false;
  private readonly decoder = new TextDecoder('utf-8');
  /** Recent watcher events and what reading each one did, oldest first. */
  private readonly activity: string[] = [];

  constructor(
    private readonly timeline: Timeline,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
  ) {
    this.filter = this.buildFilter();
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
    return this.snapshots.size + this.gitBaselines.size;
  }

  describeFilter(): string {
    const profile = this.profileName ? `${this.profileName}: ` : '';
    return profile + this.filter.describe() + (this.ignored.size > 0 ? ', not gitignored' : '');
  }

  private buildFilter(): PathFilter {
    const s = this.settings();
    this.profileName = activeProfileOf(s) ? s.activeProfile : '';
    return new PathFilter(s);
  }

  /** True if this workspace path passes the current filters. */
  matches(uri: vscode.Uri): boolean {
    return this.passes(uri);
  }

  /**
   * Recent watcher events, what reading each one did, and what is still held,
   * for telling a change the watcher never reported from one the recorder dropped.
   */
  describeActivity(): string {
    const debouncing = [...this.timers.keys()].map((k) => relPathOf(vscode.Uri.parse(k)));
    return [
      ...this.activity,
      `debouncing: ${debouncing.length > 0 ? debouncing.join(', ') : 'none'}; held for reordering: ${this.reorder.size}`,
    ].join('\n');
  }

  private note(message: string): void {
    this.activity.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
  }

  /** True once this file has a baseline, so its next change will be recorded. */
  hasBaseline(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return this.snapshots.has(key) || this.gitBaselines.has(key);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error('Open a folder or workspace first.');
    this.running = true;
    this.filter = this.buildFilter();

    for (const folder of folders) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      watcher.onDidCreate((uri) => this.schedule(uri, 'create'), null, this.subscriptions);
      watcher.onDidChange((uri) => this.schedule(uri, 'change'), null, this.subscriptions);
      watcher.onDidDelete((uri) => this.schedule(uri, 'delete'), null, this.subscriptions);
      this.subscriptions.push(watcher);
    }
    // Remember what each editor save writes. Will-save covers a watcher that
    // reports the write before did-save fires; did-save adds edits that save
    // participants (format on save) make during the save.
    vscode.workspace.onWillSaveTextDocument(
      (e) => {
        if (e.document.uri.scheme !== 'file') return;
        let resolve!: () => void;
        const settled = new Promise<void>((r) => (resolve = r));
        this.ownSaves.set(e.document.uri.toString(), { text: e.document.getText(), settled, resolve, done: false });
      },
      null,
      this.subscriptions,
    );
    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        if (doc.uri.scheme !== 'file') return;
        const key = doc.uri.toString();
        const entry = this.ownSaves.get(key);
        if (entry && !entry.done) {
          entry.text = doc.getText();
          entry.done = true;
          entry.resolve();
        } else {
          this.ownSaves.set(key, { text: doc.getText(), settled: Promise.resolve(), resolve: () => {}, done: true });
        }
      },
      null,
      this.subscriptions,
    );

    this.gitUnavailable = false;
    this.ignoreNoted.clear();
    await this.refreshIgnored();
    await this.captureBaseline();
    this.log.appendLine(`Watching ${this.watchedCount} files (${this.filter.describe()}).`);
  }

  stop(): void {
    this.running = false;
    this.baselineGen++;
    for (const d of this.subscriptions.splice(0)) d.dispose();
    for (const burst of this.timers.values()) {
      clearTimeout(burst.timer);
      burst.done();
    }
    this.timers.clear();
    clearTimeout(this.ignoreRefresh);
    this.ignored.clear();
    this.reorder.drain();
    this.snapshots.clear();
    this.gitBaselines.clear();
    this.ownSaves.clear();
  }

  /** Re-reads filter settings and gitignore rules. Newly matching files get a baseline so their next change is recorded. */
  async refreshFilter(): Promise<void> {
    this.filter = this.buildFilter();
    if (!this.running) return;
    await this.refreshIgnored();
    for (const store of [this.snapshots, this.gitBaselines]) {
      for (const key of [...store.keys()]) {
        if (!this.passes(vscode.Uri.parse(key))) store.delete(key);
      }
    }
    await this.captureBaseline();
    this.log.appendLine(`Filter changed: watching ${this.watchedCount} files (${this.filter.describe()}).`);
    this.note(`filter changed: watching ${this.watchedCount} files`);
  }

  /**
   * Rebuilds baselines after `gitBaselines` or `baselineBudgetMB` changes.
   * Every stored baseline equals the file's current disk text (the recorder
   * updates it on each change), so baselines can be re-taken from disk and git
   * for every file not mid-change.
   */
  async refreshBaselines(): Promise<void> {
    if (!this.running) return;
    this.gitUnavailable = false;
    for (const store of [this.snapshots, this.gitBaselines]) {
      for (const key of [...store.keys()]) if (!this.timers.has(key)) store.delete(key);
    }
    await this.captureBaseline();
    this.log.appendLine(`Baselines rebuilt: watching ${this.watchedCount} files.`);
    this.note(`baselines rebuilt: watching ${this.watchedCount} files`);
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
    // A file written after this point is a change still on its way through the
    // watcher; snapshotting it now would swallow that change.
    const startedAt = Date.now();
    const gen = ++this.baselineGen;
    const stale = () => gen !== this.baselineGen;
    const s = this.settings();
    const exclude = s.exclude.length > 0 ? `{${s.exclude.join(',')}}` : undefined;
    const known = (key: string) => this.snapshots.has(key) || this.gitBaselines.has(key);
    const candidates: vscode.Uri[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude);
      const clean = s.gitBaselines ? await this.cleanTracked(folder) : undefined;
      if (stale()) return;
      for (const uri of found) {
        const key = uri.toString();
        const rel = relPathOf(uri);
        if (!this.passes(uri) || known(key)) continue;
        const sha = clean?.get(rel);
        if (sha !== undefined) this.gitBaselines.set(key, { folder: folder.uri.fsPath, path: rel, sha });
        else candidates.push(uri);
      }
    }

    // Everything else gets an in-memory snapshot, newest first, within the budget.
    const maxBytes = s.maxFileSizeKB * 1024;
    const stats: BudgetCandidate[] = [];
    await inBatches(candidates, async (uri) => {
      const st = await stat(uri);
      if (st && st.type === vscode.FileType.File && st.size <= maxBytes && st.mtime < startedAt) {
        stats.push({ key: uri.toString(), size: st.size, mtime: st.mtime });
      }
    });
    if (stale()) return;
    let used = 0;
    for (const snap of this.snapshots.values()) used += snap.text.length;
    const chosen = selectWithinBudget(stats, Math.max(0, s.baselineBudgetMB * 1024 * 1024 - used));
    await inBatches(
      candidates.filter((u) => chosen.has(u.toString())),
      async (uri) => {
        const snap = await this.readText(uri, s);
        if (snap !== undefined && !stale() && !this.snapshots.has(uri.toString())) this.snapshots.set(uri.toString(), snap);
      },
    );
    if (stale()) return;
    const uncovered = stats.length - chosen.size;
    if (uncovered > 0) {
      this.log.appendLine(
        `${uncovered} matching files have no baseline because baselineBudgetMB (${s.baselineBudgetMB}) is reached; ` +
          'their first change is only captured as a baseline. Raise the budget, enable gitBaselines, or narrow the filters.',
      );
    }
  }

  /** Path filters plus, while `respectGitignore` is on, the folder's gitignored paths known so far. */
  private passes(uri: vscode.Uri): boolean {
    if (!this.filter.matches(relPathOf(uri))) return false;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return !(folder && this.ignored.get(folder.uri.toString())?.has(relPathOf(uri)));
  }

  /** Re-lists gitignored paths for each folder, or clears them when the setting is off. */
  private async refreshIgnored(): Promise<void> {
    const next = new Map<string, IgnoredPaths>();
    if (this.settings().respectGitignore) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const key = folder.uri.toString();
        const r = folder.uri.scheme === 'file' ? await listIgnored(folder.uri.fsPath) : ({ kind: 'not-repo' } as const);
        if (r.kind === 'ok') next.set(key, r.ignored);
        else if (!this.ignoreNoted.has(key)) {
          this.ignoreNoted.add(key);
          const why = r.kind === 'unavailable' ? `git could not run (${r.reason})` : 'it is not in a git repository';
          this.log.appendLine(`respectGitignore has no effect for ${folder.name}: ${why}.`);
        }
      }
    }
    this.ignored.clear();
    for (const [k, v] of next) this.ignored.set(k, v);
  }

  /** A file the ignore snapshot doesn't know yet: asks git once and remembers an ignored answer. */
  private async newlyIgnored(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const known = folder && this.ignored.get(folder.uri.toString());
    if (!known) return false;
    const rel = relPathOf(uri);
    if (!(await checkIgnored(folder.uri.fsPath, rel))) return false;
    known.add(rel);
    return true;
  }

  /** A `.gitignore` changed: re-apply the rules once the burst of writes settles. */
  private scheduleIgnoreRefresh(): void {
    clearTimeout(this.ignoreRefresh);
    this.ignoreRefresh = setTimeout(() => {
      this.refreshFilter().catch((err) => this.log.appendLine(`Failed to re-apply .gitignore: ${String(err)}`));
    }, 300);
  }

  /** Folder-relative path -> index sha for clean tracked files, or undefined when git can't help here. */
  private async cleanTracked(folder: vscode.WorkspaceFolder): Promise<Map<string, string> | undefined> {
    if (this.gitUnavailable || folder.uri.scheme !== 'file') return undefined;
    const r = await listCleanTracked(folder.uri.fsPath);
    if (r.kind === 'unavailable') {
      this.gitUnavailable = true;
      this.log.appendLine(`Git-backed baselines are off: git could not run (${r.reason}). Using in-memory baselines.`);
      return undefined;
    }
    if (r.kind === 'not-repo') {
      this.log.appendLine(`${folder.name} is not in a git repository; using in-memory baselines for it.`);
      return undefined;
    }
    return r.files;
  }

  /** Takes a file's git baseline, if it has one, and reads it as a snapshot. */
  private async takeGitBaseline(key: string, s: Settings): Promise<Snapshot | undefined> {
    const ref = this.gitBaselines.get(key);
    if (!ref) return undefined;
    this.gitBaselines.delete(key);
    const bytes = await readBlob(ref.folder, ref.path, ref.sha);
    const snap = bytes && this.decode(bytes, s);
    if (!snap) this.log.appendLine(`Could not read the git baseline of ${ref.path}; its change is only captured as a baseline.`);
    return snap;
  }

  private schedule(uri: vscode.Uri, event: 'create' | 'change' | 'delete'): void {
    if (!this.running || uri.scheme !== 'file') return;
    if (this.ignored.size > 0 && uri.path.endsWith('/.gitignore')) this.scheduleIgnoreRefresh();
    const passes = this.passes(uri);
    this.note(`watcher ${event} ${relPathOf(uri)}${passes ? '' : ' (filtered out)'}`);
    if (!passes) return;
    const created = event === 'create';
    const key = uri.toString();
    const now = Date.now();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const burst: Burst = {
      timer: setTimeout(() => {
        this.timers.delete(key);
        this.flush(uri, burst)
          .catch((err) => {
            this.note(`read failed ${relPathOf(uri)}: ${String(err)}`);
            this.log.appendLine(`Failed to record ${relPathOf(uri)}: ${String(err)}`);
          })
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
    const previous = this.snapshots.get(key) ?? (await this.takeGitBaseline(key, s));

    // A change read mid-save waits for the save to finish, so the comparison
    // below sees the final saved text.
    const pendingSave = s.ignoreOwnSaves ? this.ownSaves.get(key) : undefined;
    if (pendingSave && !pendingSave.done) {
      await Promise.race([pendingSave.settled, new Promise((r) => setTimeout(r, SAVE_SETTLE_MAX_MS))]);
    }

    const exists = await stat(uri);
    if (!exists) {
      this.ownSaves.delete(key);
      if (previous !== undefined) {
        this.snapshots.delete(key);
        this.record(uri, relPath, 'delete', previous.text, '', previous.eol, burst.firstArrival);
      } else this.note(`gone, no baseline ${relPath}`);
      return;
    }
    if (exists.type !== vscode.FileType.File) return;
    if (previous === undefined && (await this.newlyIgnored(uri))) {
      this.note(`newly ignored ${relPath}`);
      return;
    }
    const writtenAt = clampOrderKey(exists.mtime, burst.firstArrival, burst.lastArrival, s.reorderWindowMs);

    const snap = await this.readText(uri, s, exists.size);
    if (snap === undefined) {
      this.note(`unreadable, binary or too large ${relPath}`);
      this.snapshots.delete(key);
      return;
    }

    // Each editor save is matched once, against the next change read for its file.
    const saved = this.ownSaves.get(key);
    this.ownSaves.delete(key);
    const decision = s.ignoreOwnSaves ? decideOwnSave(saved?.text, snap.text) : ({ kind: 'external' } as const);
    if (decision.kind === 'own') {
      this.note(`own save ${relPath}`);
      this.snapshots.set(key, snap);
      return;
    }
    if (decision.kind === 'after-own') {
      // Something wrote after the user's save: replay only that, from the saved text.
      this.snapshots.set(key, snap);
      const kind = previous === undefined && burst.created ? 'create' : 'modify';
      this.record(uri, relPath, kind, decision.before, snap.text, snap.eol, writtenAt);
      return;
    }

    // Always store the new snapshot, so a line-ending-only rewrite updates eol
    // for the next change without being recorded itself.
    this.snapshots.set(key, snap);
    if (previous === undefined) {
      // No baseline: a brand-new file is typed from empty; an unknown existing
      // file just gets its baseline now.
      if (burst.created) this.record(uri, relPath, 'create', '', snap.text, snap.eol, writtenAt);
      else {
        this.note(`baseline captured ${relPath}`);
        this.log.appendLine(`Baseline captured for ${relPath}; its next change will be replayed.`);
      }
      return;
    }
    if (previous.text === snap.text) {
      this.note(`unchanged ${relPath}`);
      return;
    }
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
    this.note(`recorded ${kind} ${relPath}`);
    this.reorder.add(event, writtenAt, event.uri);
  }

  private async readText(uri: vscode.Uri, s: Settings, knownSize?: number): Promise<Snapshot | undefined> {
    try {
      const size = knownSize ?? (await vscode.workspace.fs.stat(uri)).size;
      if (size > s.maxFileSizeKB * 1024) return undefined;
      return this.decode(await vscode.workspace.fs.readFile(uri), s);
    } catch {
      return undefined;
    }
  }

  /** Decodes file bytes into a snapshot; undefined for binary or oversized content. */
  private decode(bytes: Uint8Array, s: Settings): Snapshot | undefined {
    if (bytes.byteLength > s.maxFileSizeKB * 1024) return undefined;
    const text = this.decoder.decode(bytes);
    if (text.slice(0, 8000).includes('\u0000')) return undefined;
    return { text: normalizeEol(text), eol: detectEol(text) };
  }
}

/** What the latest editor save of a file wrote. `done` once did-save has fired. */
interface OwnSave {
  text: string;
  settled: Promise<void>;
  resolve: () => void;
  done: boolean;
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

/** Where a clean tracked file's baseline lives in git. */
interface GitBaselineRef {
  /** Workspace folder path git runs in. */
  folder: string;
  /** Folder-relative path, forward slashes. */
  path: string;
  /** Index blob sha. */
  sha: string;
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 64): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
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
