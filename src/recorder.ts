import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { PathFilter } from './filter';
import { countChanges, detectEol, normalizeEol, type Eol } from './planner';
import { listCleanTracked, readBlob, selectWithinBudget, type BudgetCandidate } from './gitBaseline';
import { checkIgnored, IgnoredPaths, listIgnored } from './gitIgnore';
import {
  checkoutDisplayPath,
  checkoutName,
  listWorktrees,
  nestedUnder,
  ownCheckout,
  pathKey,
  pointsAtLinkedWorktree,
  rootIn,
  worktreeLabels,
  type Worktree,
} from './worktrees';
import { activeProfileOf } from './profiles';
import { decideOwnSave } from './ownSave';
import { ReorderBuffer, clampOrderKey } from './reorder';
import type { ChangeKind, NewChangeEvent, Timeline } from './timeline';
import type { Settings } from './config';

/** How long a change read mid-save waits for the save to finish. */
const SAVE_SETTLE_MAX_MS = 1000;

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
  /** The checkout each workspace folder records while running, keyed by folder URI. */
  private readonly scopes = new Map<string, Scope>();
  /** Scope refreshes run one at a time, so watchers are never replaced twice at once. */
  private scopeWork: Promise<void> = Promise.resolve();
  private worktreeRefresh: NodeJS.Timeout | undefined;
  /** Pending "is the chosen checkout gone?" checks, per folder URI. */
  private readonly goneChecks = new Map<string, NodeJS.Timeout>();
  /** Filter refreshes run one at a time, so an older one never overwrites a newer one's gitignore rules. */
  private filterWork: Promise<void> = Promise.resolve();
  private readonly scopeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the checkout a folder records, or its worktree list, may have changed. */
  readonly onDidChangeScope = this.scopeEmitter.event;
  private running = false;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly timeline: Timeline,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
    private readonly choices: CheckoutChoices = new Map<string, string>(),
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
    const nested = [...this.scopes.values()].some((s) => s.nestedDirs.length > 0);
    return profile + this.filter.describe() + (this.ignored.size > 0 ? ', not gitignored' : '') + (nested ? ', other worktrees skipped' : '');
  }

  /** The checkout a folder records while running, or undefined when stopped. */
  checkoutOf(folder: vscode.WorkspaceFolder): CheckoutInfo | undefined {
    const s = this.scopes.get(folder.uri.toString());
    return s && { own: s.own, name: s.name, root: s.root.fsPath, worktrees: s.worktrees };
  }

  /** The folder's repository worktrees and the remembered choice, or undefined outside git. */
  async checkoutsOf(folder: vscode.WorkspaceFolder): Promise<FolderCheckouts | undefined> {
    if (folder.uri.scheme !== 'file') return undefined;
    const r = await listWorktrees(folder.uri.fsPath);
    if (r.kind !== 'ok' || r.worktrees.length === 0) return undefined;
    return { worktrees: r.worktrees, own: ownCheckout(folder.uri.fsPath, r.worktrees), chosen: this.choices.get(folder.uri.toString()) };
  }

  /**
   * Records `worktreePath` for this folder from now on, or the folder's own
   * checkout when undefined. Applies at once while running; changes already in
   * the timeline are kept.
   */
  async setCheckout(folder: vscode.WorkspaceFolder, worktreePath: string | undefined): Promise<void> {
    await this.choices.set(folder.uri.toString(), worktreePath);
    if (!this.running) {
      this.scopeEmitter.fire();
      return;
    }
    this.reorder.drain();
    await this.refreshFilter('Checkout changed');
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

    await this.refreshScopes();
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
    for (const scope of this.scopes.values()) for (const d of scope.watcher) d.dispose();
    this.scopes.clear();
    for (const burst of this.timers.values()) {
      clearTimeout(burst.timer);
      burst.done();
    }
    this.timers.clear();
    clearTimeout(this.ignoreRefresh);
    clearTimeout(this.worktreeRefresh);
    for (const t of this.goneChecks.values()) clearTimeout(t);
    this.goneChecks.clear();
    this.ignored.clear();
    this.reorder.drain();
    this.snapshots.clear();
    this.gitBaselines.clear();
    this.ownSaves.clear();
    this.scopeEmitter.fire();
  }

  /**
   * Re-reads filter settings, worktrees, and gitignore rules. Newly matching
   * files get a baseline so their next change is recorded.
   */
  refreshFilter(reason = 'Filter changed'): Promise<void> {
    this.filter = this.buildFilter();
    if (!this.running) return Promise.resolve();
    const work = this.filterWork.then(async () => {
      if (!this.running) return;
      this.filter = this.buildFilter();
      await this.refreshScopes();
      await this.refreshIgnored();
      for (const store of [this.snapshots, this.gitBaselines]) {
        for (const key of [...store.keys()]) {
          if (!this.passes(vscode.Uri.parse(key))) store.delete(key);
        }
      }
      await this.captureBaseline();
      this.log.appendLine(`${reason}: watching ${this.watchedCount} files (${this.describeFilter()}).`);
    });
    this.filterWork = work.catch(() => {});
    return work;
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
  }

  /** Adds every held change to the timeline now, in write order. */
  drainHeld(): void {
    this.reorder.drain();
  }

  dispose(): void {
    this.stop();
    this.reorder.dispose();
    this.scopeEmitter.dispose();
  }

  /**
   * Works out which checkout each folder records and which worktrees sit
   * inside it, and points each folder's watcher at that checkout.
   */
  private refreshScopes(): Promise<void> {
    const work = this.scopeWork.then(async () => {
      const next = new Map<string, Scope>();
      for (const folder of vscode.workspace.workspaceFolders ?? []) next.set(folder.uri.toString(), await this.resolveScope(folder));
      if (!this.running) return;
      for (const [key, old] of this.scopes) {
        const fresh = next.get(key);
        if (fresh && fresh.root.toString() === old.root.toString()) fresh.watcher = old.watcher;
        else for (const d of old.watcher) d.dispose();
      }
      for (const [key, scope] of next) {
        const old = this.scopes.get(key);
        if (scope.watcher.length === 0) scope.watcher = this.watch(scope);
        if (!scope.own && old?.root.toString() !== scope.root.toString()) {
          this.log.appendLine(`Recording ${scope.folder.name} from checkout ${scope.name} (${scope.root.fsPath}).`);
        }
        if (scope.nestedDirs.join('\0') !== old?.nestedDirs.join('\0') && scope.nestedDirs.length > 0) {
          this.log.appendLine(`Skipping ${scope.nestedDirs.length} other worktree(s) in ${scope.folder.name}: ${scope.nestedDirs.join(', ')}`);
        }
      }
      this.scopes.clear();
      for (const [key, scope] of next) this.scopes.set(key, scope);
      this.scopeEmitter.fire();
    });
    this.scopeWork = work.catch(() => {});
    return work;
  }

  /** The checkout a folder records: its own, or the remembered choice while that is still a worktree of its repository. */
  private async resolveScope(folder: vscode.WorkspaceFolder): Promise<Scope> {
    const scope: Scope = {
      folder,
      root: folder.uri,
      checkout: folder.uri,
      own: true,
      label: '',
      name: '',
      nested: new IgnoredPaths(),
      nestedDirs: [],
      repo: false,
      worktrees: 0,
      watcher: [],
    };
    if (folder.uri.scheme !== 'file') return scope;
    const r = await listWorktrees(folder.uri.fsPath);
    if (r.kind !== 'ok') return scope;
    const own = ownCheckout(folder.uri.fsPath, r.worktrees);
    scope.repo = true;
    scope.worktrees = r.worktrees.length;
    if (own) {
      scope.checkout = vscode.Uri.file(own.path);
      scope.name = checkoutName(own);
    }

    const key = folder.uri.toString();
    const choice = this.choices.get(key);
    let chosen: Worktree | undefined;
    if (choice !== undefined) {
      chosen = r.worktrees.find((w) => pathKey(w.path) === pathKey(choice));
      const root = chosen && rootIn(chosen, own, folder.uri.fsPath);
      if (!chosen || !root || !(await stat(vscode.Uri.file(root)))) {
        this.log.appendLine(`The chosen checkout ${choice} is no longer a worktree of ${folder.name}; recording the folder's own checkout.`);
        await this.choices.set(key, undefined);
        chosen = undefined;
      } else if (own && pathKey(chosen.path) === pathKey(own.path)) {
        chosen = undefined;
      } else {
        scope.root = vscode.Uri.file(root);
        scope.checkout = vscode.Uri.file(chosen.path);
        scope.own = false;
        scope.label = worktreeLabels(r.worktrees).get(chosen.path) ?? checkoutName(chosen);
        scope.name = checkoutName(chosen);
      }
    }
    scope.nestedDirs = nestedUnder(scope.root.fsPath, r.worktrees);
    scope.nested = new IgnoredPaths(scope.nestedDirs);
    return scope;
  }

  /** A watcher for the scope's root. It outlives the Scope object while the root stays the same, so handlers look the scope up by folder. */
  private watch(scope: Scope): vscode.Disposable[] {
    const key = scope.folder.uri.toString();
    const pattern = scope.own ? new vscode.RelativePattern(scope.folder, '**/*') : new vscode.RelativePattern(scope.root, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const subs: vscode.Disposable[] = [watcher];
    watcher.onDidCreate(
      (uri) => {
        this.noteGitEntry(uri, true);
        this.schedule(uri, true);
      },
      null,
      subs,
    );
    watcher.onDidChange((uri) => this.schedule(uri, false), null, subs);
    watcher.onDidDelete(
      (uri) => {
        this.noteGitEntry(uri, false);
        const current = this.scopes.get(key);
        if (current && !current.own) this.checkCheckoutGone(current);
        this.schedule(uri, false);
      },
      null,
      subs,
    );
    return subs;
  }

  /**
   * Something was deleted in a chosen worktree. Watchers don't reliably report
   * a removed root or its `.git` file, so check whether the checkout itself is
   * gone, once the burst of deletes settles.
   */
  private checkCheckoutGone(scope: Scope): void {
    const key = scope.folder.uri.toString();
    clearTimeout(this.goneChecks.get(key));
    this.goneChecks.set(
      key,
      setTimeout(() => {
        this.goneChecks.delete(key);
        const checkout = this.scopes.get(key)?.checkout;
        if (!checkout) return;
        void stat(vscode.Uri.joinPath(checkout, '.git')).then((found) => {
          if (!found && this.running && this.scopes.get(key)?.checkout.toString() === checkout.toString()) this.scheduleWorktreeRefresh();
        });
      }, 300),
    );
  }

  /** The scope that records this path, if any. A chosen worktree inside a folder takes precedence over the folder. */
  private scopeOf(uri: vscode.Uri): Scope | undefined {
    for (const s of this.scopes.values()) if (!s.own && isUnder(s.root, uri)) return s;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const s = folder && this.scopes.get(folder.uri.toString());
    return s?.own ? s : undefined;
  }

  /** Path used for filtering and git: relative to the recorded checkout root. */
  private relOf(scope: Scope, uri: vscode.Uri): string {
    return scope.own ? relPathOf(uri) : uri.path.slice(scope.root.path.replace(/\/+$/, '').length + 1);
  }

  /** Path used for display and mirrors: a chosen worktree's label goes in front, so checkouts never share a mirror. */
  private displayOf(scope: Scope | undefined, uri: vscode.Uri): string {
    if (!scope || scope.own) return displayPathOf(uri);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return checkoutDisplayPath(multiRoot ? scope.folder.name : '', scope.label, this.relOf(scope, uri));
  }

  /**
   * A `.git` entry was created or deleted. Below the root, a created `.git`
   * file pointing into a repository's `worktrees/` is a new linked worktree:
   * its files are hidden right away and git confirms on refresh. Clones and
   * submodules (a `.git` directory, or a file pointing into `modules/`) are left
   * alone. A deleted nested worktree, or the chosen root's own `.git`, may be a
   * worktree going away.
   */
  private noteGitEntry(uri: vscode.Uri, created: boolean): void {
    if (!this.running || uri.scheme !== 'file' || !uri.path.endsWith('/.git')) return;
    const scope = this.scopeOf(uri);
    if (!scope?.repo) return;
    const rel = this.relOf(scope, uri);
    if (rel === '.git') {
      if (!scope.own) this.scheduleWorktreeRefresh();
      return;
    }
    const dir = rel.slice(0, -'.git'.length);
    if (created) {
      if (!isLinkedWorktreeGitFile(uri.fsPath)) return;
      scope.nested.add(dir);
      this.scheduleWorktreeRefresh();
    } else if (scope.nestedDirs.includes(dir)) {
      this.scheduleWorktreeRefresh();
    }
  }

  private scheduleWorktreeRefresh(): void {
    clearTimeout(this.worktreeRefresh);
    this.worktreeRefresh = setTimeout(() => {
      this.refreshFilter('Worktrees changed').catch((err) => this.log.appendLine(`Failed to re-read worktrees: ${String(err)}`));
    }, 300);
  }

  /** Files under a chosen checkout's root, skipping directories the filters, gitignore, or nested worktrees rule out. */
  private async walk(scope: Scope, stale: () => boolean): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    const ignored = this.ignored.get(scope.folder.uri.toString());
    const dirs: Array<[vscode.Uri, string]> = [[scope.root, '']];
    while (dirs.length > 0 && !stale()) {
      await Promise.all(
        dirs.splice(0, 64).map(async ([dir, rel]) => {
          let entries: [string, vscode.FileType][];
          try {
            entries = await vscode.workspace.fs.readDirectory(dir);
          } catch {
            return;
          }
          for (const [name, type] of entries) {
            const childRel = rel ? `${rel}/${name}` : name;
            if (type & vscode.FileType.Directory) {
              // Linked directories can loop; findFiles' default skips them the same way.
              if (type & vscode.FileType.SymbolicLink) continue;
              const asDir = childRel + '/';
              if (scope.nested.has(asDir) || ignored?.has(asDir) || this.filter.excludesDir(childRel)) continue;
              dirs.push([vscode.Uri.joinPath(dir, name), childRel]);
            } else if (type & vscode.FileType.File) {
              files.push(vscode.Uri.joinPath(dir, name));
            }
          }
        }),
      );
    }
    return files;
  }

  private async captureBaseline(): Promise<void> {
    // A file written after this point is a change still on its way through the
    // watcher; snapshotting it now would swallow that change.
    const startedAt = Date.now();
    const gen = ++this.baselineGen;
    const stale = () => gen !== this.baselineGen;
    const s = this.settings();
    const known = (key: string) => this.snapshots.has(key) || this.gitBaselines.has(key);
    const candidates: vscode.Uri[] = [];
    for (const scope of [...this.scopes.values()]) {
      const found = scope.own
        ? await vscode.workspace.findFiles(new vscode.RelativePattern(scope.folder, '**/*'), excludeGlob(s.exclude, scope.nestedDirs))
        : await this.walk(scope, stale);
      const clean = s.gitBaselines ? await this.cleanTracked(scope) : undefined;
      if (stale()) return;
      for (const uri of found) {
        const key = uri.toString();
        if (!this.passes(uri) || known(key)) continue;
        const sha = clean?.get(this.relOf(scope, uri));
        if (sha !== undefined) this.gitBaselines.set(key, { folder: scope.root.fsPath, path: this.relOf(scope, uri), sha });
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

  /**
   * Path filters within the recorded checkout, minus other worktrees inside it
   * and, while `respectGitignore` is on, the gitignored paths known so far.
   */
  private passes(uri: vscode.Uri): boolean {
    if (this.scopes.size === 0) return this.filter.matches(relPathOf(uri));
    const scope = this.scopeOf(uri);
    if (!scope) return false;
    const rel = this.relOf(scope, uri);
    if (!this.filter.matches(rel) || scope.nested.has(rel)) return false;
    return !this.ignored.get(scope.folder.uri.toString())?.has(rel);
  }

  /** Re-lists gitignored paths for each folder's recorded checkout, or clears them when the setting is off. */
  private async refreshIgnored(): Promise<void> {
    const next = new Map<string, IgnoredPaths>();
    if (this.settings().respectGitignore) {
      for (const scope of [...this.scopes.values()]) {
        const key = scope.folder.uri.toString();
        const r = scope.root.scheme === 'file' ? await listIgnored(scope.root.fsPath) : ({ kind: 'not-repo' } as const);
        if (r.kind === 'ok') next.set(key, r.ignored);
        else if (!this.ignoreNoted.has(key)) {
          this.ignoreNoted.add(key);
          const why = r.kind === 'unavailable' ? `git could not run (${r.reason})` : 'it is not in a git repository';
          this.log.appendLine(`respectGitignore has no effect for ${scope.folder.name}: ${why}.`);
        }
      }
    }
    this.ignored.clear();
    for (const [k, v] of next) this.ignored.set(k, v);
  }

  /** A file the ignore snapshot doesn't know yet: asks git once and remembers an ignored answer. */
  private async newlyIgnored(uri: vscode.Uri): Promise<boolean> {
    const scope = this.scopeOf(uri);
    const known = scope && this.ignored.get(scope.folder.uri.toString());
    if (!scope || !known) return false;
    const rel = this.relOf(scope, uri);
    if (!(await checkIgnored(scope.root.fsPath, rel))) return false;
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

  /** Root-relative path -> index sha for clean tracked files, or undefined when git can't help here. */
  private async cleanTracked(scope: Scope): Promise<Map<string, string> | undefined> {
    if (this.gitUnavailable || scope.root.scheme !== 'file') return undefined;
    const r = await listCleanTracked(scope.root.fsPath);
    if (r.kind === 'unavailable') {
      this.gitUnavailable = true;
      this.log.appendLine(`Git-backed baselines are off: git could not run (${r.reason}). Using in-memory baselines.`);
      return undefined;
    }
    if (r.kind === 'not-repo') {
      this.log.appendLine(`${scope.folder.name} is not in a git repository; using in-memory baselines for it.`);
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

  private schedule(uri: vscode.Uri, created: boolean): void {
    if (!this.running || uri.scheme !== 'file') return;
    if (this.ignored.size > 0 && uri.path.endsWith('/.gitignore')) this.scheduleIgnoreRefresh();
    if (!this.passes(uri)) return;
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
    // The checkout or its worktrees may have changed since the burst started.
    if (!this.running || !this.passes(uri)) return;
    const key = uri.toString();
    const scope = this.scopeOf(uri);
    const relPath = this.displayOf(scope, uri);
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
      // A chosen worktree being removed deletes all its files; that is the
      // checkout going away, not a change to replay.
      if (scope && !scope.own && !(await stat(vscode.Uri.joinPath(scope.checkout, '.git')))) {
        this.snapshots.delete(key);
        return;
      }
      if (previous !== undefined) {
        this.snapshots.delete(key);
        this.record(uri, relPath, 'delete', previous.text, '', previous.eol, burst.firstArrival);
      }
      return;
    }
    if (exists.type !== vscode.FileType.File) return;
    if (previous === undefined && (await this.newlyIgnored(uri))) return;
    const writtenAt = clampOrderKey(exists.mtime, burst.firstArrival, burst.lastArrival, s.reorderWindowMs);

    const snap = await this.readText(uri, s, exists.size);
    if (snap === undefined) {
      this.snapshots.delete(key);
      return;
    }

    // Each editor save is matched once, against the next change read for its file.
    const saved = this.ownSaves.get(key);
    this.ownSaves.delete(key);
    const decision = s.ignoreOwnSaves ? decideOwnSave(saved?.text, snap.text) : ({ kind: 'external' } as const);
    if (decision.kind === 'own') {
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

/** Where the checkout chosen for each folder is remembered, keyed by folder URI. */
export interface CheckoutChoices {
  get(folderKey: string): string | undefined;
  set(folderKey: string, worktreePath: string | undefined): unknown;
}

/** The checkout a folder records, for status and the chooser. */
export interface CheckoutInfo {
  /** True when it is the folder's own checkout. */
  own: boolean;
  /** Branch or short commit, '' outside git. */
  name: string;
  /** Directory recorded. */
  root: string;
  /** Worktrees the folder's repository has, 0 outside git. */
  worktrees: number;
}

export interface FolderCheckouts {
  worktrees: Worktree[];
  own: Worktree | undefined;
  /** Path of the remembered choice, undefined for the folder's own checkout. */
  chosen: string | undefined;
}

/** What one workspace folder records. */
interface Scope {
  folder: vscode.WorkspaceFolder;
  /** Directory recorded: the folder, or the same subpath in a chosen worktree. */
  root: vscode.Uri;
  /** Top of the checkout `root` is in. */
  checkout: vscode.Uri;
  own: boolean;
  /** Display-path prefix for a chosen worktree, '' for the folder's own checkout. */
  label: string;
  /** Branch or short commit of the recorded checkout, '' outside git. */
  name: string;
  /** Other worktrees inside `root`; may hold a provisional entry until git confirms it. */
  nested: IgnoredPaths;
  /** Other worktrees inside `root` as git listed them, root-relative `dir/` prefixes. */
  nestedDirs: string[];
  /** git listed worktrees for this folder. */
  repo: boolean;
  worktrees: number;
  watcher: vscode.Disposable[];
}

/** Where a clean tracked file's baseline lives in git. */
interface GitBaselineRef {
  /** Directory git runs in: the recorded checkout root. */
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

/** True for a `.git` file of the form a linked worktree has: `gitdir: <repo>/worktrees/<name>`. */
function isLinkedWorktreeGitFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    return pointsAtLinkedWorktree(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** True when `uri` is strictly inside `root`. Case is ignored on Windows. */
function isUnder(root: vscode.Uri, uri: vscode.Uri): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(uri.path).startsWith(fold(root.path.replace(/\/+$/, '')) + '/');
}

/** findFiles exclude: the exclude setting plus nested worktrees. Worktree paths with glob characters are left to `passes`. */
function excludeGlob(exclude: string[], nestedDirs: string[]): string | undefined {
  const globs = [...exclude, ...nestedDirs.filter((d) => !/[*?[\]{}!,]/.test(d)).map((d) => `${d}**`)];
  return globs.length > 0 ? `{${globs.join(',')}}` : undefined;
}
