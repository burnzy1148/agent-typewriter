import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PathFilter, RootGlobs, toSlashes } from './filter';
import { countChanges, detectEol, normalizeEol, type Eol } from './planner';
import { CAPTURE_SKEW_MS, fillBudget, listCleanTracked, readBlob, writtenDuringCapture, type BudgetCandidate } from './gitBaseline';
import { checkIgnored, IgnoredPaths, listIgnored } from './gitIgnore';
import { decodeBytes, isAscii, isBinaryText, looksBinary } from './textDecode';
import {
  carriedProvisional,
  checkoutDisplayPath,
  checkoutName,
  commonDirOf,
  folderCheckoutChoice,
  folderLabels,
  initializing,
  innermostRoot,
  isWorktreeOf,
  laneKey,
  listWorktrees,
  liveWorktrees,
  nestedUnder,
  ownCheckout,
  pathKey,
  relativeInside,
  rootIn,
  worktreeLabels,
  type ProvisionalDir,
  type Worktree,
  type WorktreeListResult,
} from './worktrees';
import { activeProfileOf } from './profiles';
import { decideOwnSave } from './ownSave';
import { KeyedSerial } from './keyedSerial';
import { ReorderBuffer, clampOrderKey, type OrderHold } from './reorder';
import { pickRenamePartner } from './renames';
import type { ChangeKind, NewChangeEvent, Timeline } from './timeline';
import { colorSlot, laneLabel, MAX_LANES, ROTATE_IDLE_MS, rotationVictim } from './lanes';
import type { Settings } from './config';

/** Where display prefixes of workspace folders are remembered among labels; folder keys are URIs, so never this. */
const FOLDER_PREFIXES = 'folders';

/** How long a change read mid-save waits for the save to finish. */
const SAVE_SETTLE_MAX_MS = 1000;

/** How long it waits instead for a save that started over SAVE_SETTLE_MAX_MS before the change. */
const OLD_SAVE_GRACE_MS = 250;

/** How long after git failed to list a folder's ignored paths the listing is tried again. */
const IGNORE_RETRY_MS = 2000;

/**
 * A rebuild keeps a file's current baseline when the file was written this
 * long before the rebuild started: its change may still be on its way through
 * the watcher, and the current baseline is what that change starts from.
 */
const REBUILD_RECENT_MS = 10_000;

/**
 * A create event this soon after a baseline capture read the same write of
 * the file is that capture having read a new file: it is recorded from empty.
 */
const SWALLOWED_CREATE_MS = 10_000;

/** At most this many files left out for the budget are opened to tell text from binary for the log. */
const PROBE_LIMIT = 1000;

/** How many recent watcher events and read outcomes the recorder keeps for diagnostics. */
const ACTIVITY_LIMIT = 200;

/** First wait before listing worktrees again after git could not run, doubling up to WORKTREE_RETRY_MAX_MS. */
const WORKTREE_RETRY_MS = 1000;
const WORKTREE_RETRY_MAX_MS = 30_000;

/**
 * How long deletes in a chosen worktree must stay quiet before one is
 * recorded. Removing a worktree deletes its files in directory order, so its
 * `.git` may go seconds after the first files; a pause while a large ignored
 * directory goes reports no events.
 */
const DELETE_SETTLE_MS = 3000;

/** Longest a delete is held, however long deletes keep coming (a build cleaning its output, say). */
const DELETE_HOLD_MAX_MS = 15_000;

/**
 * Longest a held delete keeps later changes from reaching the timeline: its
 * hold, plus time for the decision's own read.
 */
const DELETE_ORDER_HOLD_MAX_MS = DELETE_HOLD_MAX_MS + DELETE_SETTLE_MS;

/** How soon worktrees are listed again while `git worktree add` is still checking one out, and how many times. */
const INIT_RETRY_MS = 1000;
const INIT_RETRIES = 60;

/** Longest wait between checks of whether a chosen worktree is gone. */
const GONE_CHECK_MAX_MS = 5000;

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
  /** Bumped by each stop; a burst or flush from an earlier recording session writes nothing. */
  private session = 0;
  private readonly timers = new Map<string, Burst>();
  /** Reads of one file run one at a time, so each starts from the snapshot the one before it stored. */
  private readonly flushes = new KeyedSerial();
  /** Paths deleted this tick whose baselined files are looked up together. */
  private readonly deletedDirs = new Set<string>();
  private deleteSweep: NodeJS.Immediate | undefined;
  /** Holds recorded changes briefly so they reach the timeline in write order. */
  private readonly reorder: ReorderBuffer<NewChangeEvent>;
  /** Text the latest editor save wrote, per file, until the next change of that file is read. */
  private readonly ownSaves = new Map<string, OwnSave>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private filter: PathFilter;
  /** Name of the active filter profile the current filter came from, or ''. */
  private profileName = '';
  /** Gitignored paths per recorded checkout (keyed by scope key) while `respectGitignore` is on and git can tell. */
  private readonly ignored = new Map<string, IgnoredPaths>();
  /** Folders already logged as having no gitignore rules this session. */
  private readonly ignoreNoted = new Set<string>();
  private ignoreRefresh: NodeJS.Timeout | undefined;
  /** The last gitignore listing failed for some folder and a retry was scheduled for it. */
  private ignoreRetried = false;
  /** The checkouts recorded while running, one per lane, keyed by `Scope.key`. */
  private readonly scopes = new Map<string, Scope>();
  /** Checkouts chosen per folder URI, when `choices` cannot keep sets. */
  private readonly sets = new Map<string, string[]>();
  /** Lane color slot per checkout `pathKey`, when `choices` cannot keep them. */
  private readonly colors = new Map<string, number>();
  /** The checkouts last logged as left out for the lane cap. */
  private capNoted = '';
  /** Set by start until the first scope refresh has picked the lane to follow. */
  private followPending = false;
  /** Per folder URI, the worktrees its repository had at the last listing. */
  private readonly listings = new Map<string, Worktree[]>();
  /** Per folder URI, `pathKey`s of the worktrees auto-record has already seen since start. */
  private readonly knownWorktrees = new Map<string, Set<string>>();
  /** Per worktree `pathKey`, how many listings found it still being created by `git worktree add`. */
  private readonly initWaits = new Map<string, number>();
  /** While auto-record is on, a watcher per recorded repository's common git directory, by its key. */
  private readonly commonWatchers = new Map<string, vscode.Disposable[]>();
  /** Chosen worktree labels per folder URI, by worktree `pathKey`, and folder prefixes, when `choices` cannot keep them. */
  private readonly labels = new Map<string, Map<string, string>>();
  /** Remembered worktree labels checked this session against the folder's top-level entries, as `folder\0worktree` keys. */
  private readonly labelsChecked = new Set<string>();
  /** Scope refreshes run one at a time, so watchers are never replaced twice at once. */
  private scopeWork: Promise<void> = Promise.resolve();
  private worktreeRefresh: NodeJS.Timeout | undefined;
  /** Pending "is the chosen checkout gone?" checks, per scope key, with when each is due. */
  private readonly goneChecks = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  /** Per scope key, the chosen checkout and what of it was missing when a check last asked for a refresh. */
  private readonly goneRefreshed = new Map<string, string>();
  /** Per scope key, directories hidden as new worktrees until a listing started after them settles them. */
  private readonly provisional = new Map<string, Array<ProvisionalDir & { root: string }>>();
  /** Numbers provisional directories and worktree listings, so a listing knows which directories it may have missed. */
  private provisionalSeq = 0;
  /** Folders (by URI) whose worktrees git could not list last time; they are listed again with backoff. */
  private readonly listFailing = new Set<string>();
  private listRetry: NodeJS.Timeout | undefined;
  private listRetries = 0;
  /** Deletes in chosen worktrees, per file URI, held until it is clear the checkout itself is not being removed. */
  private readonly heldDeletes = new Map<string, HeldDelete>();
  /** Per scope key, the timer that decides its held deletes once deletes there have been quiet for DELETE_SETTLE_MS. */
  private readonly deleteSettles = new Map<string, { timer: NodeJS.Timeout; since: number }>();
  /** Filter refreshes run one at a time, so an older one never overwrites a newer one's gitignore rules. */
  private filterWork: Promise<void> = Promise.resolve();
  private readonly scopeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the checkout a folder records, or its worktree list, may have changed. */
  readonly onDidChangeScope = this.scopeEmitter.event;
  private running = false;
  /** Set by refreshBaselines until a capture has rebuilt every baseline; a capture started meanwhile does the rebuild. */
  private rebuildPending = false;
  /** Per folder URI, what `files.watcherExclude` hides from the folder's watchers, so it is never recorded. */
  private watcherExcludes = new Map<string, WatcherExcludes>();
  /** The watcherExclude patterns last logged as skipping recording. */
  private watcherExcludeNoted = '';
  /** Recent watcher events and what reading each one did, oldest first. */
  private readonly activity: string[] = [];

  constructor(
    private readonly timeline: Timeline,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
    private readonly choices: CheckoutChoices = new Map<string, string>(),
    /** How a folder's worktrees are listed; tests replace it to make git fail. */
    private readonly listWorktreesIn: (folder: string) => Promise<WorktreeListResult> = (folder) => listWorktrees(folder),
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
    const unchosen = [...this.scopes.values()].filter((s) => s.container && s.own).map((s) => s.folder.name);
    return (
      profile +
      this.filter.describe() +
      (this.ignored.size > 0 ? ', not gitignored' : '') +
      (nested ? ', other worktrees skipped' : '') +
      (unchosen.length > 0 ? `, no checkout chosen in ${unchosen.join(', ')}` : '')
    );
  }

  /**
   * The checkout a folder records while running, or undefined when stopped:
   * the followed lane's when it is the folder's, else its own, else the first.
   */
  checkoutOf(folder: vscode.WorkspaceFolder): CheckoutInfo | undefined {
    const mine = this.scopesOf(folder.uri.toString());
    const s = mine.find((m) => m.key === this.timeline.followed) ?? mine.find((m) => m.own) ?? mine[0];
    return s && { own: s.own, name: s.name, root: s.root.fsPath, worktrees: s.worktrees, container: s.container, lanes: mine.length, lane: s.key };
  }

  /** Every lane recording while running, in folder order. */
  recordedLanes(): Array<{ lane: string; folder: vscode.WorkspaceFolder; checkout: string; own: boolean; name: string; label: string }> {
    return [...this.scopes.values()].map((s) => ({
      lane: s.key,
      folder: s.folder,
      checkout: s.checkout.fsPath,
      own: s.own,
      name: s.name,
      label: this.timeline.laneInfo(s.key)?.label ?? s.name,
    }));
  }

  /** The folder's repository worktrees and the remembered choice, or undefined outside git. */
  async checkoutsOf(folder: vscode.WorkspaceFolder): Promise<FolderCheckouts | undefined> {
    if (folder.uri.scheme !== 'file') return undefined;
    const r = await this.listWorktreesIn(folder.uri.fsPath);
    // A worktree being removed is still listed, but is no checkout to pick.
    const worktrees = r.kind === 'ok' ? liveWorktrees(r.worktrees) : [];
    if (worktrees.length === 0) return undefined;
    const key = folder.uri.toString();
    const own = ownCheckout(folder.uri.fsPath, worktrees);
    return { worktrees, own, chosen: this.choices.get(key), recorded: this.chosenSet(key) ?? this.defaultPaths(folder, own?.path ?? folder.uri.fsPath) };
  }

  /**
   * Records only `worktreePath` for this folder from now on, or only the
   * folder's own checkout when undefined. Applies at once while running;
   * changes already in the timeline are kept.
   */
  async setCheckout(folder: vscode.WorkspaceFolder, worktreePath: string | undefined): Promise<void> {
    const key = folder.uri.toString();
    this.sets.delete(key);
    const unsaved = this.choices.setSet ? await this.saveChoiceSet(key, undefined) : undefined;
    await this.applyChoice(folder, unsaved ?? (await this.saveChoice(key, worktreePath)));
  }

  /**
   * Records exactly these checkouts of the folder from now on (worktree
   * paths, the folder's own checkout by its path). Refuses none, and more
   * than MAX_LANES across every folder. Applies at once while running;
   * changes already in the timeline are kept.
   */
  async setCheckouts(folder: vscode.WorkspaceFolder, paths: readonly string[]): Promise<void> {
    const unique = [...new Map(paths.map((p) => [pathKey(p), p])).values()];
    if (unique.length === 0) throw new Error('At least one checkout must record.');
    const key = folder.uri.toString();
    const total = unique.length + this.recordedCountExcept(key);
    if (total > MAX_LANES) throw new Error(`At most ${MAX_LANES} checkouts record at once.`);
    await this.applyChoice(folder, await this.saveChoiceSet(key, unique));
  }

  /** Adds a checkout to those the folder records. */
  async addCheckout(folder: vscode.WorkspaceFolder, checkoutPath: string): Promise<void> {
    const current = await this.recordedPaths(folder);
    if (current.some((p) => pathKey(p) === pathKey(checkoutPath))) return;
    await this.setCheckouts(folder, [...current, checkoutPath]);
  }

  /** Stops recording a checkout of the folder; its lane keeps its changes. Refuses the last one. */
  async removeCheckout(folder: vscode.WorkspaceFolder, checkoutPath: string): Promise<void> {
    const current = await this.recordedPaths(folder);
    const rest = current.filter((p) => pathKey(p) !== pathKey(checkoutPath));
    if (rest.length === current.length) return;
    await this.setCheckouts(folder, rest);
  }

  /** The checkouts the folder records, or would record when started: chosen ones, or its own unless the lane cap leaves it out. */
  private async recordedPaths(folder: vscode.WorkspaceFolder): Promise<string[]> {
    if (this.running) return this.scopesOf(folder.uri.toString()).map((s) => s.checkout.fsPath);
    return (await this.checkoutsOf(folder))?.recorded ?? this.chosenSet(folder.uri.toString()) ?? this.defaultPaths(folder, folder.uri.fsPath);
  }

  /** What a folder outside git records once started: itself, unless the lane cap leaves it out. */
  defaultRecorded(folder: vscode.WorkspaceFolder): string[] {
    return this.chosenSet(folder.uri.toString()) ?? this.defaultPaths(folder, folder.uri.fsPath);
  }

  /** What a folder with nothing chosen records: its own checkout, when it is one of the first MAX_LANES folders. */
  private defaultPaths(folder: vscode.WorkspaceFolder, ownPath: string): string[] {
    const i = (vscode.workspace.workspaceFolders ?? []).findIndex((f) => f.uri.toString() === folder.uri.toString());
    return i >= 0 && i < MAX_LANES ? [ownPath] : [];
  }

  /**
   * How many checkouts every other folder records, or would record when
   * started: its chosen ones, or its own when it is one of the first
   * MAX_LANES folders (the rest record nothing by default).
   */
  private recordedCountExcept(folderKey: string): number {
    let n = 0;
    (vscode.workspace.workspaceFolders ?? []).forEach((f, i) => {
      const key = f.uri.toString();
      if (key === folderKey) return;
      n += this.running ? this.scopesOf(key).length : (this.chosenSet(key)?.length ?? (i < MAX_LANES ? 1 : 0));
    });
    return n;
  }

  private async applyChoice(folder: vscode.WorkspaceFolder, unsaved: Error | undefined): Promise<void> {
    if (!this.running) {
      this.scopeEmitter.fire();
    } else {
      this.reorder.drain();
      await this.refreshFilter('Checkout changed');
    }
    if (unsaved) throw new Error(`The checkout chosen for ${folder.name} applies until the window closes, but could not be saved: ${unsaved.message}`);
  }

  /** Every checkout chosen for a folder, or undefined when nothing was chosen. */
  private chosenSet(folderKey: string): string[] | undefined {
    if (this.choices.getSet) return this.choices.getSet(folderKey);
    const set = this.sets.get(folderKey);
    if (set) return [...set];
    const single = this.choices.get(folderKey);
    return single === undefined ? undefined : [single];
  }

  /** The scopes recording checkouts of one folder. */
  private scopesOf(folderKey: string): Scope[] {
    return [...this.scopes.values()].filter((s) => s.folder.uri.toString() === folderKey);
  }

  /** Remembers a folder's checkout choice; returns why saving it failed, if it did, instead of throwing. */
  private async saveChoice(folderKey: string, worktreePath: string | undefined): Promise<Error | undefined> {
    try {
      const r = await this.choices.set(folderKey, worktreePath);
      return r instanceof Error ? r : undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Remembers every checkout chosen for a folder, or none; returns why saving failed, if it did. */
  private async saveChoiceSet(folderKey: string, paths: readonly string[] | undefined): Promise<Error | undefined> {
    if (!this.choices.setSet) {
      if (paths === undefined) {
        this.sets.delete(folderKey);
        return this.saveChoice(folderKey, undefined);
      }
      this.sets.set(folderKey, [...paths]);
      return undefined;
    }
    try {
      const r = await this.choices.setSet(folderKey, paths);
      return r instanceof Error ? r : undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private buildFilter(): PathFilter {
    const s = this.settings();
    this.profileName = activeProfileOf(s) ? s.activeProfile : '';
    this.watcherExcludes = this.readWatcherExcludes();
    return new PathFilter(s);
  }

  /**
   * `files.watcherExclude` per folder. VS Code applies it to the recorder's
   * watchers, so a file it hides never reports a change: such files get no
   * baseline and are not counted. Patterns set beyond VS Code's defaults are
   * logged once while recording.
   */
  private readWatcherExcludes(): Map<string, WatcherExcludes> {
    const out = new Map<string, WatcherExcludes>();
    const userSet = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const cfg = vscode.workspace.getConfiguration('files', folder.uri);
      const on = (value: unknown) =>
        value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).filter(([, v]) => v === true).map(([g]) => g) : [];
      // VS Code resolves a relative pattern against the workspace folder, so
      // only one that starts with ** also applies to a checkout outside it.
      const globs = on(cfg.get('watcherExclude'))
        .map((g) => (path.isAbsolute(g) ? path.relative(folder.uri.fsPath, g).split(path.sep).join('/') : g))
        .filter((g) => g && !g.startsWith('..'));
      const own = new RootGlobs(globs);
      if (own.size > 0) out.set(folder.uri.toString(), { own, anywhere: new RootGlobs(globs.filter((g) => g.startsWith('**'))) });
      const set = cfg.inspect('watcherExclude');
      for (const value of [set?.globalValue, set?.workspaceValue, set?.workspaceFolderValue]) for (const g of on(value)) userSet.add(g);
    }
    const noted = [...userSet].sort().join(', ');
    if (this.running && noted && noted !== this.watcherExcludeNoted) {
      this.log.appendLine(`files.watcherExclude hides ${noted} from the file watcher, so changes there are not recorded.`);
    }
    if (this.running) this.watcherExcludeNoted = noted;
    return out;
  }

  /** True when `files.watcherExclude` hides this root-relative path, or a directory above it, from the scope's watcher. */
  private watcherHides(scope: Scope, rel: string): boolean {
    const hidden = this.watcherExcludes.get(scope.folder.uri.toString());
    return !!hidden && (scope.own ? hidden.own : hidden.anywhere).covers(rel);
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
      `debouncing: ${debouncing.length > 0 ? debouncing.join(', ') : 'none'}; reading: ${this.flushes.size}; held for reordering: ${this.reorder.size}; deletes held: ${this.heldDeletes.size}`,
    ].join('\n');
  }

  /** The mirror path of a file in its folder's own checkout, as recorded changes name it. */
  mirrorPathOf(uri: vscode.Uri): string {
    return this.displayPathOf(uri);
  }

  /** The path `flush` would show for this file, so watcher and outcome lines match. */
  private traceName(uri: vscode.Uri): string {
    return this.displayOf(this.scopeOf(uri), uri);
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
    // stop() bumps the session: a start it overtook ends at its next await.
    const session = this.session;
    const stale = () => !this.running || session !== this.session;
    this.filter = this.buildFilter();
    this.ownSaves.clear();

    // Listeners are registered before the first await, so a stop() during the
    // start always finds them to dispose of.
    // Remember what each editor save writes. Will-save covers a watcher that
    // reports the write before did-save fires; did-save adds edits that save
    // participants (format on save) make during the save.
    vscode.workspace.onWillSaveTextDocument(
      (e) => {
        if (e.document.uri.scheme !== 'file') return;
        const text = e.document.getText();
        const keys = this.ownSaveKeys(e.document.uri, text);
        for (const key of keys.drop) this.forgetOwnSave(key);
        let resolve!: () => void;
        const settled = new Promise<void>((r) => (resolve = r));
        const entry: OwnSave = { text, settled, resolve, done: false, startedAt: Date.now() };
        for (const key of keys.keep) {
          // A save started again before the last one finished: wake anything waiting on the old one.
          this.ownSaves.get(key)?.resolve();
          this.ownSaves.set(key, entry);
        }
      },
      null,
      this.subscriptions,
    );
    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        if (doc.uri.scheme !== 'file') return;
        const text = doc.getText();
        const keys = this.ownSaveKeys(doc.uri, text);
        for (const key of keys.drop) this.forgetOwnSave(key);
        // The will-save entry is completed in place, so a flush waiting on it wakes up.
        const entry = keys.keep.map((k) => this.ownSaves.get(k)).find((e) => e && !e.done) ?? {
          text,
          settled: Promise.resolve(),
          resolve: () => {},
          done: true,
          startedAt: Date.now(),
        };
        entry.text = text;
        entry.done = true;
        entry.resolve();
        for (const key of keys.keep) this.ownSaves.set(key, entry);
      },
      null,
      this.subscriptions,
    );
    // Folders added or removed while recording get, or lose, their scope, watcher and baselines.
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        this.refreshFilter('Workspace folders changed').catch((err) => this.log.appendLine(`Failed to apply workspace folder changes: ${String(err)}`));
      },
      null,
      this.subscriptions,
    );
    // VS Code applies files.watcherExclude to the watchers; follow it while recording.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (!e.affectsConfiguration('files.watcherExclude')) return;
        this.rewatch();
        this.refreshFilter('files.watcherExclude changed').catch((err) => this.log.appendLine(`Failed to apply files.watcherExclude: ${String(err)}`));
      },
      null,
      this.subscriptions,
    );

    this.gitUnavailable = false;
    this.ignoreNoted.clear();
    this.ignoreRetried = false;
    this.followPending = true;
    try {
      await this.refreshScopes();
      if (stale()) return;
      await this.refreshIgnored();
      if (stale()) return;
      await this.captureBaseline();
      if (stale()) return;
    } catch (err) {
      // A failed start leaves nothing running, so starting again starts over.
      if (!stale()) this.stop();
      throw err;
    }
    this.log.appendLine(`Watching ${this.watchedCount} files (${this.filter.describe()}).`);
  }

  stop(): void {
    this.running = false;
    this.rebuildPending = false;
    this.watcherExcludeNoted = '';
    this.baselineGen++;
    this.session++;
    for (const d of this.subscriptions.splice(0)) d.dispose();
    for (const scope of this.scopes.values()) for (const d of scope.watcher) d.dispose();
    const lanes = [...this.scopes.keys()];
    this.scopes.clear();
    this.capNoted = '';
    this.listings.clear();
    this.knownWorktrees.clear();
    this.initWaits.clear();
    for (const subs of this.commonWatchers.values()) for (const d of subs) d.dispose();
    this.commonWatchers.clear();
    for (const burst of this.timers.values()) {
      clearTimeout(burst.timer);
      burst.done();
    }
    this.timers.clear();
    // Flushes still running see the new session and write nothing.
    this.flushes.clear();
    if (this.deleteSweep) clearImmediate(this.deleteSweep);
    this.deleteSweep = undefined;
    this.deletedDirs.clear();
    clearTimeout(this.ignoreRefresh);
    clearTimeout(this.worktreeRefresh);
    for (const t of this.goneChecks.values()) clearTimeout(t.timer);
    this.goneChecks.clear();
    this.goneRefreshed.clear();
    this.provisional.clear();
    clearTimeout(this.listRetry);
    this.listRetry = undefined;
    this.listRetries = 0;
    this.listFailing.clear();
    for (const t of this.deleteSettles.values()) clearTimeout(t.timer);
    this.deleteSettles.clear();
    this.dropHeldDeletes();
    this.ignored.clear();
    this.reorder.drain();
    // After the drain: a lane whose first changes were still held keeps its label and color.
    for (const lane of lanes) this.timeline.setLaneRecording(lane, false);
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
      for (const store of [this.snapshots, this.gitBaselines, this.ownSaves]) {
        for (const key of [...store.keys()]) {
          if (!this.passes(vscode.Uri.parse(key))) store.delete(key);
        }
      }
      await this.captureBaseline();
      this.log.appendLine(`${reason}: watching ${this.watchedCount} files (${this.describeFilter()}).`);
      this.note(`${reason.toLowerCase()}: watching ${this.watchedCount} files`);
    });
    this.filterWork = work.catch(() => {});
    return work;
  }

  /**
   * Rebuilds baselines after `gitBaselines`, `baselineBudgetMB` or
   * `maxFileSizeKB` changes. Every stored baseline equals the file's current
   * disk text (the recorder updates it on each change), so baselines can be
   * re-taken from disk and git. The current ones stay in use until the new
   * set is complete, and a file that changes meanwhile keeps its own.
   */
  async refreshBaselines(): Promise<void> {
    if (!this.running) return;
    this.gitUnavailable = false;
    this.rebuildPending = true;
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
    this.scopeEmitter.dispose();
  }

  /**
   * Works out which checkout each folder records and which worktrees sit
   * inside it, and points each folder's watcher at that checkout.
   */
  private refreshScopes(): Promise<void> {
    const work = this.scopeWork.then(async () => {
      // A refresh that a stop overtook writes nothing, even when recording started again meanwhile.
      const session = this.session;
      const stale = () => !this.running || session !== this.session;
      const folders = vscode.workspace.workspaceFolders ?? [];
      let all: Scope[] = [];
      for (const folder of folders) all.push(...(await this.resolveScopes(folder)));
      if (stale()) return;
      if (await this.autoRecord(all)) {
        all = [];
        for (const folder of folders) all.push(...(await this.resolveScopes(folder)));
        if (stale()) return;
      }
      // Only by default can more than MAX_LANES come up: one per folder in a large multi-root workspace.
      const left = all.slice(MAX_LANES).map((s) => (s.own ? s.folder.name : `${s.folder.name} (${s.name})`));
      if (left.join('\0') !== this.capNoted && left.length > 0) {
        this.log.appendLine(`At most ${MAX_LANES} checkouts record at once; not recording ${left.join(', ')}.`);
      }
      this.capNoted = left.join('\0');
      const next = new Map(all.slice(0, MAX_LANES).map((s) => [s.key, s]));
      for (const [key, old] of this.scopes) {
        const fresh = next.get(key);
        if (fresh && fresh.root.toString() === old.root.toString()) fresh.watcher = old.watcher;
        else {
          for (const d of old.watcher) d.dispose();
          this.dropHeldDeletes(key);
        }
      }
      for (const key of this.provisional.keys()) if (!next.has(key)) this.provisional.delete(key);
      for (const key of this.goneRefreshed.keys()) if (!next.has(key)) this.goneRefreshed.delete(key);
      for (const [key, scope] of next) {
        const old = this.scopes.get(key);
        this.carryProvisional(key, scope);
        if (scope.watcher.length === 0) scope.watcher = this.watch(scope);
        if (!scope.own && old?.root.toString() !== scope.root.toString()) {
          this.log.appendLine(`Recording ${scope.folder.name} from checkout ${scope.name} (${scope.root.fsPath}).`);
        }
        if (scope.container && scope.own && !(old?.container && old.own)) {
          this.log.appendLine(
            `${scope.folder.name} has no checkout of its own, so its worktrees are skipped; run Agent Typewriter: Choose Checkout to record one.`,
          );
        }
        if (scope.nestedDirs.join('\0') !== old?.nestedDirs.join('\0') && scope.nestedDirs.length > 0) {
          this.log.appendLine(`Skipping ${scope.nestedDirs.length} other worktree(s) in ${scope.folder.name}: ${scope.nestedDirs.join(', ')}`);
        }
      }
      const gone = [...this.scopes.keys()].filter((key) => !next.has(key));
      this.scopes.clear();
      for (const [key, scope] of next) this.scopes.set(key, scope);
      for (const lane of gone) this.timeline.setLaneRecording(lane, false);
      for (const scope of next.values()) this.defineLane(scope);
      this.followFirstLane();
      this.watchCommonDirs();
      // A chosen worktree git calls prunable is being removed: fall back once its root is gone.
      // Any other is checked now and then too, in case its watcher says nothing as it goes.
      for (const scope of next.values()) if (!scope.own) this.checkCheckoutGone(scope, scope.prunable ? undefined : GONE_CHECK_MAX_MS, true);
      this.scheduleWorktreeRetry();
      this.scopeEmitter.fire();
    });
    this.scopeWork = work.catch(() => {});
    return work;
  }

  /**
   * Keeps hiding, in a scope built from a fresh worktree listing, the new
   * worktrees noticed after that listing started: git may have listed before
   * they existed. Ones noticed earlier are settled by the listing.
   */
  private carryProvisional(key: string, scope: Scope): void {
    const root = scope.root.toString();
    const kept = carriedProvisional((this.provisional.get(key) ?? []).filter((e) => e.root === root), scope.listedAt, scope.nestedDirs);
    for (const e of kept) if (!scope.nested.has(e.dir)) scope.nested.add(e.dir);
    if (kept.length > 0) this.provisional.set(key, kept);
    else this.provisional.delete(key);
  }

  /** While git could not list some folder's worktrees, lists them again later, waiting longer each time. */
  private scheduleWorktreeRetry(): void {
    if (this.listFailing.size === 0) {
      clearTimeout(this.listRetry);
      this.listRetry = undefined;
      this.listRetries = 0;
      return;
    }
    if (this.listRetry || !this.running) return;
    const delay = Math.min(WORKTREE_RETRY_MS * 2 ** this.listRetries, WORKTREE_RETRY_MAX_MS);
    this.listRetries++;
    const session = this.session;
    this.listRetry = setTimeout(() => {
      void this.retryWorktreeList(session).catch((err) => this.log.appendLine(`Failed to re-read worktrees: ${String(err)}`));
    }, delay);
  }

  /** Lists the failing folders' worktrees; once git answers for one, refreshes the scopes. */
  private async retryWorktreeList(session: number): Promise<void> {
    const failing = (vscode.workspace.workspaceFolders ?? []).filter((f) => this.listFailing.has(f.uri.toString()));
    let answered = false;
    for (const folder of failing) if ((await this.listWorktreesIn(folder.uri.fsPath)).kind !== 'unavailable') answered = true;
    if (!this.running || session !== this.session) return;
    this.listRetry = undefined;
    if (failing.length === 0) this.listFailing.clear();
    if (answered) await this.refreshFilter('Worktrees re-read');
    else this.scheduleWorktreeRetry();
  }

  /**
   * The checkouts a folder records: its own, or the remembered choice, less
   * any chosen worktree that is no longer one of its repository. When none is
   * left, its own.
   */
  private async resolveScopes(folder: vscode.WorkspaceFolder): Promise<Scope[]> {
    const key = folder.uri.toString();
    const scope: Scope = {
      key,
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
      container: false,
      prunable: false,
      commonKey: undefined,
      commonDir: undefined,
      listedAt: this.provisionalSeq,
      watcher: [],
    };
    if (folder.uri.scheme !== 'file') return [scope];
    const session = this.session;
    const r = await this.listWorktreesIn(folder.uri.fsPath);
    // Stopped meanwhile: this scope is never used.
    if (session !== this.session) return [scope];
    if (r.kind === 'unavailable') {
      // Git could not run this time. A folder git has listed keeps what it
      // records, and one with a chosen checkout waits to apply it; both are
      // listed again later. Otherwise the folder is recorded as outside git.
      const noted = this.listFailing.has(key);
      const current = this.scopesOf(key);
      const choice = this.chosenSet(key);
      if (current.some((c) => c.repo)) {
        this.listFailing.add(key);
        if (!noted) this.log.appendLine(`Could not re-read the worktrees of ${folder.name} (${r.reason}); keeping its current checkout until git answers.`);
        const have = current.map((c) => pathKey(c.checkout.fsPath)).sort().join('\0');
        const want = choice?.map(pathKey).sort().join('\0');
        if (want === undefined ? current.some((c) => !c.own) : want !== have) {
          this.log.appendLine(`The checkout chosen for ${folder.name} applies once git can list its worktrees.`);
        }
        return current.map((c) => ({ ...c, folder }));
      }
      if (choice !== undefined) {
        this.listFailing.add(key);
        if (!noted) this.log.appendLine(`Could not read the worktrees of ${folder.name} (${r.reason}); recording the folder itself until git answers, then ${choice.join(', ')}.`);
      }
      return [scope];
    }
    this.listFailing.delete(key);
    if (r.kind !== 'ok') {
      this.listings.delete(key);
      return [scope];
    }
    this.listings.set(key, r.worktrees);
    const own = ownCheckout(folder.uri.fsPath, r.worktrees);
    const live = liveWorktrees(r.worktrees);
    scope.repo = true;
    scope.worktrees = live.length;
    // A folder holding a bare repository's worktrees has no checkout of its own.
    scope.container = !own && live.length > 0;
    scope.name = folderCheckoutChoice(folder.name, own, live).name;
    if (own) scope.checkout = vscode.Uri.file(own.path);

    const ownKey = pathKey(own?.path ?? folder.uri.fsPath);
    const choice = this.chosenSet(key);
    const scopes: Scope[] = [];
    const kept: string[] = [];
    const gone: string[] = [];
    for (const wanted of choice ?? [own?.path ?? folder.uri.fsPath]) {
      if (pathKey(wanted) === ownKey) {
        if (!scopes.includes(scope)) scopes.push(scope);
        kept.push(wanted);
        continue;
      }
      // A worktree being removed stays chosen until its root is gone.
      const chosen = r.worktrees.find((w) => pathKey(w.path) === pathKey(wanted));
      const root = chosen && rootIn(chosen, own, folder.uri.fsPath);
      if (!chosen || !root || !(await stat(vscode.Uri.file(root)))) {
        gone.push(wanted);
        continue;
      }
      if (scopes.some((s) => s.key === laneKey(key, false, chosen.path))) continue;
      // Inside the folder, the root is spelled as the folder is (git
      // resolves symlinks), so watcher events, baselines and editor
      // documents of its files all use one spelling.
      const inside = relativeInside(folder.uri.fsPath, root);
      scopes.push({
        ...scope,
        key: laneKey(key, false, chosen.path),
        root: inside ? vscode.Uri.joinPath(folder.uri, ...inside.split('/')) : vscode.Uri.file(root),
        checkout: vscode.Uri.file(chosen.path),
        own: false,
        container: false,
        prunable: !!chosen.prunable,
        label: await this.labelFor(folder, chosen, r.worktrees.filter((w) => !w.prunable || w === chosen)),
        name: checkoutName(chosen),
        watcher: [],
      });
      kept.push(wanted);
    }
    if (gone.length > 0) {
      if (scopes.length === 0) {
        this.log.appendLine(`The chosen checkout ${gone.join(', ')} is no longer a worktree of ${folder.name}; recording the folder's own checkout.`);
        scopes.push(scope);
      } else {
        for (const g of gone) this.log.appendLine(`The checkout ${g} is no longer a worktree of ${folder.name}; its lane stopped.`);
      }
      const ownOnly = kept.length === 0 || (kept.length === 1 && pathKey(kept[0]) === ownKey);
      const unsaved = await this.saveChoiceSet(key, ownOnly ? undefined : kept);
      if (unsaved) this.log.appendLine(`Could not save that ${gone.join(', ')} is no longer chosen: ${unsaved.message}`);
    }
    let commonDir: string | undefined;
    for (const wt of [own, ...r.worktrees]) {
      commonDir = wt && commonDirOf(wt.path);
      if (commonDir !== undefined) break;
    }
    const commonKey = commonDir === undefined ? undefined : pathKey(commonDir);
    for (const s of scopes) {
      // Every worktree git lists, prunable ones too: one being removed still has files.
      s.nestedDirs = nestedUnder(s.root.fsPath, r.worktrees);
      s.nested = new IgnoredPaths(s.nestedDirs);
      s.commonKey = commonKey;
      s.commonDir = commonDir;
    }
    return scopes;
  }

  /**
   * Gives worktrees that appeared since the last listing their own lane, as
   * `autoRecordWorktrees` allows: while there is room, or (rotate) in place of
   * the lane idle longest. Worktrees there at the first listing after start
   * are not new. True when a folder's chosen checkouts changed.
   */
  private async autoRecord(scopes: Scope[]): Promise<boolean> {
    const mode = this.settings().autoRecordWorktrees;
    const fresh: Array<{ folder: vscode.WorkspaceFolder; worktree: Worktree }> = [];
    let waiting = false;
    // A lock left by a `git worktree add` that died never goes; after a while the worktree is taken as it is.
    const stillInitializing = (w: Worktree) => initializing(w) && (this.initWaits.get(pathKey(w.path)) ?? 0) < INIT_RETRIES;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      const listed = this.listings.get(key);
      if (!listed) continue;
      const known = this.knownWorktrees.get(key);
      // One `git worktree add` is still checking out stays new until it is done, so it is decided then.
      const settled = listed.filter((w) => !stillInitializing(w) || known?.has(pathKey(w.path)));
      this.knownWorktrees.set(key, new Set(settled.map((w) => pathKey(w.path))));
      if (!known || mode === 'off') continue;
      for (const w of listed) {
        if (w.prunable || known.has(pathKey(w.path)) || scopes.some((s) => pathKey(s.checkout.fsPath) === pathKey(w.path))) continue;
        if (stillInitializing(w)) {
          waiting = true;
          this.initWaits.set(pathKey(w.path), (this.initWaits.get(pathKey(w.path)) ?? 0) + 1);
        } else fresh.push({ folder, worktree: w });
      }
    }
    // Git removes the lock once the files are out; the watcher sees that, and this looks again in case it does not.
    if (waiting) this.scheduleWorktreeRefresh(INIT_RETRY_MS);
    if (fresh.length === 0) return false;
    // What records once each decision is applied.
    let lanes = scopes
      .slice(0, MAX_LANES)
      .map((s) => ({ key: s.key, folderKey: s.folder.uri.toString(), checkout: s.checkout.fsPath, name: s.name || s.folder.name, added: false }));
    const pathsOf = (folderKey: string) => lanes.filter((l) => l.folderKey === folderKey).map((l) => l.checkout);
    /** What this pass adds and stops, per folder; saved on top of the folder's latest choice. */
    const added = new Map<string, string[]>();
    const stopped = new Map<string, string[]>();
    const note = (map: Map<string, string[]>, folderKey: string, p: string) => map.set(folderKey, [...(map.get(folderKey) ?? []), p]);
    for (const { folder, worktree } of fresh) {
      const name = `${checkoutName(worktree)} (${worktree.path})`;
      if (lanes.length >= MAX_LANES) {
        if (mode !== 'rotate') {
          this.log.appendLine(`The new worktree ${name} is not recorded: at most ${MAX_LANES} checkouts record at once.`);
          continue;
        }
        // A folder's last lane never goes: a folder always records something.
        const candidates = lanes.filter((l) => pathsOf(l.folderKey).length > 1);
        const victim = lanes.find(
          (l) =>
            l.key ===
            rotationVictim(
              // A lane added in this pass has only just started: never the idlest.
              candidates.map((c) => ({ id: c.key, recording: true, lastActivity: c.added ? Date.now() : this.lastActivity(c.key) })),
              this.timeline.followed,
              Date.now(),
            ),
        );
        if (!victim) {
          this.log.appendLine(
            candidates.length === 0
              ? `The new worktree ${name} is not recorded: every lane is its folder's only one, and a folder always records one.`
              : `The new worktree ${name} is not recorded: every lane but the followed one changed in the last ${ROTATE_IDLE_MS / 60_000} minutes.`,
          );
          continue;
        }
        lanes = lanes.filter((l) => l !== victim);
        note(stopped, victim.folderKey, victim.checkout);
        this.log.appendLine(`Stopped recording ${victim.name}, idle longest, to record the new worktree ${name}.`);
      } else {
        this.log.appendLine(`Recording the new worktree ${name} in its own lane.`);
      }
      const key = folder.uri.toString();
      lanes.push({ key: laneKey(key, false, worktree.path), folderKey: key, checkout: worktree.path, name: checkoutName(worktree), added: true });
      note(added, key, worktree.path);
    }
    const touched = new Set([...added.keys(), ...stopped.keys()]);
    for (const folderKey of touched) {
      // The choice may have changed while git listed worktrees (a box ticked or cleared): build on that, not on what this pass read.
      const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.toString() === folderKey);
      const ownPath = scopes.find((s) => s.own && s.folder.uri.toString() === folderKey)?.checkout.fsPath ?? folder?.uri.fsPath ?? '';
      const base = this.chosenSet(folderKey) ?? (folder ? this.defaultPaths(folder, ownPath) : pathsOf(folderKey));
      const gone = new Set((stopped.get(folderKey) ?? []).map(pathKey));
      const kept = base.filter((p) => !gone.has(pathKey(p)));
      const next = [...kept, ...(added.get(folderKey) ?? []).filter((p) => !kept.some((k) => pathKey(k) === pathKey(p)))];
      const unsaved = await this.saveChoiceSet(folderKey, next);
      if (unsaved) this.log.appendLine(`Could not save the checkouts recorded: ${unsaved.message}`);
    }
    return touched.size > 0;
  }

  /** When a lane last recorded a change, or started recording if it has none. */
  private lastActivity(lane: string): number {
    return this.timeline.laneEvents(lane).at(-1)?.time ?? this.timeline.laneInfo(lane)?.since ?? 0;
  }

  /**
   * While auto-record is on, watches each recorded repository's common git
   * directory, where `git worktree add` creates `worktrees/<name>/` for every
   * new worktree, including ones outside the workspace.
   */
  private watchCommonDirs(): void {
    const want = new Map<string, string>();
    if (this.settings().autoRecordWorktrees !== 'off') for (const s of this.scopes.values()) if (s.commonKey && s.commonDir) want.set(s.commonKey, s.commonDir);
    for (const [key, subs] of this.commonWatchers) {
      if (want.has(key)) continue;
      for (const d of subs) d.dispose();
      this.commonWatchers.delete(key);
    }
    for (const [key, dir] of want) {
      if (this.commonWatchers.has(key)) continue;
      // A new worktree's directory, and the lock `git worktree add` holds until its files are checked out.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '{worktrees/*,worktrees/*/locked}'));
      const subs: vscode.Disposable[] = [watcher];
      watcher.onDidCreate(() => this.scheduleWorktreeRefresh(), null, subs);
      watcher.onDidDelete(() => this.scheduleWorktreeRefresh(), null, subs);
      this.commonWatchers.set(key, subs);
    }
  }

  /** Tells the timeline about a recording lane: its label, root and color, the color kept per checkout. */
  private defineLane(scope: Scope): void {
    const info = this.timeline.laneInfo(scope.key);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const label = laneLabel(scope.container ? '' : scope.name, scope.folder.name, multiRoot);
    let color = info?.color ?? 0;
    if (!color) {
      const checkoutKey = scope.checkout.scheme === 'file' ? pathKey(scope.checkout.fsPath) : scope.key;
      const taken = this.timeline.laneList().filter((l) => l.id !== scope.key).map((l) => l.color);
      color = colorSlot(this.choices.colorOf ? this.choices.colorOf(checkoutKey) : this.colors.get(checkoutKey), taken);
      if (this.choices.setColor) void Promise.resolve(this.choices.setColor(checkoutKey, color)).catch(() => {});
      else this.colors.set(checkoutKey, color);
    }
    const root = scope.root.scheme === 'file' ? scope.root.fsPath : scope.root.toString();
    if (info?.recording && info.label === label && info.root === root && info.color === color) return;
    this.timeline.defineLane({ id: scope.key, label, root, color, recording: true, since: info?.recording ? info.since : Date.now() });
  }

  /**
   * On the first refresh after start, follows the remembered lane, or the
   * first recorded one, unless the followed lane still has changes queued.
   */
  private followFirstLane(): void {
    if (!this.followPending) return;
    this.followPending = false;
    // Never in the middle of a change: following would overtake it.
    if (this.timeline.playing !== undefined) return;
    // The lane last followed, when it records again, is followed again.
    const remembered = this.choices.followed;
    if (remembered !== undefined && this.scopes.has(remembered)) {
      this.timeline.follow(remembered);
      return;
    }
    // Queued changes in the followed lane, such as a restored timeline's, keep it followed.
    if (this.timeline.pendingCount() > 0) return;
    const followed = this.timeline.followed;
    const lane = this.scopes.has(followed) ? followed : this.scopes.keys().next().value;
    if (lane !== undefined) this.timeline.follow(lane);
  }

  /**
   * The display label of a chosen worktree: the one it was given before, so
   * its files keep their mirrors while other worktrees come and go, or a new
   * one. A new label is unique among the folder's labels and never names a
   * top-level entry of the folder other than a worktree, so the folder's own
   * files can't share its display paths. A remembered label is checked
   * against those entries once per session, the first time it is used.
   */
  private async labelFor(folder: vscode.WorkspaceFolder, chosen: Worktree, worktrees: Worktree[]): Promise<string> {
    const folderKey = folder.uri.toString();
    const given = this.labelsIn(folderKey);
    const chosenKey = pathKey(chosen.path);
    const known = given.get(chosenKey);
    const checked = `${folderKey}\0${chosenKey}`;
    if (known !== undefined && this.labelsChecked.has(checked)) return known;
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(folder.uri.fsPath);
    } catch {
      // Unreadable: nothing in it to collide with.
    }
    const worktreeDirs = new Set(worktrees.map((w) => relativeInside(folder.uri.fsPath, w.path)));
    const taken = entries.filter((e) => !worktreeDirs.has(e));
    this.labelsChecked.add(checked);
    if (known !== undefined) {
      if (!taken.includes(known)) return known;
      this.log.appendLine(`${folder.name} now has its own ${known}, so checkout ${chosen.path} gets a new display name.`);
    }
    const others = [...given].filter(([k]) => k !== chosenKey);
    const listed = new Map(worktrees.flatMap((w) => others.filter(([k]) => k === pathKey(w.path)).map(([, l]) => [w.path, l] as const)));
    const elsewhere = others.filter(([k]) => !worktrees.some((w) => pathKey(w.path) === k)).map(([, l]) => l);
    const list = worktrees.includes(chosen) ? worktrees : [...worktrees, chosen];
    const label = worktreeLabels(list, { given: listed, taken: [...taken, ...elsewhere] }).get(chosen.path) ?? checkoutName(chosen);
    this.rememberLabel(folderKey, chosenKey, label);
    return label;
  }

  /** Labels remembered under `outerKey` (a folder URI, or FOLDER_PREFIXES), by inner key. */
  private labelsIn(outerKey: string): ReadonlyMap<string, string> {
    return this.choices.labelsOf ? this.choices.labelsOf(outerKey) : (this.labels.get(outerKey) ?? new Map<string, string>());
  }

  /** Remembers a label for good where `choices` can, else for the session; a failed save is logged. */
  private rememberLabel(outerKey: string, innerKey: string, label: string): void {
    const failed = (why: unknown) => this.log.appendLine(`Could not save the display name ${label}: ${why instanceof Error ? why.message : String(why)}`);
    if (!this.choices.setLabel) {
      if (!this.labels.has(outerKey)) this.labels.set(outerKey, new Map());
      this.labels.get(outerKey)!.set(innerKey, label);
      return;
    }
    try {
      void Promise.resolve(this.choices.setLabel(outerKey, innerKey, label)).then((r) => r instanceof Error && failed(r), failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * A folder's display-path prefix in a multi-root workspace, or undefined
   * with one folder: its name, made unique among the folders' prefixes (see
   * `folderLabels`). Once given, a folder keeps its prefix, so its files keep
   * their mirrors as folders come and go.
   */
  private folderPrefixOf(folder: vscode.WorkspaceFolder): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) return undefined;
    const given = this.labelsIn(FOLDER_PREFIXES);
    const known = given.get(folder.uri.toString());
    if (known !== undefined) return known;
    const open = new Set(folders.map((f) => f.uri.toString()));
    const labels = folderLabels(
      folders.map((f) => ({ name: f.name, path: f.uri.path, given: given.get(f.uri.toString()) })),
      [...given].filter(([k]) => !open.has(k)).map(([, l]) => l),
    );
    folders.forEach((f, i) => {
      if (!given.has(f.uri.toString())) this.rememberLabel(FOLDER_PREFIXES, f.uri.toString(), labels[i]);
    });
    const i = folders.findIndex((f) => f.uri.toString() === folder.uri.toString());
    return i === -1 ? folderLabels([{ name: folder.name, path: folder.uri.path }])[0] : labels[i];
  }

  /** Path used for display and mirror documents: prefixed with the folder's display prefix in multi-root workspaces, so files never collide. */
  private displayPathOf(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const prefix = folder && this.folderPrefixOf(folder);
    return prefix === undefined ? relPathOf(uri) : `${prefix}/${relPathOf(uri)}`;
  }

  /** Replaces every scope's watcher, so new ones pick up changed watcher settings. */
  private rewatch(): void {
    for (const scope of this.scopes.values()) {
      for (const d of scope.watcher) d.dispose();
      scope.watcher = this.watch(scope);
    }
  }

  /**
   * A watcher for the scope's root. It outlives the Scope object while the root
   * stays the same, so handlers look the scope up by key. A folder's watcher
   * also sees the files of checkouts and folders nested in it; those are left
   * to their own scope's watcher, so nothing is read twice.
   */
  private watch(scope: Scope): vscode.Disposable[] {
    const key = scope.key;
    const mine = (uri: vscode.Uri) => {
      const owner = this.scopeOf(uri);
      return !owner || owner.key === key;
    };
    const pattern = scope.own ? new vscode.RelativePattern(scope.folder, '**/*') : new vscode.RelativePattern(scope.root, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const subs: vscode.Disposable[] = [watcher];
    watcher.onDidCreate(
      (uri) => {
        if (!mine(uri)) return;
        this.noteWorktreeEvent(uri, 'create');
        this.schedule(uri, 'create');
      },
      null,
      subs,
    );
    watcher.onDidChange(
      (uri) => {
        if (!mine(uri)) return;
        this.noteWorktreeEvent(uri, 'change');
        this.schedule(uri, 'change');
      },
      null,
      subs,
    );
    watcher.onDidDelete(
      (uri) => {
        if (!mine(uri)) return;
        this.noteWorktreeEvent(uri, 'delete');
        const current = this.scopes.get(key);
        if (current && !current.own) {
          // Something changed, so a refresh is worth asking for again.
          this.goneRefreshed.delete(key);
          this.checkCheckoutGone(current);
          // Deletes are still coming: held ones wait for them to stop.
          if (this.deleteSettles.has(key)) this.settleDeletes(key);
        }
        this.schedule(uri, 'delete');
      },
      null,
      subs,
    );
    return subs;
  }

  /**
   * Something was deleted in a chosen worktree, or it is time to look again.
   * Watchers don't reliably report a removed root or its `.git` file, and on
   * Windows the watcher of a removed root may report nothing at all, so check
   * whether the checkout itself is gone, once the burst of deletes settles.
   * While it stays chosen it is checked again, less often each time, down to
   * every GONE_CHECK_MAX_MS. One git still lists without its `.git`
   * (prunable) is being removed and falls back once its root is gone too.
   * With `keepSooner`, a check already due sooner is left as it is.
   */
  private checkCheckoutGone(scope: Scope, delayMs = 300, keepSooner = false): void {
    const key = scope.key;
    const at = Date.now() + delayMs;
    const pending = this.goneChecks.get(key);
    if (keepSooner && pending && pending.at <= at) return;
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      this.goneChecks.delete(key);
      const current = this.scopes.get(key);
      if (!current || current.own) return;
      void Promise.all([stat(vscode.Uri.joinPath(current.checkout, '.git')), stat(current.root)]).then(([git, root]) => {
        if (!this.running || this.scopes.get(key)?.checkout.toString() !== current.checkout.toString()) return;
        const prunable = this.scopes.get(key)!.prunable;
        const missing = !root ? 'root' : !git && !prunable ? '.git' : '';
        const seen = `${current.checkout.toString()}\0${missing}`;
        // A refresh that kept this checkout (git could not run, say) is not
        // asked for again until what is missing changes or a delete arrives.
        if (missing && this.goneRefreshed.get(key) !== seen) {
          this.goneRefreshed.set(key, seen);
          this.scheduleWorktreeRefresh();
        } else {
          if (!missing) this.goneRefreshed.delete(key);
          // A delete during the stats may have armed a sooner check.
          this.checkCheckoutGone(current, Math.min(delayMs * 2, GONE_CHECK_MAX_MS), true);
        }
      });
    }, delayMs);
    this.goneChecks.set(key, { timer, at });
  }

  /**
   * The scope that records this path, if any: the one with the innermost root
   * holding it, among chosen checkouts and the innermost workspace folder
   * recording its own. A chosen worktree inside a folder takes precedence over
   * the folder.
   */
  private scopeOf(uri: vscode.Uri): Scope | undefined {
    const open = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()));
    // A removed folder's chosen worktree stops counting at once, before the refresh drops its scope.
    const candidates = [...this.scopes.values()].filter((s) => !s.own && open.has(s.folder.uri.toString()));
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const own = folder && this.scopes.get(folder.uri.toString());
    if (own?.own) candidates.push(own);
    const i = innermostRoot(
      candidates.map((s) => s.root.path),
      uri.path,
    );
    // The folder itself (getWorkspaceFolder counts a folder as its own) is not inside its root.
    return i === -1 ? (own?.own ? own : undefined) : candidates[i];
  }

  /** Path used for filtering and git: relative to the recorded checkout root. */
  private relOf(scope: Scope, uri: vscode.Uri): string {
    return scope.own ? relPathOf(uri) : uri.path.slice(scope.root.path.replace(/\/+$/, '').length + 1);
  }

  /** Path used for display and mirrors: a chosen worktree's label goes in front, so checkouts never share a mirror. */
  private displayOf(scope: Scope | undefined, uri: vscode.Uri): string {
    if (!scope || scope.own) return this.displayPathOf(uri);
    return checkoutDisplayPath(this.folderPrefixOf(scope.folder) ?? '', scope.label, this.relOf(scope, uri));
  }

  /**
   * A watcher event that may mean a worktree came or went. Below the root, a
   * `.git` file of a linked worktree of this repository, written (git worktree
   * add, or move rewriting it) or in a directory moved in (git worktree move),
   * is a new worktree: its files are hidden right away and git confirms on
   * refresh. Clones, submodules and other repositories' worktrees are left
   * alone. A deleted nested worktree, its `.git`, or the chosen root's own
   * `.git` may be a worktree going away.
   */
  private noteWorktreeEvent(uri: vscode.Uri, event: 'create' | 'change' | 'delete'): void {
    if (!this.running || uri.scheme !== 'file') return;
    const scope = this.scopeOf(uri);
    if (!scope?.repo) return;
    const rel = this.relOf(scope, uri);
    if (rel === '.git') {
      if (!scope.own && event !== 'change') this.scheduleWorktreeRefresh();
      return;
    }
    const isGit = uri.path.endsWith('/.git');
    const dir = isGit ? rel.slice(0, -'.git'.length) : rel + '/';
    if (event === 'delete') {
      if (scope.nestedDirs.some((d) => d.startsWith(dir))) this.scheduleWorktreeRefresh();
      return;
    }
    if (scope.nested.has(dir)) return;
    if (this.isWorktreeGitFile(isGit ? uri.fsPath : path.join(uri.fsPath, '.git'), scope)) this.hideNewWorktree(scope, dir);
  }

  /** Hides a new worktree's root-relative `dir/` right away, until a worktree listing started after now settles it. */
  private hideNewWorktree(scope: Scope, dir: string): void {
    scope.nested.add(dir);
    const key = scope.key;
    const entries = this.provisional.get(key) ?? [];
    entries.push({ dir, seq: ++this.provisionalSeq, root: scope.root.toString() });
    this.provisional.set(key, entries);
    this.scheduleWorktreeRefresh();
  }

  /** True for a `.git` file that makes its directory a linked worktree of the scope's repository. */
  private isWorktreeGitFile(file: string, scope: Scope): boolean {
    return scope.commonKey !== undefined && isWorktreeOf(file, scope.commonKey);
  }

  /**
   * True when a file the recorder has no snapshot of sits in a linked worktree
   * of the scope's repository added under it since its worktrees were listed. The watcher can
   * report such a checkout's files before its `.git` file, or miss that event
   * for a new directory, so this looks for the `.git` file itself. The worktree
   * is then skipped like a listed one, and git confirms on refresh.
   */
  private inNewWorktree(scope: Scope, uri: vscode.Uri): boolean {
    const rel = this.relOf(scope, uri);
    for (let end = rel.lastIndexOf('/'); end > 0; end = rel.lastIndexOf('/', end - 1)) {
      const dir = rel.slice(0, end + 1);
      if (scope.nested.has(dir) || !this.isWorktreeGitFile(vscode.Uri.joinPath(scope.root, dir, '.git').fsPath, scope)) continue;
      this.hideNewWorktree(scope, dir);
      this.note(`in a worktree added while recording, dropped ${this.traceName(uri)}`);
      return true;
    }
    return false;
  }

  private scheduleWorktreeRefresh(delayMs = 300): void {
    clearTimeout(this.worktreeRefresh);
    this.worktreeRefresh = setTimeout(() => {
      this.refreshFilter('Worktrees changed').catch((err) => this.log.appendLine(`Failed to re-read worktrees: ${String(err)}`));
    }, delayMs);
  }

  /**
   * Files under a directory of the scope (its root unless given, with `startRel`
   * its root-relative path), skipping directories the filters, gitignore,
   * nested worktrees or `files.watcherExclude` rule out, `.git` directories,
   * and below the start any directory holding a linked worktree's `.git` file,
   * which git may not have listed yet. Unlike findFiles, it ignores
   * `files.exclude`, which the watcher does not apply either.
   */
  private async walk(scope: Scope, stale: () => boolean, start = scope.root, startRel = ''): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    const ignored = this.ignored.get(scope.key);
    const dirs: Array<[vscode.Uri, string]> = [[start, startRel]];
    while (dirs.length > 0 && !stale()) {
      await Promise.all(
        dirs.splice(0, 64).map(async ([dir, rel]) => {
          let entries: [string, vscode.FileType][];
          try {
            entries = await vscode.workspace.fs.readDirectory(dir);
          } catch {
            return;
          }
          const gitFile = entries.some(([name, type]) => name === '.git' && type & vscode.FileType.File);
          if (rel && gitFile && this.isWorktreeGitFile(vscode.Uri.joinPath(dir, '.git').fsPath, scope)) return;
          for (const [name, type] of entries) {
            const childRel = rel ? `${rel}/${name}` : name;
            if (type & vscode.FileType.Directory) {
              // Linked directories can loop, and the watcher reports changes in them only under their real path.
              if (type & vscode.FileType.SymbolicLink || name.toLowerCase() === '.git') continue;
              if (this.skipsDir(scope, childRel, ignored)) continue;
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

  /** True when nothing under this root-relative directory is recorded: a nested worktree, gitignored, excluded, or hidden from the watcher. */
  private skipsDir(scope: Scope, rel: string, ignored = this.ignored.get(scope.key)): boolean {
    const asDir = rel + '/';
    return scope.nested.has(asDir) || !!ignored?.has(asDir) || this.filter.excludesDir(rel) || this.watcherHides(scope, rel);
  }

  /** Like `skipsDir`, for the directory or any directory above it, such as anything under node_modules/. */
  private skipsTree(scope: Scope, rel: string): boolean {
    for (let end = rel.indexOf('/'); end !== -1; end = rel.indexOf('/', end + 1)) {
      if (this.skipsDir(scope, rel.slice(0, end))) return true;
    }
    return this.skipsDir(scope, rel);
  }

  /**
   * A directory was created or moved in. Watchers report only the directory,
   * not the files in it, so each file found is scheduled as created. A file
   * that also gets its own event shares its debounce burst, so it is recorded once.
   */
  private async expandCreatedDirectory(dir: vscode.Uri): Promise<void> {
    const session = this.session;
    const stale = () => !this.running || session !== this.session;
    const st = await stat(dir);
    if (!st || !(st.type & vscode.FileType.Directory) || st.type & vscode.FileType.SymbolicLink || stale()) return;
    const scope = this.scopeOf(dir);
    if (!scope) return;
    const rel = this.relOf(scope, dir);
    if (this.skipsTree(scope, rel)) return;
    const files = await this.walk(scope, stale, dir, rel);
    if (stale()) return;
    for (const file of files) this.schedule(file, 'create', true);
  }

  /**
   * A directory may have been deleted. Watchers report only the directory, so
   * each file recorded under it is scheduled as deleted. Paths deleted in one
   * tick are looked up together, in one pass over the baselines.
   */
  private scheduleDeletesUnder(dir: vscode.Uri): void {
    const key = dir.toString();
    // A recorded file has nothing under it, and an excluded or ignored tree has no baselines.
    if (this.snapshots.has(key) || this.gitBaselines.has(key)) return;
    const scope = this.scopeOf(dir);
    if (!scope || this.skipsTree(scope, this.relOf(scope, dir))) return;
    this.deletedDirs.add(foldKey(key.replace(/\/+$/, '')));
    this.deleteSweep ??= setImmediate(() => {
      this.deleteSweep = undefined;
      const dirs = new Set(this.deletedDirs);
      this.deletedDirs.clear();
      if (!this.running) return;
      for (const child of this.keysUnder(dirs)) this.schedule(vscode.Uri.parse(child), 'delete', true);
    });
  }

  /** Baselined keys inside any of these directories (folded keys without a trailing slash). */
  private keysUnder(dirs: Set<string>): string[] {
    const found: string[] = [];
    for (const store of [this.snapshots, this.gitBaselines]) {
      for (const key of store.keys()) {
        const k = foldKey(key);
        for (let i = k.lastIndexOf('/'); i > 0; i = k.lastIndexOf('/', i - 1)) {
          if (dirs.has(k.slice(0, i))) {
            found.push(key);
            break;
          }
        }
      }
    }
    return found;
  }

  /**
   * Gives each recorded file without a baseline one: a git ref for a clean
   * tracked file, else an in-memory snapshot, newest first within the budget.
   * Both kinds cover only regular files (or links to them) within
   * maxFileSizeKB. While a rebuild is pending, every file's baseline is taken
   * again into new maps, swapped in once complete; a file that changed
   * meanwhile keeps the one it has.
   */
  private async captureBaseline(): Promise<void> {
    // A file written after this point is a change still on its way through the
    // watcher; snapshotting it now would swallow that change.
    const startedAt = Date.now();
    const gen = ++this.baselineGen;
    const stale = () => gen !== this.baselineGen;
    const s = this.settings();
    const maxBytes = s.maxFileSizeKB * 1024;
    const rebuild = this.rebuildPending;
    const snapshots = rebuild ? new Map<string, Snapshot>() : this.snapshots;
    const gitRefs = rebuild ? new Map<string, GitBaselineRef>() : this.gitBaselines;
    // What a rebuild started from: a baseline a flush replaced or used up since is newer than the rebuild's.
    const before = rebuild ? { snapshots: new Map(this.snapshots), gitBaselines: new Map(this.gitBaselines) } : undefined;
    const known = (key: string) => !rebuild && (this.snapshots.has(key) || this.gitBaselines.has(key));
    const tracked: Array<[vscode.Uri, GitBaselineRef]> = [];
    const candidates: vscode.Uri[] = [];
    for (const scope of [...this.scopes.values()]) {
      const found = await this.walk(scope, stale);
      const clean = s.gitBaselines ? await this.cleanTracked(scope) : undefined;
      if (stale()) return;
      for (const uri of found) {
        // A file in a workspace folder or recorded checkout nested in this one is that one's, with paths relative to it.
        if (this.scopeOf(uri)?.key !== scope.key || !this.passes(uri) || known(uri.toString())) continue;
        const rel = this.relOf(scope, uri);
        const sha = clean?.get(rel);
        if (sha !== undefined) tracked.push([uri, { folder: scope.root.fsPath, path: rel, sha }]);
        else candidates.push(uri);
      }
    }

    const isFile = (st: vscode.FileStat | undefined): st is vscode.FileStat => !!st && (st.type & vscode.FileType.File) !== 0 && st.size <= maxBytes;
    await inBatches(tracked, async ([uri, ref]) => {
      const key = uri.toString();
      if (isFile(await stat(uri)) && !known(key)) gitRefs.set(key, ref);
    });
    if (stale()) return;

    // Everything else gets an in-memory snapshot, newest first, within the budget.
    const stats: BudgetCandidate[] = [];
    const mtimes = new Map<string, number>();
    const writtenMeanwhile = new Set<string>();
    // In a rebuild, a file with a baseline written just before or during it keeps that baseline.
    const recentlyWritten = (key: string, mtime: number) =>
      !!before &&
      (before.snapshots.has(key) || before.gitBaselines.has(key)) &&
      mtime >= startedAt - REBUILD_RECENT_MS &&
      mtime <= Date.now() + CAPTURE_SKEW_MS;
    await inBatches(candidates, async (uri) => {
      const st = await stat(uri);
      if (!isFile(st)) return;
      const key = uri.toString();
      if (recentlyWritten(key, st.mtime) || writtenDuringCapture(st.mtime, startedAt, Date.now())) writtenMeanwhile.add(key);
      // A file stamped in the future counts as the newest.
      else {
        stats.push({ key, size: st.size, mtime: Math.min(st.mtime, startedAt) });
        mtimes.set(key, st.mtime);
      }
    });
    if (stale()) return;
    let used = 0;
    if (!rebuild) for (const snap of this.snapshots.values()) used += snap.text.length;
    const uris = new Map(candidates.map((u) => [u.toString(), u]));
    const left = await fillBudget(stats, Math.max(0, s.baselineBudgetMB * 1024 * 1024 - used), async ({ key }) => {
      if (stale()) return undefined;
      const uri = uris.get(key)!;
      const snap = await this.readText(uri, s);
      if (snap === undefined || stale() || known(key)) return undefined;
      // A change on its way through the debounce: its read takes the baseline.
      if (!before && (this.timers.has(key) || this.flushes.has(key))) return undefined;
      if (before) {
        // Written between its stat and this read: the current baseline is what that change starts from.
        const old = before.snapshots.get(key);
        const st = await stat(uri);
        if ((old && old.text !== snap.text) || !st || recentlyWritten(key, st.mtime)) {
          writtenMeanwhile.add(key);
          return undefined;
        }
      }
      snapshots.set(key, { ...snap, captured: { at: Date.now(), mtime: mtimes.get(key)! } });
      return snap.text.length;
    });
    if (stale()) return;
    // Files left out for the budget, not counting binaries, which never get a
    // baseline. Past the first PROBE_LIMIT, files are counted without a look.
    let uncovered = Math.max(0, left.length - PROBE_LIMIT);
    await inBatches(left.slice(0, PROBE_LIMIT), async ({ key }) => {
      if (await isTextFile(uris.get(key)!)) uncovered++;
    });
    if (stale()) return;

    if (before) {
      this.rebuildPending = false;
      for (const key of new Set([...this.snapshots.keys(), ...this.gitBaselines.keys(), ...snapshots.keys(), ...gitRefs.keys()])) {
        const changed = this.snapshots.get(key) !== before.snapshots.get(key) || this.gitBaselines.get(key) !== before.gitBaselines.get(key);
        if (changed || writtenMeanwhile.has(key) || this.timers.has(key) || this.flushes.has(key)) continue;
        const snap = snapshots.get(key);
        const ref = gitRefs.get(key);
        if (snap) this.snapshots.set(key, snap);
        else this.snapshots.delete(key);
        if (ref) this.gitBaselines.set(key, ref);
        else this.gitBaselines.delete(key);
      }
    }
    if (uncovered > 0) {
      this.log.appendLine(
        `${uncovered} matching files have no baseline because baselineBudgetMB (${s.baselineBudgetMB}) is reached; ` +
          'their first change is only captured as a baseline. Raise the budget, enable gitBaselines, or narrow the filters.',
      );
    }
  }

  /**
   * Path filters within the recorded checkout, minus other worktrees inside
   * it, paths `files.watcherExclude` hides from the watcher and, while
   * `respectGitignore` is on, the gitignored paths known so far.
   */
  private passes(uri: vscode.Uri): boolean {
    if (this.scopes.size === 0) return this.filter.matches(relPathOf(uri));
    const scope = this.scopeOf(uri);
    if (!scope) return false;
    const rel = this.relOf(scope, uri);
    if (!this.filter.matches(rel) || scope.nested.has(rel) || this.watcherHides(scope, rel)) return false;
    return !this.ignored.get(scope.key)?.has(rel);
  }

  /**
   * Re-lists gitignored paths for each folder's recorded checkout, or clears
   * them when the setting is off. When git could not run for a folder, the
   * listing is tried once more a little later.
   */
  private async refreshIgnored(): Promise<void> {
    const next = new Map<string, IgnoredPaths>();
    let lost = false;
    if (this.settings().respectGitignore) {
      for (const scope of [...this.scopes.values()]) {
        const key = scope.key;
        const r = scope.root.scheme === 'file' ? await listIgnored(scope.root.fsPath) : ({ kind: 'not-repo' } as const);
        if (r.kind === 'ok') {
          next.set(key, r.ignored);
          this.ignoreNoted.delete(key);
          continue;
        }
        if (r.kind === 'unavailable') lost = true;
        if (!this.ignoreNoted.has(key)) {
          this.ignoreNoted.add(key);
          const why = r.kind === 'unavailable' ? `git could not run (${r.reason})` : 'it is not in a git repository';
          this.log.appendLine(`respectGitignore has no effect for ${scope.folder.name}: ${why}.`);
        }
      }
    }
    this.ignored.clear();
    for (const [k, v] of next) this.ignored.set(k, v);
    // One retry per failure: it stops once git keeps failing, and starts over after a listing that works.
    if (lost && !this.ignoreRetried) this.scheduleIgnoreRefresh(IGNORE_RETRY_MS);
    this.ignoreRetried = lost;
  }

  /** A file the ignore snapshot doesn't know yet: asks git once and remembers an ignored answer. */
  private async newlyIgnored(uri: vscode.Uri): Promise<boolean> {
    const scope = this.scopeOf(uri);
    const known = scope && this.ignored.get(scope.key);
    if (!scope || !known) return false;
    const rel = this.relOf(scope, uri);
    if (!(await checkIgnored(scope.root.fsPath, rel))) return false;
    known.add(rel);
    return true;
  }

  /** A `.gitignore` changed, or listing the rules failed: re-apply them once the burst of writes settles. */
  private scheduleIgnoreRefresh(delayMs = 300): void {
    clearTimeout(this.ignoreRefresh);
    this.ignoreRefresh = setTimeout(() => {
      this.refreshFilter().catch((err) => this.log.appendLine(`Failed to re-apply .gitignore: ${String(err)}`));
    }, delayMs);
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

  /** Takes a file's git baseline, if it has one, and reads it as a snapshot; undefined for a binary or oversized blob. */
  private async takeGitBaseline(key: string, s: Settings): Promise<Snapshot | undefined> {
    const ref = this.gitBaselines.get(key);
    if (!ref) return undefined;
    this.gitBaselines.delete(key);
    const bytes = await readBlob(ref.folder, ref.path, ref.sha);
    if (!bytes) {
      this.log.appendLine(`Could not read the git baseline of ${ref.path}; its change is only captured as a baseline.`);
      return undefined;
    }
    return this.decode(bytes, s, vscode.Uri.parse(key));
  }

  /**
   * A watcher event, or (`inDir`) a file found under a directory a watcher
   * event named. Merges it into the file's debounce burst.
   */
  private schedule(uri: vscode.Uri, event: 'create' | 'change' | 'delete', inDir = false): void {
    if (!this.running || uri.scheme !== 'file') return;
    if (!inDir) {
      if (uri.path.endsWith('/.gitignore') && this.settings().respectGitignore) this.scheduleIgnoreRefresh();
      // Directory paths can fail the filter, so look inside them before it applies.
      if (event === 'delete') this.scheduleDeletesUnder(uri);
      else if (event === 'create') {
        this.expandCreatedDirectory(uri).catch((err) => this.log.appendLine(`Failed to read new directory ${relPathOf(uri)}: ${String(err)}`));
      }
    }
    const key = uri.toString();
    // A held delete of this file is decided before a write that follows it; a
    // repeated delete event only says deletes are still coming.
    const held = this.heldDeletes.get(key);
    if (held && event !== 'delete') this.releaseDelete(key, held);
    else if (held) this.settleDeletes(held.scopeKey);
    const passes = this.passes(uri);
    this.note(`${inDir ? 'in directory' : 'watcher'} ${event} ${this.traceName(uri)}${passes ? '' : ' (filtered out)'}`);
    if (!passes) return;
    const now = Date.now();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const burst: Burst = {
      timer: setTimeout(() => {
        this.timers.delete(key);
        this.flushes
          .run(key, () => this.flush(uri, burst))
          .catch((err) => {
            this.note(`read failed ${this.traceName(uri)}: ${String(err)}`);
            this.log.appendLine(`Failed to record ${relPathOf(uri)}: ${String(err)}`);
          })
          .finally(() => {
            if (!burst.held) burst.done();
          });
      }, this.settings().debounceMs),
      created: event === 'create' || (existing?.created ?? false),
      sawDelete: event === 'delete' || (existing?.sawDelete ?? false),
      deletedAt: event === 'delete' ? (existing?.deletedAt ?? now) : undefined,
      firstArrival: existing?.firstArrival ?? now,
      lastArrival: now,
      session: this.session,
      done: existing?.done ?? this.reorder.pending(now),
    };
    this.timers.set(key, burst);
  }

  private async flush(uri: vscode.Uri, burst: Burst): Promise<void> {
    const key = uri.toString();
    // Recording may stop, restart, or stop matching this file while the read
    // waits; from then on it writes nothing, like a burst stop() cancels.
    const dropped = (): boolean => {
      const current = this.running && burst.session === this.session;
      if (current && this.passes(uri)) return false;
      this.note(`${current ? 'no longer matches the filter' : 'recorder stopped'}, dropped ${this.traceName(uri)}`);
      return true;
    };
    if (dropped()) {
      if (burst.session === this.session) this.ownSaves.delete(key);
      return;
    }
    const scope = this.scopeOf(uri);
    if (scope && !this.snapshots.has(key) && this.inNewWorktree(scope, uri)) {
      if (burst.session === this.session) this.ownSaves.delete(key);
      return;
    }
    const relPath = this.displayOf(scope, uri);
    const s = this.settings();
    let previous = this.snapshots.get(key);
    // A file gone with the chosen checkout it was in needs no git baseline, which git may no longer have.
    if (previous === undefined && scope && !scope.own && this.gitBaselines.has(key) && !(await stat(uri)) && (await this.checkoutGone(scope))) {
      if (dropped()) return;
      this.gitBaselines.delete(key);
      this.ownSaves.delete(key);
      this.note(`checkout removed, dropped ${relPath}`);
      return;
    }
    previous ??= await this.takeGitBaseline(key, s);
    if (dropped()) return;

    // A change read mid-save waits for the save to finish, so the comparison
    // below sees the final saved text. A save that started well before this
    // burst most likely failed: it gets only a moment, enough for the did-save
    // of a save whose participants ran long, and is then forgotten.
    let pendingSave = s.ignoreOwnSaves ? this.ownSaves.get(key) : undefined;
    if (pendingSave && !pendingSave.done) {
      const old = pendingSave.startedAt < burst.firstArrival - SAVE_SETTLE_MAX_MS;
      await Promise.race([pendingSave.settled, new Promise((r) => setTimeout(r, old ? OLD_SAVE_GRACE_MS : SAVE_SETTLE_MAX_MS))]);
      if (dropped()) return;
      if (old && !pendingSave.done) {
        this.forgetOwnSave(key, pendingSave);
        pendingSave = undefined;
      }
    }

    let exists = await stat(uri);
    if (dropped()) return;
    // A delete event for a path that still stats may be a case-only rename on
    // a case-insensitive filesystem: this spelling is gone.
    if (exists && burst.sawDelete && !(await existsExactly(uri, scope?.root))) exists = undefined;
    if (dropped()) return;
    // A file replaced by a directory is deleted as a file.
    const isDir = exists !== undefined && (exists.type & vscode.FileType.Directory) !== 0;
    if (!exists || isDir) {
      this.ownSaves.delete(key);
      if (scope && !scope.own) {
        // A chosen worktree being removed deletes all its files; that is the
        // checkout going away, not a change to replay.
        const gone = await this.checkoutGone(scope);
        if (dropped()) return;
        if (gone) {
          this.note(`checkout removed, dropped ${relPath}`);
          this.snapshots.delete(key);
          return;
        }
        // Its `.git` may just not be gone yet: wait until deletes there stop.
        if (!isDir && previous !== undefined) {
          this.snapshots.delete(key);
          // Unless it is half of a rename whose create in this checkout is
          // already held: that shows the checkout is not being removed.
          const deletedAt = burst.deletedAt ?? burst.lastArrival;
          const event = changeEvent(uri, relPath, 'delete', previous.text, '', previous.eol, deletedAt, scope.key);
          if (!this.recordRename(event, deletedAt, scope.root.toString())) this.holdDelete(scope, uri, relPath, previous, burst);
          return;
        }
      }
      if (previous !== undefined) {
        this.snapshots.delete(key);
        // Keyed by its own delete event: earlier writes in the burst were before it.
        this.record(uri, relPath, 'delete', previous.text, '', previous.eol, burst.deletedAt ?? burst.lastArrival);
        // A change event is all a file swapped for a directory may get; the files in it are new.
        if (isDir && !burst.created) await this.expandCreatedDirectory(uri);
      } else {
        this.note(isDir ? `not a file ${relPath}` : `gone, no baseline ${relPath}`);
      }
      return;
    }
    // A link to a file reads as the file it leads to.
    if (!(exists.type & vscode.FileType.File)) {
      this.note(`not a file ${relPath}`);
      this.ownSaves.delete(key);
      return;
    }
    // A new file a baseline capture read before its create event arrived: what
    // came before the capture's text is nothing.
    const captured = previous?.captured;
    if (burst.created && captured && captured.mtime === exists.mtime && burst.firstArrival - captured.at < SWALLOWED_CREATE_MS) previous = undefined;
    if (previous === undefined && (await this.newlyIgnored(uri))) {
      if (dropped()) return;
      this.note(`newly ignored ${relPath}`);
      this.ownSaves.delete(key);
      return;
    }
    if (dropped()) return;
    // A directory replaced by a file, which may get only a change event: the
    // files recorded in it are gone, and this one is new.
    let created = burst.created;
    if (previous === undefined && !created) {
      const under = this.keysUnder(new Set([foldKey(key)]));
      for (const child of under) this.schedule(vscode.Uri.parse(child), 'delete', true);
      created = under.length > 0;
    }
    const writtenAt = clampOrderKey(exists.mtime, burst.firstArrival, burst.lastArrival, s.reorderWindowMs);

    let readError: unknown;
    const snap = await this.readText(uri, s, exists.size, (err) => (readError = err));
    if (dropped()) return;
    if (snap === undefined) {
      this.note(readError === undefined ? `binary or too large ${relPath}` : `unreadable ${relPath}: ${String(readError)}`);
      this.snapshots.delete(key);
      this.ownSaves.delete(key);
      return;
    }

    // Each editor save is matched once, against the next change read for its
    // file. A save that started after this read was waited on is left for the
    // change its own write brings, unless it already finished.
    let saved = s.ignoreOwnSaves ? this.ownSaves.get(key) : undefined;
    if (saved && !saved.done && saved !== pendingSave) saved = undefined;
    else this.ownSaves.delete(key);
    const decision = saved ? decideOwnSave(saved.text, snap.text, saved.done) : ({ kind: 'external' } as const);
    if (decision.kind === 'own') {
      this.note(`own save ${relPath}`);
      this.snapshots.set(key, snap);
      return;
    }
    if (decision.kind === 'after-own') {
      // Something wrote after the user's save: replay only that, from the saved text.
      this.snapshots.set(key, snap);
      const kind = previous === undefined && created ? 'create' : 'modify';
      this.record(uri, relPath, kind, decision.before, snap.text, snap.eol, writtenAt);
      return;
    }

    // Always store the new snapshot, so a line-ending-only rewrite updates eol
    // for the next change without being recorded itself.
    this.snapshots.set(key, snap);
    if (previous === undefined) {
      // No baseline: a brand-new file is typed from empty; an unknown existing
      // file just gets its baseline now.
      if (created) this.record(uri, relPath, 'create', '', snap.text, snap.eol, writtenAt);
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

  /** True when the chosen checkout's `.git` or the recorded root is gone. */
  private async checkoutGone(scope: Scope): Promise<boolean> {
    const [git, root] = await Promise.all([stat(vscode.Uri.joinPath(scope.checkout, '.git')), stat(scope.root)]);
    return !git || !root;
  }

  /**
   * Holds a file's delete in a chosen worktree until deletes there have been
   * quiet for DELETE_SETTLE_MS. The reorder buffer keeps changes written
   * after it back meanwhile, so it keeps its place in write order: a rename
   * done as delete-then-create replays in that order.
   */
  private holdDelete(scope: Scope, uri: vscode.Uri, relPath: string, before: Snapshot, burst: Burst): void {
    const scopeKey = scope.key;
    const order = this.reorder.hold(burst.deletedAt ?? burst.lastArrival, DELETE_ORDER_HOLD_MAX_MS);
    burst.held = true;
    this.note(`delete held ${relPath}`);
    this.heldDeletes.set(uri.toString(), {
      uri,
      relPath,
      before,
      order,
      scopeKey,
      root: scope.root.toString(),
      session: burst.session,
      done: () => {
        order.end();
        burst.done();
      },
    });
    this.settleDeletes(scopeKey);
  }

  /** (Re)starts the quiet period after which a checkout's held deletes are decided, up to DELETE_HOLD_MAX_MS after the first. */
  private settleDeletes(scopeKey: string): void {
    const now = Date.now();
    const pending = this.deleteSettles.get(scopeKey);
    clearTimeout(pending?.timer);
    const since = pending?.since ?? now;
    const timer = setTimeout(
      () => {
        this.deleteSettles.delete(scopeKey);
        for (const [key, held] of [...this.heldDeletes]) if (held.scopeKey === scopeKey) this.releaseDelete(key, held);
      },
      Math.max(0, Math.min(DELETE_SETTLE_MS, since + DELETE_HOLD_MAX_MS - now)),
    );
    this.deleteSettles.set(scopeKey, { timer, since });
  }

  /**
   * Decides a held delete, in turn with the file's reads: dropped when its
   * checkout or root is gone, or recording moved on; else recorded at the
   * time it happened.
   */
  private releaseDelete(key: string, held: HeldDelete): void {
    if (this.heldDeletes.get(key) !== held) return;
    this.heldDeletes.delete(key);
    this.flushes
      .run(key, async () => {
        const current = () => {
          const scope = this.scopes.get(held.scopeKey);
          return this.running && held.session === this.session && scope && !scope.own && scope.root.toString() === held.root ? scope : undefined;
        };
        const scope = current();
        if (!scope || (await this.checkoutGone(scope)) || !current()) {
          this.note(`${scope && current() ? 'checkout removed' : 'checkout changed'}, dropped ${held.relPath}`);
          return;
        }
        this.record(held.uri, held.relPath, 'delete', held.before.text, '', held.before.eol, held.order.key());
      })
      .catch((err) => this.log.appendLine(`Failed to record ${held.relPath}: ${String(err)}`))
      .finally(held.done);
  }

  /** Forgets held deletes, of one checkout when given, without recording them. */
  private dropHeldDeletes(scopeKey?: string): void {
    for (const [key, held] of [...this.heldDeletes]) {
      if (scopeKey !== undefined && held.scopeKey !== scopeKey) continue;
      this.heldDeletes.delete(key);
      held.done();
    }
    if (scopeKey !== undefined) {
      clearTimeout(this.deleteSettles.get(scopeKey)?.timer);
      this.deleteSettles.delete(scopeKey);
    }
  }

  /**
   * Where an editor save of this document shows up: its own path and, when a
   * symlink inside a recorded folder leads to another file there, that file's
   * path. A document that is itself a symlink file only writes its target.
   * `keep` are the keys to remember the save under: recorded paths, for text
   * within maxFileSizeKB. `drop` are the rest.
   */
  private ownSaveKeys(uri: vscode.Uri, text: string): { keep: string[]; drop: string[] } {
    const own = uri.toString();
    let linkFile = false;
    try {
      linkFile = fs.lstatSync(uri.fsPath).isSymbolicLink();
    } catch {
      // Gone already; keep the document's own path.
    }
    const target = this.linkTargetOf(uri)?.toString();
    // A link file's save writes only its target, which may be outside every recorded folder.
    const keys = linkFile ? [] : [own];
    if (target && !keys.includes(target)) keys.push(target);
    const fits = Buffer.byteLength(text, 'utf8') <= this.settings().maxFileSizeKB * 1024;
    const keep = keys.filter((k) => fits && this.passes(vscode.Uri.parse(k)));
    return { keep, drop: keys.filter((k) => !keep.includes(k)) };
  }

  /** The real file a document path leads to, spelled under the recorded folder it is in, or undefined outside every one. */
  private linkTargetOf(uri: vscode.Uri): vscode.Uri | undefined {
    let real: string;
    try {
      real = fs.realpathSync.native(uri.fsPath);
    } catch {
      return undefined;
    }
    const roots = this.scopes.size > 0 ? [...this.scopes.values()].map((s) => s.root) : (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    for (const root of roots) {
      if (root.scheme !== 'file') continue;
      let realRoot: string;
      try {
        realRoot = fs.realpathSync.native(root.fsPath);
      } catch {
        continue;
      }
      const rel = path.relative(realRoot, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return vscode.Uri.joinPath(root, ...rel.split(path.sep));
    }
    return undefined;
  }

  /** Drops a file's own-save entry (only `entry`, when given), waking anything waiting on it. */
  private forgetOwnSave(key: string, entry = this.ownSaves.get(key)): void {
    if (!entry || this.ownSaves.get(key) !== entry) return;
    this.ownSaves.delete(key);
    entry.resolve();
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
    const event = changeEvent(uri, relPath, kind, before, after, eol, writtenAt, this.scopeOf(uri)?.key);
    if (this.recordRename(event, writtenAt)) return;
    this.note(`recorded ${kind} ${relPath}`);
    this.reorder.add(event, writtenAt, event.uri);
  }

  /**
   * Records a create from nothing, or a delete to nothing, together with the
   * other half of its rename when that is still held: a delete in the reorder
   * buffer or held in a chosen worktree for a create, a create in the reorder
   * buffer for a delete. True when it did. The rename keeps the later of the
   * two write times, so it stays after earlier changes to the old path. A
   * held half with a later change of its file held too is left alone: the
   * rename would go out after that change. With `root`, only a create in
   * that recorded root pairs.
   */
  private recordRename(event: NewChangeEvent, key: number, root?: string): boolean {
    const isCreate = event.kind === 'create' && event.before === '';
    if (!isCreate && !(event.kind === 'delete' && event.after === '')) return false;
    const text = isCreate ? event.after : event.before;
    const rootOf = (uri: string) => this.scopeOf(vscode.Uri.parse(uri))?.root.toString();
    // A create in a chosen worktree shows that checkout is not being removed.
    const createRoot = isCreate ? rootOf(event.uri) : undefined;
    const heldDeletes = [...this.heldDeletes.values()]
      .filter((h) => createRoot !== undefined && h.root === createRoot && h.session === this.session)
      .map((h) => ({ held: h, relPath: h.relPath, text: h.before.text, key: h.order.key() }));
    let heldDelete: HeldDelete | undefined;
    const taken = this.reorder.take((items) => {
      const perFile = new Map<string, number>();
      for (const { item } of items) perFile.set(item.uri, (perFile.get(item.uri) ?? 0) + 1);
      const halves = items
        .filter(({ item }) => (isCreate ? item.kind === 'delete' && item.after === '' : item.kind === 'create' && item.before === ''))
        // Only within one lane: a file never moves between checkouts.
        .filter(({ item }) => perFile.get(item.uri) === 1 && item.lane === event.lane && (root === undefined || rootOf(item.uri) === root))
        .map(({ item, key }) => ({ item, relPath: item.relPath, text: isCreate ? item.before : item.after, key }));
      const pick = pickRenamePartner<{ relPath: string; text: string; key: number; item?: NewChangeEvent; held?: HeldDelete }>(
        text,
        event.relPath,
        key,
        [...halves, ...heldDeletes],
      );
      heldDelete = pick?.held;
      return pick?.item;
    });
    let from: { uri: string; relPath: string; before: string };
    let to: NewChangeEvent;
    let partnerKey: number;
    if (taken) {
      from = isCreate ? taken.item : event;
      to = isCreate ? event : taken.item;
      partnerKey = taken.key;
    } else if (heldDelete) {
      this.heldDeletes.delete(heldDelete.uri.toString());
      from = { uri: heldDelete.uri.toString(), relPath: heldDelete.relPath, before: heldDelete.before.text };
      to = event;
      partnerKey = heldDelete.order.key();
    } else {
      return false;
    }
    const writtenAt = Math.max(key, partnerKey);
    const { added, removed } = countChanges(from.before, to.after);
    const rename: NewChangeEvent = {
      uri: to.uri,
      relPath: to.relPath,
      fromUri: from.uri,
      fromRelPath: from.relPath,
      time: writtenAt,
      kind: 'rename',
      before: from.before,
      after: to.after,
      eol: to.eol,
      linesAdded: added,
      linesRemoved: removed,
      ...(to.lane !== undefined && { lane: to.lane }),
    };
    this.note(`recorded rename ${from.relPath} -> ${to.relPath}`);
    this.reorder.add(rename, writtenAt, rename.uri);
    // Ended after the rename is added, so changes it held back stay behind it.
    heldDelete?.done();
    return true;
  }

  /** Undefined for binary, oversized, or unreadable files; `onError` hears why a read failed. */
  private async readText(
    uri: vscode.Uri,
    s: Settings,
    knownSize?: number,
    onError?: (err: unknown) => void,
  ): Promise<Snapshot | undefined> {
    try {
      const size = knownSize ?? (await vscode.workspace.fs.stat(uri)).size;
      if (size > s.maxFileSizeKB * 1024) return undefined;
      return await this.decode(await vscode.workspace.fs.readFile(uri), s, uri);
    } catch (err) {
      onError?.(err);
      return undefined;
    }
  }

  /**
   * Decodes the bytes of the file at `uri` into a snapshot, in the encoding
   * the editor reads it with, so an editor save compares equal; undefined for
   * binary or oversized content.
   */
  private async decode(bytes: Uint8Array, s: Settings, uri: vscode.Uri): Promise<Snapshot | undefined> {
    if (bytes.byteLength > s.maxFileSizeKB * 1024) return undefined;
    const text = await decodeAs(bytes, uri);
    if (text === undefined || isBinaryText(text)) return undefined;
    return { text: normalizeEol(text), eol: detectEol(text) };
  }
}

/** A recorded change, keyed for the reorder buffer by `writtenAt`, which becomes its time. */
function changeEvent(
  uri: vscode.Uri,
  relPath: string,
  kind: ChangeKind,
  before: string,
  after: string,
  eol: Eol,
  writtenAt: number,
  lane: string | undefined,
): NewChangeEvent {
  const { added, removed } = countChanges(before, after);
  return { uri: uri.toString(), relPath, time: writtenAt, kind, before, after, eol, linesAdded: added, linesRemoved: removed, ...(lane !== undefined && { lane }) };
}

/** What the latest editor save of a file wrote. `done` once did-save has fired. */
interface OwnSave {
  text: string;
  settled: Promise<void>;
  resolve: () => void;
  done: boolean;
  /** When will-save (or, without one, did-save) fired. */
  startedAt: number;
}

/** Watcher events for one file merged by the debounce timer. */
interface Burst {
  timer: NodeJS.Timeout;
  created: boolean;
  /** A delete event arrived at some point in this burst. */
  sawDelete: boolean;
  /** When the first delete event since the latest create or change arrived. */
  deletedAt: number | undefined;
  /** When the first and latest watcher events of this burst arrived. */
  firstArrival: number;
  lastArrival: number;
  /** The recording session the burst belongs to. */
  session: number;
  /** Tells the reorder buffer this burst has been read. */
  done: () => void;
  /** Its read ended in a held delete, which calls `done` once decided. */
  held?: boolean;
}

/** A file deleted in a chosen worktree, waiting to see whether the whole checkout is going away. */
interface HeldDelete {
  uri: vscode.Uri;
  relPath: string;
  before: Snapshot;
  /** Keeps later changes back until it is decided; its key is the delete's place in write order. */
  order: OrderHold;
  /** Key of the scope it was deleted in. */
  scopeKey: string;
  /** The recorded root it was deleted from; recording another drops it. */
  root: string;
  session: number;
  done: () => void;
}

/**
 * Where the checkout chosen for each folder is remembered, keyed by folder
 * URI, and the display label each chosen worktree was given, by its `pathKey`.
 * Folder prefixes are kept as labels too, under FOLDER_PREFIXES by folder URI.
 * Without the label methods, labels last for the session.
 */
export interface CheckoutChoices {
  /** A single checkout chosen in place of the folder's own, as stored before lanes. */
  get(folderKey: string): string | undefined;
  set(folderKey: string, worktreePath: string | undefined): unknown;
  /** Every checkout chosen for the folder; undefined when nothing was chosen. Without it, sets last for the session. */
  getSet?(folderKey: string): string[] | undefined;
  setSet?(folderKey: string, paths: readonly string[] | undefined): unknown;
  /** The followed lane and lane colors; without them, they last for the session. */
  readonly followed?: string | undefined;
  setFollowed?(lane: string | undefined): unknown;
  colorOf?(checkoutKey: string): number | undefined;
  setColor?(checkoutKey: string, slot: number): unknown;
  labelsOf?(folderKey: string): ReadonlyMap<string, string>;
  setLabel?(folderKey: string, worktreeKey: string, label: string): unknown;
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
  /** The folder has no checkout of its own: it holds a bare repository's worktrees. */
  container: boolean;
  /** How many checkouts the folder records. */
  lanes: number;
  /** Lane id of this checkout. */
  lane: string;
}

export interface FolderCheckouts {
  worktrees: Worktree[];
  own: Worktree | undefined;
  /** Path of the remembered single choice from before lanes, undefined otherwise. */
  chosen: string | undefined;
  /** Paths of every checkout the folder records, or would record when started; its own by its path. */
  recorded: string[];
}

/** One checkout a workspace folder records: one lane. */
interface Scope {
  /**
   * Lane id, and the key of every per-scope map: the folder URI for the
   * folder's own checkout (or the folder itself), the folder URI and the
   * checkout's `pathKey` for another worktree.
   */
  key: string;
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
  /** Worktrees the repository has, not counting ones being removed. */
  worktrees: number;
  /** git lists worktrees, but none is the folder's own: it holds a bare repository's worktrees. */
  container: boolean;
  /** The chosen worktree is being removed: git still lists it, but its `.git` is gone. */
  prunable: boolean;
  /** `pathKey` of the repository's common git directory, which a linked worktree's `.git` file points into. */
  commonKey: string | undefined;
  /** That common git directory as it is on disk, for watching: VS Code reports paths in their real case. */
  commonDir: string | undefined;
  /** `provisionalSeq` when the worktree listing this scope came from started. */
  listedAt: number;
  watcher: vscode.Disposable[];
}

/** A folder's `files.watcherExclude`: all of it for the folder's own checkout, the `**` globs for a chosen worktree. */
interface WatcherExcludes {
  own: RootGlobs;
  anywhere: RootGlobs;
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
  /** Set when a baseline capture took it: when, and the file's mtime then. */
  captured?: { at: number; mtime: number };
}

async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/**
 * True when each directory from `root` down lists the next name of the path
 * with the same case, not just one a case-insensitive filesystem also finds,
 * so a case-only rename of the file or of a directory above it shows.
 */
async function existsExactly(uri: vscode.Uri, root: vscode.Uri | undefined): Promise<boolean> {
  let dir = root && isUnder(root, uri) ? root : vscode.Uri.joinPath(uri, '..');
  const names = uri.path.slice(dir.path.replace(/\/+$/, '').length + 1).split('/');
  for (const name of names) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return true;
    }
    if (!entries.some(([n]) => n === name || n.normalize() === name.normalize())) return false;
    dir = vscode.Uri.joinPath(dir, name);
  }
  return true;
}

/** A URI string as compared for containment: case is ignored on Windows, as in `isUnder`. */
function foldKey(key: string): string {
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** Path used for filtering: relative to its workspace folder, so globs like src/** work in every folder. */
export function relPathOf(uri: vscode.Uri): string {
  return toSlashes(vscode.workspace.asRelativePath(uri, false));
}

/** True when `uri` is strictly inside `root`. Case is ignored on Windows. */
function isUnder(root: vscode.Uri, uri: vscode.Uri): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(uri.path).startsWith(fold(root.path.replace(/\/+$/, '')) + '/');
}

/** `workspace.decode` (VS Code 1.100+): the editor's own decoding, by the file's settings and content. */
type WorkspaceDecode = (content: Uint8Array, options: { uri: vscode.Uri }) => Thenable<string>;

/**
 * The file's text as the editor reads it: through `workspace.decode` where
 * VS Code has it, else by byte order mark and `files.encoding`. ASCII reads
 * the same in every encoding but UTF-16, so it skips the round trip to VS Code.
 * Undefined when VS Code finds the content binary.
 */
async function decodeAs(bytes: Uint8Array, uri: vscode.Uri): Promise<string | undefined> {
  const encoding = vscode.workspace.getConfiguration('files', uri).get<string>('encoding');
  const wsDecode = (vscode.workspace as unknown as { decode?: WorkspaceDecode }).decode;
  if (!wsDecode || (isAscii(bytes) && !/^utf16/i.test(encoding ?? ''))) return decodeBytes(bytes, encoding);
  try {
    return await wsDecode(bytes, { uri });
  } catch {
    // VS Code throws for binary content.
    return undefined;
  }
}

/** False for a binary file, judged by its first bytes, or one that can't be read. Only file URIs are read; others count as text. */
async function isTextFile(uri: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') return true;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(uri.fsPath, 'r');
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return !looksBinary(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}
