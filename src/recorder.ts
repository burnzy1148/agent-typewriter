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
  checkoutKeyOfLane,
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
import { DEFAULT_TIMING, GitOperationWatch, type GitOperation } from './gitOperations';
import { ReorderBuffer, clampOrderKey, type OrderHold } from './reorder';
import { pickRenamePartner } from './renames';
import type { ChangeKind, LaneInfo, NewChangeEvent, Timeline } from './timeline';
import { colorSlot, laneLabel, MAX_LANES, MAX_WAITING, ROTATE_IDLE_MS, rotationVictim } from './lanes';
import type { Settings } from './config';
import { BRANCH_PREFIX, ignoringPattern } from './worktreeIgnore';
import { dirId, WatchGaps, type WatchDir } from './watchGaps';

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

/** Longest a write holds later changes back while a git operation settles: the lock wait plus git's own timeout for reading the result. */
const GIT_HOLD_MAX_MS = DEFAULT_TIMING.lockMaxMs + 30_000;

/** Quiet time after a git operation's last skipped write before its summary line is logged. */
const GIT_SUMMARY_DELAY_MS = 1000;

/** Longest a waiting worktree's first change holds later changes back while auto-record decides whether it gets a lane. */
const LANE_WAIT_MAX_MS = 15_000;

/** At most one write of a file per this long is passed on from our own folder watches, as VS Code's watcher merges its own. */
const GAP_MERGE_MS = 50;
/** How much earlier than its true time a birth time can read: a clock tick, and some. */
const BIRTH_SLACK_MS = 50;

/** Whether a git operation made a write, and the place in write order held while that took a wait. */
interface GitVerdict {
  op?: GitOperation;
  /** The write time to record the change at. */
  key(): number;
  /** Lets later changes go; call once the change is recorded or skipped. */
  end(): void;
}

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
  /** New worktrees the last auto-record pass found `git worktree add` still checking out, not yet decided. */
  private creating: string[] = [];
  /** Lane keys of checkouts auto-record added this session and the user has not picked by hand since; per folder, as lanes are. */
  private readonly autoAdded = new Set<string>();
  /**
   * New worktrees auto-record watches without a lane until they record a
   * change, by the lane key they would get, with their folder and checkout
   * path. Never saved: after a restart they are no longer new.
   */
  private readonly waiting = new Map<string, { folderKey: string; checkout: string; since: number; remade?: boolean; gitFile?: string }>();
  /** Lane keys of waiting worktrees this refresh found removed and made again: their watchers and held deletes are the old checkout's. */
  private readonly remade = new Set<string>();
  /** Lane keys of waiting worktrees whose first change asks auto-record for a lane. */
  private readonly firstChanges = new Set<string>();
  /** Per waiting worktree's lane key, the decision its first change waits on: true once it records as a lane. */
  private readonly laneAsks = new Map<string, Promise<boolean>>();
  /** Changes of waiting worktrees held until that decision. */
  private waitingChanges = 0;
  /** Display labels of waiting worktrees, by lane key: saved only once one gets a lane. */
  private readonly waitingLabels = new Map<string, string>();
  /** Branch each lane's checkout last had while recording this session, for `autoIgnored`. */
  private readonly laneBranches = new Map<string, string | undefined>();
  /** While auto-record is on, a watcher per recorded repository's common git directory, by its key. */
  private readonly commonWatchers = new Map<string, { dir: string; glob: string; subs: vscode.Disposable[] }>();
  /** Git operation tracking per recorded checkout (scope key) while `ignoreGitOperations` is on. */
  private readonly gitWatches = new Map<string, GitOperationWatch>();
  /** Pending summary lines of git operations whose writes were skipped. */
  private readonly gitSummaries = new Map<GitOperation, { timer: ReturnType<typeof setTimeout>; lane: string; quiet: boolean }>();
  /** Set once the output channel said git operations are recorded because git could not run. */
  private gitOpsOffNoted = false;
  /** Git problems already logged, per watch, so each is said once. */
  private readonly gitProblemsNoted = new WeakMap<GitOperationWatch, string>();
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
  /** Directories VS Code's watcher cannot see into, watched one by one; only where a WatchDir is given. */
  private readonly gaps: WatchGaps | undefined;
  /** Events of those watches, handled in the order they came, so a file's create is known before its write. */
  private gapEvents: Promise<void> = Promise.resolve();
  /** Writes those watches reported, by file, waiting GAP_MERGE_MS for more of the same. */
  private readonly gapWrites = new Map<string, NodeJS.Timeout>();
  /** Events of those watches queued, and handled, so far. */
  private gapsQueued = 0;
  private gapsHandled = 0;
  /** How many of those events were queued when the directories waiting for a sweep of deletes began to gather: it waits for them. */
  private sweepAfter = 0;
  /** Known directories to check again, by path, with whether VS Code's watcher reported them; checked together after GAP_MERGE_MS. */
  private readonly recheckDirs = new Map<string, { uri: vscode.Uri; reported: boolean }>();
  private recheckTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly timeline: Timeline,
    private readonly settings: () => Settings,
    private readonly log: vscode.OutputChannel,
    private readonly choices: CheckoutChoices = new Map<string, string>(),
    /** How a folder's worktrees are listed; tests replace it to make git fail. */
    private readonly listWorktreesIn: (folder: string) => Promise<WorktreeListResult> = (folder) => listWorktrees(folder),
    /** Watches a directory VS Code's watcher misses, where it can miss them (Linux). */
    watchDir?: WatchDir,
  ) {
    this.gaps =
      watchDir &&
      new WatchGaps(
        watchDir,
        (dir, name, kind) => this.gapEntry(dir, name, kind),
        (line) => this.log.appendLine(line),
        (key) => this.timeline.laneInfo(key)?.label ?? this.scopes.get(key)?.name ?? key,
      );
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

  /** Every lane recording while running, in folder order; not new worktrees still waiting for their first change. */
  recordedLanes(): Array<{ lane: string; folder: vscode.WorkspaceFolder; checkout: string; own: boolean; name: string; label: string }> {
    return this.laneScopes().map((s) => ({
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
    // A pick by hand: nothing the folder records is auto-record's any more.
    for (const lane of [...this.autoAdded]) if (lane.startsWith(`${key}\0`)) this.autoAdded.delete(lane);
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
    // A checkout ticked or cleared by hand is no longer auto-record's to stop; ones left as they were keep how they came.
    const before = new Set((await this.recordedPaths(folder)).map((p) => laneKey(key, false, p)));
    const after = new Set(unique.map((p) => laneKey(key, false, p)));
    for (const lane of [...before, ...after]) if (before.has(lane) !== after.has(lane)) this.autoAdded.delete(lane);
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

  /** The scopes recording checkouts of one folder, each in its lane. */
  private scopesOf(folderKey: string): Scope[] {
    return this.laneScopes().filter((s) => s.folder.uri.toString() === folderKey);
  }

  /** The scopes that record in a lane: all but new worktrees waiting for their first change. */
  private laneScopes(): Scope[] {
    return [...this.scopes.values()].filter((s) => !s.waiting);
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
      `debouncing: ${debouncing.length > 0 ? debouncing.join(', ') : 'none'}; reading: ${this.flushes.size}; waiting for a lane: ${this.waitingChanges}; ` +
        `held for reordering: ${this.reorder.size}; deletes held: ${this.heldDeletes.size}`,
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
    this.gitOpsOffNoted = false;
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
    this.gaps?.closeAll();
    for (const t of this.gapWrites.values()) clearTimeout(t);
    this.gapWrites.clear();
    clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.recheckDirs.clear();
    const lanes = this.laneScopes().map((s) => s.key);
    this.scopes.clear();
    this.capNoted = '';
    this.listings.clear();
    this.knownWorktrees.clear();
    this.initWaits.clear();
    this.creating = [];
    this.autoAdded.clear();
    // Their held first changes see the new session and are dropped.
    this.waiting.clear();
    this.remade.clear();
    this.waitingLabels.clear();
    this.firstChanges.clear();
    this.laneAsks.clear();
    for (const w of this.commonWatchers.values()) for (const d of w.subs) d.dispose();
    this.commonWatchers.clear();
    void this.syncGitWatches();
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
    this.flushGitSummaries();
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
      this.dropUnwatched();
      await this.captureBaseline();
      this.log.appendLine(`${reason}: watching ${this.watchedCount} files (${this.describeFilter()}).`);
      this.note(`${reason.toLowerCase()}: watching ${this.watchedCount} files`);
    });
    this.filterWork = work.catch(() => {});
    return work;
  }

  /** Forgets baselines and saves of files no longer recorded, so one recorded again later gets a fresh baseline. */
  private dropUnwatched(): void {
    for (const store of [this.snapshots, this.gitBaselines, this.ownSaves]) {
      for (const key of [...store.keys()]) {
        if (!this.passes(vscode.Uri.parse(key))) store.delete(key);
      }
    }
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

  /** Starts or stops following git operations after `ignoreGitOperations` changes. */
  refreshGitOperations(): Promise<void> {
    return this.syncGitWatches();
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
      // Before auto-record may stop a lane for its new branch, so auto-follow sees that branch too.
      for (const s of all) if (!s.own && !s.waiting) this.laneBranches.set(s.key, s.branch);
      if (await this.autoRecord(all)) {
        all = [];
        for (const folder of folders) all.push(...(await this.resolveScopes(folder)));
        if (stale()) return;
      }
      // Only by default can more than MAX_LANES come up: one per folder in a large multi-root workspace.
      // New worktrees waiting for their first change have no lane, so they never count.
      const lanes = all.filter((s) => !s.waiting);
      const left = lanes.slice(MAX_LANES).map((s) => (s.own ? s.folder.name : `${s.folder.name} (${s.name})`));
      if (left.join('\0') !== this.capNoted && left.length > 0) {
        this.log.appendLine(`At most ${MAX_LANES} checkouts record at once; not recording ${left.join(', ')}.`);
      }
      this.capNoted = left.join('\0');
      const next = new Map([...lanes.slice(0, MAX_LANES), ...all.filter((s) => s.waiting)].map((s) => [s.key, s]));
      for (const [key, old] of this.scopes) {
        const fresh = next.get(key);
        // A worktree made again at the same path starts over: the old checkout's watcher and held deletes go.
        if (fresh && fresh.root.toString() === old.root.toString() && !this.remade.has(key)) fresh.watcher = old.watcher;
        else {
          for (const d of old.watcher) d.dispose();
          this.gaps?.release(key);
          this.dropHeldDeletes(key);
        }
      }
      this.remade.clear();
      for (const key of this.provisional.keys()) if (!next.has(key)) this.provisional.delete(key);
      for (const key of this.goneRefreshed.keys()) if (!next.has(key)) this.goneRefreshed.delete(key);
      // Worktrees nested in a recorded root are skipped there and named. A new one auto-record will decide (still
      // being checked out) or that waits for its first change is named once, as it starts waiting.
      const unnamed = [...[...this.scopes.values(), ...next.values()].filter((s) => s.waiting).map((s) => s.checkout.fsPath), ...this.creating];
      const skipped = (s: Scope | undefined) => (s ? s.nestedDirs.filter((d) => !unnamed.some((w) => `${relativeInside(s.root.fsPath, w)}/` === d)) : []);
      for (const [key, scope] of next) {
        const old = this.scopes.get(key);
        this.carryProvisional(key, scope);
        if (scope.watcher.length === 0) scope.watcher = this.watch(scope);
        if (!scope.own && !scope.waiting && (old?.root.toString() !== scope.root.toString() || old.waiting)) {
          this.log.appendLine(`Recording ${scope.folder.name} from checkout ${scope.name} (${scope.root.fsPath}).`);
        }
        if (scope.container && scope.own && !(old?.container && old.own)) {
          this.log.appendLine(
            `${scope.folder.name} has no checkout of its own, so its worktrees are skipped; run Agent Typewriter: Choose Checkout to record one.`,
          );
        }
        const shown = skipped(scope);
        if (shown.join('\0') !== skipped(old).join('\0') && shown.length > 0) {
          this.log.appendLine(`Skipping ${shown.length} other worktree(s) in ${scope.folder.name}: ${shown.join(', ')}`);
        }
      }
      const gone = this.laneScopes()
        .map((s) => s.key)
        .filter((key) => next.get(key)?.waiting !== false);
      const roots = new Set([...next.values()].map((s) => s.root.toString()));
      const unrecorded = [...this.scopes.values()].filter((s) => !s.own && !roots.has(s.root.toString()));
      this.scopes.clear();
      for (const [key, scope] of next) this.scopes.set(key, scope);
      // Once git no longer lists a worktree, its paths fall to the folder around it, where its files'
      // baselines would pass: forget them, so one made at the same path again starts from its own text.
      if (unrecorded.length > 0) this.forgetUnder(unrecorded.map((s) => s.root));
      for (const [key, scope] of next) if (!scope.own && !scope.waiting) this.laneBranches.set(key, scope.branch);
      for (const lane of gone) this.timeline.setLaneRecording(lane, false);
      for (const scope of this.laneScopes()) this.defineLane(scope);
      this.followFirstLane();
      this.watchCommonDirs();
      await this.syncGitWatches();
      if (stale()) return;
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
      branch: undefined,
      nested: new IgnoredPaths(),
      nestedDirs: [],
      repo: false,
      worktrees: 0,
      container: false,
      prunable: false,
      waiting: false,
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
        // New worktrees waiting for their first change keep waiting too.
        const waiting = [...this.scopes.values()].filter((s) => s.waiting && s.folder.uri.toString() === key);
        this.listFailing.add(key);
        if (!noted) this.log.appendLine(`Could not re-read the worktrees of ${folder.name} (${r.reason}); keeping its current checkout until git answers.`);
        const have = current.map((c) => pathKey(c.checkout.fsPath)).sort().join('\0');
        const want = choice?.map(pathKey).sort().join('\0');
        if (want === undefined ? current.some((c) => !c.own) : want !== have) {
          this.log.appendLine(`The checkout chosen for ${folder.name} applies once git can list its worktrees.`);
        }
        return [...current, ...waiting].map((c) => ({ ...c, folder }));
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
      scopes.push(await this.worktreeScope(scope, chosen, root, r.worktrees, false));
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
    // New worktrees auto-record watches until their first change. One git no longer lists, or that is
    // being removed, gets no scope, and autoRecord forgets it without a word.
    for (const [lane, w] of this.waiting) {
      if (w.folderKey !== key || scopes.some((s) => s.key === lane)) continue;
      const listed = r.worktrees.find((x) => pathKey(x.path) === pathKey(w.checkout));
      const root = listed && !listed.prunable ? rootIn(listed, own, folder.uri.fsPath) : undefined;
      if (!listed || !root || !(await stat(vscode.Uri.file(root)))) continue;
      // Removed and added again at the same path between two listings: its baselines and any change
      // read meanwhile are the old checkout's or git's. Forgotten, and no longer known, it is new again.
      const gitFile = await gitFileId(listed.path);
      if (w.gitFile !== undefined && gitFile !== undefined && gitFile !== w.gitFile) {
        this.forgetUnder([rootUri(folder, root)]);
        this.remade.add(lane);
        this.knownWorktrees.get(key)?.delete(pathKey(listed.path));
        // Its new baselines come with the next full refresh.
        this.scheduleWorktreeRefresh();
        continue;
      }
      w.gitFile ??= gitFile;
      scopes.push(await this.worktreeScope(scope, listed, root, r.worktrees, true));
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

  /** The scope of another worktree of the folder whose own scope is `base`, recording `root` inside it. */
  private async worktreeScope(base: Scope, worktree: Worktree, root: string, worktrees: Worktree[], waiting: boolean): Promise<Scope> {
    const folder = base.folder;
    return {
      ...base,
      key: laneKey(base.key, false, worktree.path),
      root: rootUri(folder, root),
      checkout: vscode.Uri.file(worktree.path),
      own: false,
      container: false,
      prunable: !!worktree.prunable,
      waiting,
      // A waiting worktree's is kept for the session only, until it gets a lane, so its first change has the paths its lane's later ones do.
      label: await this.labelFor(folder, worktree, worktrees.filter((w) => !w.prunable || w === worktree), !waiting),
      name: checkoutName(worktree),
      branch: worktree.branch,
      watcher: [],
    };
  }

  /**
   * Decides for new worktrees as `autoRecordWorktrees` allows. One that
   * appeared since the last listing waits, watched but without a lane, until
   * it records a change; at most MAX_WAITING wait at once. Its first change
   * gives it a lane while there is room, or (rotate) in place of the lane
   * idle longest; otherwise it is not recorded. Worktrees there at the first
   * listing after start are not new. True when a folder's chosen checkouts or
   * the waiting worktrees changed.
   */
  private async autoRecord(scopes: Scope[]): Promise<boolean> {
    const { autoRecordWorktrees: mode, autoIgnoreWorktrees: patterns } = this.settings();
    const fresh: Array<{ folder: vscode.WorkspaceFolder; worktree: Worktree; root: string }> = [];
    const creating: string[] = [];
    // A lock left by a `git worktree add` that died never goes; after a while the worktree is taken as it is.
    const stillInitializing = (w: Worktree) => initializing(w) && (this.initWaits.get(pathKey(w.path)) ?? 0) < INIT_RETRIES;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      const listed = this.listings.get(key);
      if (!listed) continue;
      const known = this.knownWorktrees.get(key);
      // One `git worktree add` is still checking out stays new until it is done, so it is decided then.
      // Everything in the first listing after start was there before: locked ones too (`git worktree lock`).
      const settled = known ? listed.filter((w) => !stillInitializing(w) || known.has(pathKey(w.path))) : listed;
      this.knownWorktrees.set(key, new Set(settled.map((w) => pathKey(w.path))));
      if (!known || mode === 'off') continue;
      for (const w of listed) {
        if (w.prunable || known.has(pathKey(w.path)) || scopes.some((s) => pathKey(s.checkout.fsPath) === pathKey(w.path))) continue;
        if (stillInitializing(w)) {
          creating.push(w.path);
          this.initWaits.set(pathKey(w.path), (this.initWaits.get(pathKey(w.path)) ?? 0) + 1);
          continue;
        }
        // Listed by several folders (worktrees of one repository): it waits in the first that would record
        // this part of it. Folders that are different subdirectories of the repository each wait for theirs.
        const root = pathKey(rootIn(w, ownCheckout(folder.uri.fsPath, listed), folder.uri.fsPath));
        if (fresh.some((f) => f.root === root)) continue;
        // Known from now on, so it is decided once: it never takes a lane's place or counts toward the cap.
        const pattern = ignoringPattern(patterns, w.path, w.branch);
        if (pattern !== undefined) this.log.appendLine(`The new worktree ${checkoutName(w)} (${w.path}) is not recorded: it matches autoIgnoreWorktrees pattern ${pattern}.`);
        else fresh.push({ folder, worktree: w, root });
      }
    }
    // Git removes the lock once the files are out; the watcher sees that, and this looks again in case it does not.
    this.creating = creating;
    if (creating.length > 0) this.scheduleWorktreeRefresh(INIT_RETRY_MS);
    let waitingChanged = false;
    // A waiting worktree stops waiting once auto-record is off, once it got no waiting scope (it is gone, or
    // the user ticked it), or once it matches a pattern. Only the last says so: it is the one worth a line.
    for (const [lane, w] of this.waiting) {
      const scope = mode === 'off' ? undefined : scopes.find((s) => s.key === lane && s.waiting);
      const pattern = scope && ignoringPattern(patterns, scope.checkout.fsPath, scope.branch);
      if (scope && pattern === undefined) continue;
      this.waiting.delete(lane);
      this.waitingLabels.delete(lane);
      waitingChanged = true;
      if (scope) this.log.appendLine(`Stopped watching the new worktree ${scope.name} (${w.checkout}): it matches autoIgnoreWorktrees pattern ${pattern}.`);
    }
    // What records once each decision is applied.
    const recording = scopes.filter((s) => !s.waiting).slice(0, MAX_LANES);
    let lanes = recording.map((s) => ({ key: s.key, folderKey: s.folder.uri.toString(), checkout: s.checkout.fsPath, name: s.name || s.folder.name, added: false }));
    const pathsOf = (folderKey: string) => lanes.filter((l) => l.folderKey === folderKey).map((l) => l.checkout);
    /** What this pass adds and stops, per folder; saved on top of the folder's latest choice. */
    const added = new Map<string, string[]>();
    const stopped = new Map<string, string[]>();
    const note = (map: Map<string, string[]>, folderKey: string, p: string) => map.set(folderKey, [...(map.get(folderKey) ?? []), p]);
    // A lane auto-record added stops once it matches a pattern: a branch switch, or a pattern added since. Picked by hand, it stays.
    for (const s of recording) {
      if (s.own || !this.autoAdded.has(s.key)) continue;
      const pattern = ignoringPattern(patterns, s.checkout.fsPath, s.branch);
      const lane = lanes.find((l) => l.key === s.key);
      // A folder's last lane never goes: a folder always records something.
      if (pattern === undefined || !lane || pathsOf(lane.folderKey).length < 2) continue;
      lanes = lanes.filter((l) => l !== lane);
      this.autoAdded.delete(s.key);
      note(stopped, lane.folderKey, lane.checkout);
      this.log.appendLine(`Stopped recording ${lane.name} (${lane.checkout}): it matches autoIgnoreWorktrees pattern ${pattern}.`);
    }
    // Waiting worktrees that recorded their first change: each gets a lane now, if there is room or rotation makes some.
    const asking = scopes.filter((s) => s.waiting && this.firstChanges.has(s.key) && this.waiting.has(s.key));
    this.firstChanges.clear();
    for (const scope of asking) {
      // Decided once, either way: a worktree refused here is not watched any more and stays known.
      this.waiting.delete(scope.key);
      waitingChanged = true;
      const folderKey = scope.folder.uri.toString();
      const name = `${scope.name} (${scope.checkout.fsPath})`;
      const refuse = (why: string) => {
        this.waitingLabels.delete(scope.key);
        this.log.appendLine(`The new worktree ${name} is not recorded: ${why}`);
      };
      if (lanes.length >= MAX_LANES) {
        if (mode !== 'rotate') {
          refuse(`at most ${MAX_LANES} checkouts record at once.`);
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
          refuse(
            candidates.length === 0
              ? "every lane is its folder's only one, and a folder always records one."
              : `every lane but the followed one changed in the last ${ROTATE_IDLE_MS / 60_000} minutes.`,
          );
          continue;
        }
        lanes = lanes.filter((l) => l !== victim);
        note(stopped, victim.folderKey, victim.checkout);
        this.log.appendLine(`Stopped recording ${victim.name}, idle longest, to record the new worktree ${name}.`);
      } else {
        this.log.appendLine(`Recording the new worktree ${name} in its own lane.`);
      }
      lanes.push({ key: scope.key, folderKey, checkout: scope.checkout.fsPath, name: scope.name, added: true });
      note(added, folderKey, scope.checkout.fsPath);
    }
    // New worktrees wait for their first change, after the decisions above have made room among those waiting.
    for (const { folder, worktree } of fresh) {
      const name = `${checkoutName(worktree)} (${worktree.path})`;
      if (this.waiting.size >= MAX_WAITING) {
        this.log.appendLine(`The new worktree ${name} is not recorded: ${MAX_WAITING} new worktrees already wait for their first change.`);
        continue;
      }
      const folderKey = folder.uri.toString();
      const lane = laneKey(folderKey, false, worktree.path);
      this.waiting.set(lane, { folderKey, checkout: worktree.path, since: Date.now(), ...(this.remade.has(lane) && { remade: true }) });
      waitingChanged = true;
      this.log.appendLine(`Watching the new worktree ${name}; it gets its own lane once it records a change.`);
    }
    const touched = new Set([...added.keys(), ...stopped.keys()]);
    for (const folderKey of touched) {
      // The choice may have changed while git listed worktrees (a box ticked or cleared): build on that, not on what this pass read.
      const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.toString() === folderKey);
      const ownPath = scopes.find((s) => s.own && s.folder.uri.toString() === folderKey)?.checkout.fsPath ?? folder?.uri.fsPath ?? '';
      const base = this.chosenSet(folderKey) ?? (folder ? this.defaultPaths(folder, ownPath) : pathsOf(folderKey));
      const gone = new Set((stopped.get(folderKey) ?? []).map(pathKey));
      const kept = base.filter((p) => !gone.has(pathKey(p)));
      // One ticked by hand while git listed worktrees is the user's, not auto-record's.
      const newPaths = (added.get(folderKey) ?? []).filter((p) => !kept.some((k) => pathKey(k) === pathKey(p)));
      for (const p of newPaths) this.autoAdded.add(laneKey(folderKey, false, p));
      const next = [...kept, ...newPaths];
      const unsaved = await this.saveChoiceSet(folderKey, next);
      if (unsaved) this.log.appendLine(`Could not save the checkouts recorded: ${unsaved.message}`);
    }
    return touched.size > 0 || waitingChanged;
  }

  /**
   * True when auto-follow should leave this lane alone: it is another
   * worktree's (never a folder's own checkout) and matches
   * `autoIgnoreWorktrees`, by its path, or by the branch it last had while
   * recording this session. A lane from a loaded session has only its path,
   * which its id carries.
   */
  autoIgnored(lane: Pick<LaneInfo, 'id'>): boolean {
    const key = checkoutKeyOfLane(lane.id);
    if (key === undefined) return false;
    // Not `root`: for a nested workspace folder that is below the checkout.
    const checkout = this.scopes.get(lane.id)?.checkout.fsPath ?? key;
    return ignoringPattern(this.settings().autoIgnoreWorktrees, checkout, this.laneBranches.get(lane.id)) !== undefined;
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
    const { autoRecordWorktrees, autoIgnoreWorktrees } = this.settings();
    // A branch pattern needs branch switches seen, which rewrite a worktree's HEAD; otherwise commits in a detached one would refresh for nothing.
    const branches = autoIgnoreWorktrees.some((p) => p.trim().startsWith(BRANCH_PREFIX));
    // A new worktree's directory, and the lock `git worktree add` holds until its files are checked out.
    // HEAD on its own is the main worktree's, which a non-own lane may record too.
    const glob = branches ? '{worktrees/*,worktrees/*/locked,worktrees/*/HEAD,HEAD}' : '{worktrees/*,worktrees/*/locked}';
    const want = new Map<string, string>();
    if (autoRecordWorktrees !== 'off' || branches) for (const s of this.scopes.values()) if (s.commonKey && s.commonDir) want.set(s.commonKey, s.commonDir);
    for (const [key, w] of this.commonWatchers) {
      if (want.get(key) === w.dir && w.glob === glob) continue;
      for (const d of w.subs) d.dispose();
      this.commonWatchers.delete(key);
    }
    for (const [key, dir] of want) {
      if (this.commonWatchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
      const subs: vscode.Disposable[] = [watcher];
      watcher.onDidCreate(() => this.scheduleWorktreeRefresh(), null, subs);
      watcher.onDidDelete(() => this.scheduleWorktreeRefresh(), null, subs);
      // Git rewrites HEAD in place. A changed worktree directory is just a write inside it, which says nothing about worktrees.
      if (branches) watcher.onDidChange((uri) => uri.path.endsWith('/HEAD') && this.scheduleWorktreeRefresh(), null, subs);
      this.commonWatchers.set(key, { dir, glob, subs });
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
    const lanes = this.laneScopes().map((s) => s.key);
    if (remembered !== undefined && lanes.includes(remembered)) {
      this.timeline.follow(remembered);
      return;
    }
    // Queued changes in the followed lane, such as a restored timeline's, keep it followed.
    if (this.timeline.pendingCount() > 0) return;
    const followed = this.timeline.followed;
    const lane = lanes.includes(followed) ? followed : lanes[0];
    if (lane !== undefined) this.timeline.follow(lane);
  }

  /**
   * The display label of a chosen worktree: the one it was given before, so
   * its files keep their mirrors while other worktrees come and go, or a new
   * one. A new label is unique among the folder's labels and never names a
   * top-level entry of the folder other than a worktree, so the folder's own
   * files can't share its display paths. A remembered label is checked
   * against those entries once per session, the first time it is used.
   * Without `keep`, a new label is given for the session only: a worktree
   * waiting for its first change leaves no label behind unless it gets a lane.
   */
  private async labelFor(folder: vscode.WorkspaceFolder, chosen: Worktree, worktrees: Worktree[], keep = true): Promise<string> {
    const folderKey = folder.uri.toString();
    const chosenKey = pathKey(chosen.path);
    const checked = `${folderKey}\0${chosenKey}`;
    const waiting = [...this.waitingLabels].filter(([k]) => k.startsWith(`${folderKey}\0`)).map(([k, l]) => [k.slice(folderKey.length + 1), l] as const);
    const given: ReadonlyMap<string, string> = waiting.length > 0 ? new Map([...this.labelsIn(folderKey), ...waiting]) : this.labelsIn(folderKey);
    const known = given.get(chosenKey);
    const give = (label: string): string => {
      if (!keep) this.waitingLabels.set(checked, label);
      else {
        this.waitingLabels.delete(checked);
        if (this.labelsIn(folderKey).get(chosenKey) !== label) this.rememberLabel(folderKey, chosenKey, label);
      }
      return label;
    };
    if (known !== undefined && this.labelsChecked.has(checked)) return give(known);
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
      if (!taken.includes(known)) return give(known);
      this.log.appendLine(`${folder.name} now has its own ${known}, so checkout ${chosen.path} gets a new display name.`);
    }
    const others = [...given].filter(([k]) => k !== chosenKey);
    const listed = new Map(worktrees.flatMap((w) => others.filter(([k]) => k === pathKey(w.path)).map(([, l]) => [w.path, l] as const)));
    const elsewhere = others.filter(([k]) => !worktrees.some((w) => pathKey(w.path) === k)).map(([, l]) => l);
    const list = worktrees.includes(chosen) ? worktrees : [...worktrees, chosen];
    return give(worktreeLabels(list, { given: listed, taken: [...taken, ...elsewhere] }).get(chosen.path) ?? checkoutName(chosen));
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
    watcher.onDidCreate((uri) => mine(uri) && this.onWatcherEvent(key, uri, 'create'), null, subs);
    watcher.onDidChange((uri) => mine(uri) && this.onWatcherEvent(key, uri, 'change'), null, subs);
    watcher.onDidDelete((uri) => mine(uri) && this.onWatcherEvent(key, uri, 'delete'), null, subs);
    return subs;
  }

  /**
   * A watcher event, or (`gap`) one of a directory only our own watch sees, for the path's scope `key`.
   * `sweep` false: a path gone that holds nothing recorded, so no pass over the baselines looks for it.
   */
  private onWatcherEvent(key: string | undefined, uri: vscode.Uri, event: 'create' | 'change' | 'delete', from: 'watcher' | 'gap' = 'watcher', sweep = true): void {
    this.noteWorktreeEvent(uri, event);
    const watches = from === 'watcher' && this.watcherWatches(uri);
    if (this.gaps && from === 'watcher' && uri.scheme === 'file' && this.running) {
      if (watches) this.gaps.seenByWatcher(uri.path.slice(0, uri.path.lastIndexOf('/')));
      // It merges a delete and a create of one path in a batch into a change, as `rm -rf dir && mkdir -p dir/...` makes
      // of dir, and it does not see into what was made in it at once. Of a directory nothing is known about, there since
      // before recording, a change of attributes (chmod, touch) is far likelier, so it is left alone.
      if (event === 'change' && this.gaps.known(uri.path)) this.queueRecheck(uri, watches);
    }
    const current = key === undefined ? undefined : this.scopes.get(key);
    if (event === 'delete' && current && !current.own) {
      // Something changed, so a refresh is worth asking for again.
      this.goneRefreshed.delete(current.key);
      this.checkCheckoutGone(current);
      // Deletes are still coming: held ones wait for them to stop.
      if (this.deleteSettles.has(current.key)) this.settleDeletes(current.key);
    }
    this.schedule(uri, event, from, sweep, watches);
  }

  /**
   * True when an event of VS Code's watchers shows that its recursive watcher
   * watches the directory it is in. Events of every watcher reach each one an
   * extension makes, among them non-recursive ones other extensions make
   * (the TypeScript server's, for one). Outside the workspace folders those
   * report a directory we watch too, which the recursive watcher may not see
   * into; inside them they report only `files.watcherExclude` paths, which
   * are never watched.
   */
  private watcherWatches(uri: vscode.Uri): boolean {
    if (!this.gaps?.isWatched(uri.path.slice(0, uri.path.lastIndexOf('/')))) return true;
    return (vscode.workspace.workspaceFolders ?? []).some((f) => isUnder(f.uri, uri));
  }

  /**
   * An entry changed in a directory VS Code's watcher cannot see into. It is
   * handled as that watcher would report it, by the scope the path belongs to.
   */
  private gapEntry(dirFsPath: string, name: string, kind: 'rename' | 'change'): void {
    if (!this.running) return;
    const session = this.session;
    if (kind === 'rename') {
      const dir = vscode.Uri.file(dirFsPath);
      const uri = vscode.Uri.joinPath(dir, name);
      // Whether a directory there was known as the event came: a walk may watch a new one before its event is handled.
      return this.queueGapEvent(session, dir, uri, kind, this.gaps!.known(uri.path));
    }
    // A file written in many chunks is reported many times; later ones within GAP_MERGE_MS add nothing.
    const key = path.join(dirFsPath, name);
    if (this.gapWrites.has(key)) return;
    const timer = setTimeout(() => {
      this.gapWrites.delete(key);
      const dir = vscode.Uri.file(dirFsPath);
      this.queueGapEvent(session, dir, vscode.Uri.joinPath(dir, name), kind, false);
    }, GAP_MERGE_MS);
    this.gapWrites.set(key, timer);
  }

  private queueGapEvent(session: number, dir: vscode.Uri, uri: vscode.Uri, kind: 'rename' | 'change', known: boolean): void {
    const current = () => this.running && session === this.session;
    this.gapsQueued++;
    this.gapEvents = this.gapEvents
      .then(async () => {
        let event: 'create' | 'change' | 'delete' = 'change';
        let sweep = true;
        if (kind === 'rename') {
          const entry = await stat(uri);
          // The watched directory itself went; where its parent is watched, that reports it.
          if (!entry && !(await stat(dir))) {
            if (current()) this.gaps?.gone(dir.path);
            return;
          }
          if (!current()) return;
          const key = uri.toString();
          const recorded = this.snapshots.has(key) || this.gitBaselines.has(key);
          // A watched directory names itself for what happens to it: its attributes changing (chmod, touch), its
          // move or delete. Still there, with nothing known or recorded by that name in it, it only changed.
          const own = basename(uri.path) === basename(dir.path);
          if (own && !entry && !known && !recorded && !this.gaps!.refused) return;
          if (known && entry && entry.type & vscode.FileType.Directory && !(entry.type & vscode.FileType.SymbolicLink)) {
            // Made again, or its attributes changed, which reads as a rename too.
            return this.queueRecheck(uri, false);
          }
          // A directory replaced by a file or a link: what was known of it goes, and what was recorded in it is checked.
          if (known && entry) this.forgetDirectory(uri);
          // A recorded file named like the directory is one it may have named for itself: no new file.
          event = !entry ? 'delete' : own && recorded ? 'change' : 'create';
          // In a watched directory, only a directory known there, or one a watch was refused for, can hold what was recorded.
          sweep = known || this.gaps!.refused;
        }
        if (current()) this.onWatcherEvent(this.scopeOf(uri)?.key, uri, event, 'gap', sweep);
      })
      .catch((err) => this.log.appendLine(`Failed to handle a change in ${relPathOf(uri)}: ${String(err)}`))
      .finally(() => {
        // Deletes that waited for these events are swept together.
        if (++this.gapsHandled >= this.sweepAfter && this.deletedDirs.size > 0) this.deleteSweep ??= setImmediate(() => this.sweepDeletes());
      });
  }

  /** A directory was replaced: what was known of it goes, and what was recorded in it is checked, since its deletes may never have been reported. */
  private forgetDirectory(uri: vscode.Uri): void {
    this.gaps?.deleted(uri.path);
    this.scheduleDeletesUnder(uri);
  }

  /**
   * A known directory, reported or watched while recording, may have been made
   * again; the same directory with its attributes changed reads the same.
   * Those reported within GAP_MERGE_MS are checked together, and one in
   * another of them is checked with it.
   */
  private queueRecheck(uri: vscode.Uri, reported: boolean): void {
    const was = this.recheckDirs.get(uri.path);
    this.recheckDirs.set(uri.path, { uri, reported: reported || !!was?.reported });
    this.recheckTimer ??= setTimeout(() => {
      this.recheckTimer = undefined;
      const dirs = new Map(this.recheckDirs);
      this.recheckDirs.clear();
      for (const [dir, { uri, reported }] of dirs) {
        if (hasAncestorIn(dirs, dir)) continue;
        this.recheckDirectory(uri, reported).catch((err) => this.log.appendLine(`Failed to read changed directory ${relPathOf(uri)}: ${String(err)}`));
      }
    }, GAP_MERGE_MS);
  }

  /**
   * Checks a known directory that may have been made again. Watches of one
   * made again see nothing of it, so the watches of it and in it start again.
   * What is in it is compared with what was recorded, by the scope it is in
   * and by each lane recording a checkout in it: the same directory, changed,
   * records nothing. VS Code's watcher watches one it `reported`, unless found blind.
   */
  private async recheckDirectory(dir: vscode.Uri, reported: boolean): Promise<void> {
    const session = this.session;
    const stale = () => !this.running || session !== this.session;
    const st = await stat(dir);
    // Gone: its delete is reported.
    if (!st || stale()) return;
    if (!(st.type & vscode.FileType.Directory) || st.type & vscode.FileType.SymbolicLink) return this.forgetDirectory(dir);
    this.note(`checking again ${this.traceName(dir)}`);
    // A worktree added again in its place is another lane's, as when it was first added.
    this.noteWorktreeEvent(dir, 'create');
    // Made again for sure when it is not the directory last read here (a copy moved in), or was made since it was.
    const last = this.gaps!.lastScan(dir.path);
    const id = await dirId(dir.fsPath);
    if (stale()) return;
    const remade = !last || (last.id !== undefined && last.id !== id) || bornSince(st.ctime, last.at);
    const since = remade ? undefined : last.at;
    this.gaps!.recheck(dir.path, reported);
    const lanes = this.lanesAt(dir);
    const compares = lanes.map((s) => this.compareWithRecorded(s, stale, s.root, '', since));
    const scope = this.scopeOf(dir);
    if (scope && !lanes.includes(scope)) {
      const rel = this.relOf(scope, dir);
      if (!this.skipsTree(scope, rel)) compares.push(this.compareWithRecorded(scope, stale, dir, rel, since));
    }
    await Promise.all(compares);
  }

  /**
   * Walks the scope from `start` and schedules what differs from what it
   * recorded there: a file changed since its baseline was taken, a new one,
   * and one recorded but no longer found. `since` is when the directory was
   * last read, unless it was made again since. Then a file found without a
   * baseline is new only if made since: one made before was there, left
   * without one, and only gets a baseline; and a file whose stamp is what it
   * was is not read again. In a directory made again every file is read, and
   * one without a baseline is new, whenever it was made: it may have been
   * moved in. What is under a directory that could not be read is not taken
   * for deleted.
   */
  private async compareWithRecorded(scope: Scope, stale: () => boolean, start: vscode.Uri, startRel: string, since: number | undefined): Promise<void> {
    const failed = new Set<string>();
    const files = await this.walk(scope, stale, { start, startRel, failed });
    if (stale()) return;
    const found = new Set<string>();
    await inBatches(files, async (file) => {
      const key = file.toString();
      found.add(foldKey(key));
      if (this.scopeOf(file)?.key !== scope.key) return;
      const st = await stat(file);
      if (!st || stale()) return;
      const base = this.snapshots.get(key) ?? this.gitBaselines.get(key);
      if (since !== undefined && base?.stamp !== undefined && base.stamp === stampOf(st)) return;
      const made = !base && (since === undefined || bornSince(st.ctime, since));
      this.schedule(file, made ? 'create' : 'change', 'dir');
    });
    if (stale()) return;
    const unread = [...failed].map((d) => foldKey(d) + '/');
    for (const key of this.keysUnder(new Set([foldKey(start.toString().replace(/\/+$/, ''))]))) {
      const uri = vscode.Uri.parse(key);
      if (found.has(foldKey(key)) || this.scopeOf(uri)?.key !== scope.key) continue;
      if (unread.some((d) => foldKey(uri.path).startsWith(d))) continue;
      this.schedule(uri, 'delete', 'dir');
    }
  }

  /** Lanes recording a checkout at or in this directory, among them workspace folders nested in it. */
  private lanesAt(dir: vscode.Uri): Scope[] {
    return [...this.scopes.values()].filter((s) => s.root.path === dir.path || s.root.path.startsWith(dir.path + '/'));
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
   * `files.exclude`, which the watcher does not apply either. Each directory
   * VS Code's watcher cannot see into is watched for the scope before it is
   * read, so nothing written in it after the read goes unseen, and added to `seen`.
   * A directory that could not be read, other than for being gone, is added to `failed`.
   */
  private async walk(
    scope: Scope,
    stale: () => boolean,
    { start = scope.root, startRel = '', seen, failed }: { start?: vscode.Uri; startRel?: string; seen?: Set<string>; failed?: Set<string> } = {},
  ): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    const ignored = this.ignored.get(scope.key);
    const gaps = start.scheme === 'file' ? this.gaps : undefined;
    const dirs: Array<[vscode.Uri, string, boolean]> = [[start, startRel, !!gaps?.isBlind(start.path)]];
    let watched = 0;
    // A scope dropped meanwhile let go of its watches; it takes no new ones.
    const root = scope.root.toString();
    const recorded = () => this.scopes.get(scope.key)?.root.toString() === root;
    while (dirs.length > 0 && !stale()) {
      await Promise.all(
        dirs.splice(0, 64).map(async ([dir, rel, blind]) => {
          if (blind && recorded()) {
            if (gaps!.watch(dir.path, dir.fsPath, scope.key)) watched++;
            if (gaps!.isWatched(dir.path)) seen?.add(dir.path);
          }
          const readAt = Date.now();
          const readId = gaps?.known(dir.path) ? await dirId(dir.fsPath) : undefined;
          let entries: [string, vscode.FileType][];
          try {
            entries = await vscode.workspace.fs.readDirectory(dir);
          } catch (err) {
            if (!isNotFound(err)) failed?.add(dir.path);
            return;
          }
          gaps?.scanned(dir.path, readAt, readId);
          const gitFile = entries.some(([name, type]) => name === '.git' && type & vscode.FileType.File);
          if (rel && gitFile && this.isWorktreeGitFile(vscode.Uri.joinPath(dir, '.git').fsPath, scope)) {
            // Another worktree: its own lane, if it gets one, watches it.
            if (blind) {
              gaps!.unwatch(dir.path, scope.key);
              seen?.delete(dir.path);
            }
            return;
          }
          for (const [name, type] of entries) {
            const childRel = rel ? `${rel}/${name}` : name;
            if (type & vscode.FileType.Directory) {
              // Linked directories can loop, and the watcher reports changes in them only under their real path.
              if (type & vscode.FileType.SymbolicLink || name.toLowerCase() === '.git') continue;
              if (this.skipsDir(scope, childRel, ignored)) continue;
              const child = vscode.Uri.joinPath(dir, name);
              dirs.push([child, childRel, !!gaps?.isBlindIn(dir.path, blind, name)]);
            } else if (type & vscode.FileType.File) {
              files.push(vscode.Uri.joinPath(dir, name));
            }
          }
        }),
      );
    }
    if (watched > 0) this.note(`watching ${watched} folder(s) the watcher misses, in ${this.traceName(start)}`);
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
   * One VS Code's watcher `reported` is one it watches; any found in it may not be.
   */
  private async expandCreatedDirectory(dir: vscode.Uri, how: 'reported' | 'found' = 'found'): Promise<void> {
    const session = this.session;
    const stale = () => !this.running || session !== this.session;
    const st = await stat(dir);
    if (!st || !(st.type & vscode.FileType.Directory) || st.type & vscode.FileType.SymbolicLink || stale()) return;
    if (dir.scheme === 'file' && this.gaps) {
      // Before any check that leaves it unread: a worktree in it may be recorded later.
      if (how === 'reported') this.gaps.noteReported(dir.path);
      // A lane already recording a checkout at or in it walked before this event, or lost its watches to it
      // (a late create of its root, a root made again): it walks again for what it should watch.
      for (const s of this.lanesAt(dir)) {
        this.walk(s, stale).catch((err) => this.log.appendLine(`Failed to watch new folders in ${s.root.fsPath}: ${String(err)}`));
      }
    }
    const scope = this.scopeOf(dir);
    if (!scope) return;
    const rel = this.relOf(scope, dir);
    if (this.skipsTree(scope, rel)) return;
    const files = await this.walk(scope, stale, { start: dir, startRel: rel });
    if (stale()) return;
    for (const file of files) this.schedule(file, 'create', 'dir');
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
    if (this.deletedDirs.size === 0) this.sweepAfter = this.gapsQueued;
    this.deletedDirs.add(foldKey(key.replace(/\/+$/, '')));
    this.deleteSweep ??= setImmediate(() => this.sweepDeletes());
  }

  /**
   * Schedules as deleted each file recorded under the directories deleted
   * since the last sweep. Events of our own folder watches come a tick apart,
   * so it waits for the ones queued when the first of those directories came:
   * one pass over the baselines then serves the whole burst, as for a batch
   * of the watcher's, and a steady stream of them does not hold it back.
   */
  private sweepDeletes(): void {
    this.deleteSweep = undefined;
    if (this.gapsHandled < this.sweepAfter) return;
    const dirs = new Set(this.deletedDirs);
    this.deletedDirs.clear();
    if (!this.running) return;
    for (const child of this.keysUnder(dirs)) this.schedule(vscode.Uri.parse(child), 'delete', 'dir');
  }

  /**
   * Forgets baselines and saves of the files under these directories, except
   * ones a checkout recorded inside such a directory owns, as a folder opened
   * at a nested worktree sits inside the main checkout.
   */
  private forgetUnder(dirs: vscode.Uri[]): void {
    const folded = dirs.map((d) => foldKey(d.toString().replace(/\/+$/, '')));
    for (const key of this.keysUnder(new Set(folded))) {
      const owner = this.scopeOf(vscode.Uri.parse(key));
      const ownerRoot = owner && foldKey(owner.root.toString().replace(/\/+$/, ''));
      if (ownerRoot && folded.some((d) => ownerRoot.startsWith(d + '/'))) continue;
      this.snapshots.delete(key);
      this.gitBaselines.delete(key);
      this.ownSaves.delete(key);
    }
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
      const mark = this.gaps?.mark();
      const blind = new Set<string>();
      const found = await this.walk(scope, stale, { seen: blind });
      const clean = s.gitBaselines ? await this.cleanTracked(scope) : undefined;
      if (stale()) return;
      // Watches of the folders this walk no longer reached (excluded, or gone) are let go; a scope gone meanwhile lets all go.
      if (this.scopes.get(scope.key)?.root.toString() !== scope.root.toString()) this.gaps?.release(scope.key);
      else if (mark !== undefined) this.gaps!.keepOnly(scope.key, blind, mark);
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
      const st = await stat(uri);
      // Still recorded: a lane decision may have dropped its checkout meanwhile.
      if (isFile(st) && !known(key) && this.passes(uri)) gitRefs.set(key, { ...ref, stamp: stampOf(st) });
    });
    if (stale()) return;

    // Everything else gets an in-memory snapshot, newest first, within the budget.
    const stats: BudgetCandidate[] = [];
    const mtimes = new Map<string, number>();
    const stamps = new Map<string, string>();
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
        stamps.set(key, stampOf(st));
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
      if (snap === undefined || stale() || known(key) || !this.passes(uri)) return undefined;
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
      snapshots.set(key, { ...snap, captured: { at: Date.now(), mtime: mtimes.get(key)! }, stamp: stamps.get(key) });
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
   * A watcher event, one (`gap`) of a directory only our own watch sees, or
   * (`dir`) a file found under a directory an event named. Merges it into the
   * file's debounce burst.
   */
  private schedule(uri: vscode.Uri, event: 'create' | 'change' | 'delete', from: 'watcher' | 'gap' | 'dir' = 'watcher', sweep = true, watches = from === 'watcher'): void {
    if (!this.running || uri.scheme !== 'file') return;
    if (from !== 'dir') {
      if (uri.path.endsWith('/.gitignore') && this.settings().respectGitignore) this.scheduleIgnoreRefresh();
      // Directory paths can fail the filter, so look inside them before it applies.
      if (event === 'delete') {
        this.gaps?.deleted(uri.path);
        if (sweep) this.scheduleDeletesUnder(uri);
      } else if (event === 'create') {
        this.expandCreatedDirectory(uri, watches ? 'reported' : 'found').catch((err) => this.log.appendLine(`Failed to read new directory ${relPathOf(uri)}: ${String(err)}`));
      }
    }
    const key = uri.toString();
    // A held delete of this file is decided before a write that follows it; a
    // repeated delete event only says deletes are still coming.
    const held = this.heldDeletes.get(key);
    if (held && event !== 'delete') this.releaseDelete(key, held);
    else if (held) this.settleDeletes(held.scopeKey);
    const passes = this.passes(uri);
    const source = { watcher: 'watcher', gap: 'folder watch', dir: 'in directory' }[from];
    this.note(`${source} ${event} ${this.traceName(uri)}${passes ? '' : ' (filtered out)'}`);
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
      fromWatcher: watches || (existing?.fromWatcher ?? false),
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
          const at = await removedAt(uri, scope.root);
          if (this.beforeWaiting(scope, burst, at)) {
            this.note(`before its worktree waited, dropped ${relPath}`);
            return;
          }
          const git = await this.gitVerdict(scope, uri, burst.deletedAt ?? burst.lastArrival, false, at);
          try {
            if (dropped()) return;
            if (git.op) return this.skipGitWrite(git.op, scope, uri, relPath, false);
            // Unless it is half of a rename whose create in this checkout is
            // already held: that shows the checkout is not being removed.
            const deletedAt = git.key();
            const event = changeEvent(uri, relPath, 'delete', previous.text, '', previous.eol, deletedAt, scope.key);
            if (!this.recordRename(event, deletedAt, scope.root.toString())) this.holdDelete(scope, uri, relPath, previous, burst);
          } finally {
            git.end();
          }
          return;
        }
      }
      if (previous !== undefined) {
        this.snapshots.delete(key);
        // Keyed by its own delete event: earlier writes in the burst were before it.
        const git = await this.gitVerdict(scope, uri, burst.deletedAt ?? burst.lastArrival, false, await removedAt(uri, scope?.root));
        try {
          if (dropped()) return;
          if (scope && git.op) return this.skipGitWrite(git.op, scope, uri, relPath, false);
          this.record(uri, relPath, 'delete', previous.text, '', previous.eol, git.key());
        } finally {
          git.end();
        }
        // A change event is all a file swapped for a directory may get; the files in it are new.
        // Where VS Code's watcher merged its delete and create, it watches the directory.
        if (isDir && !burst.created) await this.expandCreatedDirectory(uri, burst.fromWatcher ? 'reported' : 'found');
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
      for (const child of under) this.schedule(vscode.Uri.parse(child), 'delete', 'dir');
      created = under.length > 0;
    }
    const writtenAt = clampOrderKey(exists.mtime, burst.firstArrival, burst.lastArrival, s.reorderWindowMs);

    let readError: unknown;
    const snap = await this.readText(uri, s, exists.size, (err) => (readError = err));
    if (dropped()) return;
    if (snap) snap.stamp = stampOf(exists);
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
    let kind: ChangeKind;
    let before: string;
    let reportedAt: number | undefined;
    if (decision.kind === 'after-own') {
      // Something wrote after the user's save: replay only that, from the saved text.
      kind = previous === undefined && created ? 'create' : 'modify';
      before = decision.before;
    } else if (previous === undefined) {
      // No baseline: a brand-new file is typed from empty; an unknown existing
      // file just gets its baseline now.
      this.snapshots.set(key, snap);
      if (!created) {
        this.note(`baseline captured ${relPath}`);
        // A waiting worktree removed before its first change is named once, when it starts waiting.
        if (!scope?.waiting) this.log.appendLine(`Baseline captured for ${relPath}; its next change will be replayed.`);
        return;
      }
      kind = 'create';
      before = '';
      // Its delete, if it is a rename's other half, may be reported just after it.
      reportedAt = burst.lastArrival;
    } else if (previous.text === snap.text) {
      // Always store the new snapshot, so a line-ending-only rewrite updates eol
      // for the next change without being recorded itself.
      this.snapshots.set(key, snap);
      this.note(`unchanged ${relPath}`);
      return;
    } else {
      kind = 'modify';
      before = previous.text;
    }
    this.snapshots.set(key, snap);
    if (this.beforeWaiting(scope, burst, exists.mtime)) {
      this.note(`before its worktree waited, baseline ${relPath}`);
      return;
    }
    const git = await this.gitVerdict(scope, uri, writtenAt, true, exists.mtime);
    try {
      if (dropped()) return;
      if (scope && git.op) return this.skipGitWrite(git.op, scope, uri, relPath, true);
      this.record(uri, relPath, kind, before, snap.text, snap.eol, git.key(), reportedAt);
    } finally {
      git.end();
    }
  }

  /**
   * Whether a change in a waiting worktree came before it started waiting, so
   * is no first change: its first event arrived earlier, or, for a worktree
   * made again at the same path, its write did (`at`, the file's mtime or the
   * mtime of the directory it left), as git's checkout of the new copy may be
   * reported only after the listing that found it.
   */
  private beforeWaiting(scope: Scope | undefined, burst: Burst, at: number | undefined): boolean {
    const w = scope?.waiting ? this.waiting.get(scope.key) : undefined;
    return !!w && (burst.firstArrival < w.since || (!!w.remade && at !== undefined && at < w.since));
  }

  /**
   * Gives each recorded checkout in a git repository a git operation watch
   * while recording with `ignoreGitOperations` on, and drops the rest. A
   * watch reads the index when it starts, so it must exist before the
   * operations it is to recognize; resolves once new ones have.
   */
  private syncGitWatches(): Promise<void> {
    const on = this.running && this.settings().ignoreGitOperations;
    for (const [key, watch] of this.gitWatches) {
      const scope = on ? this.scopes.get(key) : undefined;
      if (scope?.repo && scope.root.fsPath === watch.root) continue;
      watch.dispose();
      this.gitWatches.delete(key);
    }
    if (!on) return Promise.resolve();
    const started: Promise<void>[] = [];
    for (const scope of this.scopes.values()) {
      if (!scope.repo || scope.root.scheme !== 'file' || this.gitWatches.has(scope.key)) continue;
      const watch = new GitOperationWatch(scope.root.fsPath);
      this.gitWatches.set(scope.key, watch);
      started.push(
        watch.status().then((status) => {
          if (status === 'unavailable' && watch.failure) this.noteGitOpsOff(watch.failure);
          this.noteGitProblem(watch, scope);
        }),
      );
    }
    return Promise.all(started).then(() => {});
  }

  /** Logs a watch's latest git problem once: git operations there are recorded until git answers again. */
  private noteGitProblem(watch: GitOperationWatch, scope: Scope): void {
    if (!watch.problem || this.gitProblemsNoted.get(watch) === watch.problem || !this.running) return;
    this.gitProblemsNoted.set(watch, watch.problem);
    this.log.appendLine(`Git operations in ${laneName(scope)} are recorded like any other change for now: git failed (${watch.problem}).`);
  }

  private noteGitOpsOff(reason: string): void {
    if (this.gitOpsOffNoted || !this.running) return;
    this.gitOpsOffNoted = true;
    this.log.appendLine(`Git operations are recorded like any other change: git could not run (${reason}).`);
  }

  /**
   * Whether a git operation made this write (`ignoreGitOperations`), waiting
   * for one in progress to settle. Only while it has to wait are later
   * changes held back, so this one keeps its place at `writtenAt`; an answer
   * from a stat alone holds nothing. End the verdict once the change is
   * recorded or skipped. `at` is when the filesystem says the write
   * happened, unclamped, since git's span is on the filesystem's clock: the
   * file's mtime, or for a delete the mtime of the directory it left.
   */
  private async gitVerdict(scope: Scope | undefined, uri: vscode.Uri, writtenAt: number, exists: boolean, at = writtenAt): Promise<GitVerdict> {
    const watch = scope && this.settings().ignoreGitOperations ? this.gitWatches.get(scope.key) : undefined;
    if (!scope || !watch) return { key: () => writtenAt, end: () => {} };
    let hold: OrderHold | undefined;
    try {
      const op = await watch.classify(this.relOf(scope, uri), at, exists, () => (hold = this.reorder.hold(writtenAt, GIT_HOLD_MAX_MS)));
      if (watch.failure) this.noteGitOpsOff(watch.failure);
      this.noteGitProblem(watch, scope);
      return { op, key: () => hold?.key() ?? writtenAt, end: () => hold?.end() };
    } catch (err) {
      hold?.end();
      throw err;
    }
  }

  /**
   * A write git made: nothing is recorded, and the file's baseline is its new
   * text. A file git left clean at stage 0 gets a git baseline on its new blob
   * instead of the snapshot flush stored; a removed file loses both.
   */
  private skipGitWrite(op: GitOperation, scope: Scope, uri: vscode.Uri, relPath: string, exists: boolean): void {
    const key = uri.toString();
    this.note(`written by git (${op.label}), skipped ${relPath}`);
    if (!exists) {
      this.snapshots.delete(key);
      this.gitBaselines.delete(key);
    } else {
      const rel = this.relOf(scope, uri);
      const sha = op.blobs.get(rel);
      if (sha && this.settings().gitBaselines && !this.gitUnavailable) {
        this.snapshots.delete(key);
        this.gitBaselines.set(key, { folder: scope.root.fsPath, path: rel, sha });
      }
    }
    op.skipped++;
    const pending = this.gitSummaries.get(op);
    if (pending) clearTimeout(pending.timer);
    this.gitSummaries.set(op, { lane: laneName(scope), quiet: !!scope.waiting, timer: setTimeout(() => this.logGitSummary(op), GIT_SUMMARY_DELAY_MS) });
  }

  private logGitSummary(op: GitOperation): void {
    const pending = this.gitSummaries.get(op);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.gitSummaries.delete(op);
    const line = `Skipped ${op.skipped} file${op.skipped === 1 ? '' : 's'} written by git (${op.label}) in ${pending.lane}.`;
    // Git in a waiting worktree gives it no lane, and it is named once, when it starts waiting.
    if (pending.quiet) this.note(line);
    else this.log.appendLine(line);
    op.skipped = 0;
  }

  private flushGitSummaries(): void {
    for (const op of [...this.gitSummaries.keys()]) this.logGitSummary(op);
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

  /** Hands a change to the reorder buffer; `writtenAt` orders it and becomes its recorded time. With `reportedAt`, it waits a window after that too. */
  private record(
    uri: vscode.Uri,
    relPath: string,
    kind: ChangeKind,
    before: string,
    after: string,
    eol: Eol,
    writtenAt: number,
    reportedAt?: number,
  ): void {
    const event = changeEvent(uri, relPath, kind, before, after, eol, writtenAt, this.scopeOf(uri)?.key);
    if (this.recordRename(event, writtenAt)) return;
    this.note(`recorded ${kind} ${relPath}`);
    this.enqueue(event, writtenAt, reportedAt);
  }

  /**
   * Hands a change to the reorder buffer. A change in a new worktree still
   * waiting for its first change keeps its place in write order instead
   * while auto-record decides whether the worktree gets a lane, and goes on
   * only once it has one.
   */
  private enqueue(event: NewChangeEvent, writtenAt: number, reportedAt?: number): void {
    const lane = event.lane;
    // A decision still being handed out waits too: a later change of the same file must not overtake the first.
    if (lane === undefined || (!this.scopes.get(lane)?.waiting && !this.laneAsks.has(lane))) {
      this.reorder.add(event, writtenAt, event.uri, reportedAt);
      return;
    }
    const order = this.reorder.hold(writtenAt, LANE_WAIT_MAX_MS);
    const session = this.session;
    this.waitingChanges++;
    void this.laneFor(lane)
      .then((recorded) => {
        if (recorded && this.running && session === this.session) this.reorder.add(event, order.key(), event.uri, reportedAt);
        else this.note(`no lane for the new worktree, dropped ${event.relPath}`);
      })
      .catch((err) => this.log.appendLine(`Failed to record ${event.relPath}: ${String(err)}`))
      .finally(() => {
        this.waitingChanges--;
        order.end();
      });
  }

  /**
   * Asks auto-record for a lane for a waiting worktree that recorded a
   * change: the next scope refresh decides. True once it records in a lane.
   * Changes arriving meanwhile wait on the same answer.
   */
  private laneFor(lane: string): Promise<boolean> {
    const asked = this.laneAsks.get(lane);
    if (asked) return asked;
    this.firstChanges.add(lane);
    const answer = this.refreshScopes().then(
      () => {
        // A refusal or a rotation stopped checkouts: forget their baselines, so one ticked again later starts afresh.
        if (this.running) this.dropUnwatched();
        return this.scopes.get(lane)?.waiting === false;
      },
      (err) => {
        this.log.appendLine(`Failed to re-read worktrees: ${String(err)}`);
        // Its change is dropped, so a later refresh must not give the lane without it.
        this.firstChanges.delete(lane);
        return false;
      },
    );
    this.laneAsks.set(lane, answer);
    void answer.then(() => this.laneAsks.get(lane) === answer && this.laneAsks.delete(lane));
    return answer;
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
    this.enqueue(rename, writtenAt);
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
  /** VS Code's recursive watcher reported an event of this burst, so it watches the directory it is in. */
  fromWatcher: boolean;
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

/**
 * When the filesystem says a file was removed: the mtime of the nearest
 * directory above it that still exists, which the removal stamped (git
 * removes a directory it emptied). Undefined when none can be read up to `root`.
 */
async function removedAt(uri: vscode.Uri, root: vscode.Uri | undefined): Promise<number | undefined> {
  let dir = path.dirname(uri.fsPath);
  const top = root?.fsPath;
  for (;;) {
    const st = await fs.promises.stat(dir).catch(() => undefined);
    if (st) return st.mtimeMs;
    const up = path.dirname(dir);
    if (up === dir || (top !== undefined && !up.startsWith(top))) return undefined;
    dir = up;
  }
}

/** A recorded checkout as the output channel names it: the folder, with the checkout for a chosen worktree. */
function laneName(scope: Scope): string {
  return scope.own ? scope.folder.name : `${scope.folder.name} (${scope.name})`;
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
  /** Short branch name of the recorded checkout; undefined when detached, outside git, or the folder's own. */
  branch: string | undefined;
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
  /** A new worktree auto-record watches without a lane until it records its first change. */
  waiting: boolean;
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
  /** `stampOf` the file as stated once git called it clean. */
  stamp?: string;
}

/**
 * A worktree's recorded root as its scope spells it. Inside the folder it is
 * spelled as the folder is (git resolves symlinks), so watcher events,
 * baselines and editor documents of its files all use one spelling.
 */
function rootUri(folder: vscode.WorkspaceFolder, root: string): vscode.Uri {
  const inside = relativeInside(folder.uri.fsPath, root);
  return inside ? vscode.Uri.joinPath(folder.uri, ...inside.split('/')) : vscode.Uri.file(root);
}

/** Tells one `.git` file of a linked worktree from the next at the same path, which `git worktree add` writes anew; undefined when unreadable. */
async function gitFileId(checkout: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(path.join(checkout, '.git'));
    return `${st.ino}:${st.mtimeMs}:${st.birthtimeMs}`;
  } catch {
    return undefined;
  }
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = 64): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

interface Snapshot {
  text: string;
  eol: Eol;
  /** Set when a baseline capture took it: when, and the file's mtime then. */
  captured?: { at: number; mtime: number };
  /** `stampOf` the file as stated just before its text was read. */
  stamp?: string;
}

/**
 * A file's mtime, size and birth time (VS Code's ctime): a file whose stamp is
 * what it was when its baseline was taken is taken to be unchanged. The birth
 * time tells a file made again with the same mtime and size (an archive
 * unpacked again, `cp -p`) from the one that was there.
 */
function stampOf(st: { mtime: number; size: number; ctime: number }): string {
  return `${st.mtime}:${st.size}:${st.ctime}`;
}

/** True for a birth time `ctime` at or after `at`, as far as a coarse clock tells, or none known. */
function bornSince(ctime: number, at: number): boolean {
  return !ctime || ctime >= at - BIRTH_SLACK_MS;
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

/** The last name of a Uri path. */
function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** True for an error that says the path is not there (or not a directory), from VS Code's file system or Node's. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT' || code === 'FileNotADirectory' || code === 'ENOTDIR';
}

/** True when a directory holding `dir` is among `dirs`, both named by Uri path. */
function hasAncestorIn(dirs: ReadonlyMap<string, unknown>, dir: string): boolean {
  for (let i = dir.lastIndexOf('/'); i > 0; i = dir.lastIndexOf('/', i - 1)) if (dirs.has(dir.slice(0, i))) return true;
  return false;
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
