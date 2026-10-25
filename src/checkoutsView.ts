import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneOf, type LaneInfo, type Timeline } from './timeline';
import { laneIcon, laneName } from './timelineView';
import { laneKey, pathKey } from './worktrees';

/** What the Checkouts view lists for one workspace folder. */
export interface FolderCheckoutsModel {
  folder: vscode.WorkspaceFolder;
  /** Its own checkout first (or the folder itself, outside git or with none of its own), then every other worktree git lists. */
  checkouts: Array<{ path: string; name: string; own: boolean }>;
  /** Paths of the checkouts it records, or records once started. */
  recorded: string[];
}

/** What ticking or clearing a box does; a rejection says why it was refused. */
export interface CheckoutActions {
  add(folder: vscode.WorkspaceFolder, checkoutPath: string): Promise<void>;
  remove(folder: vscode.WorkspaceFolder, checkoutPath: string): Promise<void>;
  error(message: string): void;
}

/** URI scheme of the followed row's `resourceUri`, which the lane decorations tint and badge. */
export const FOLLOWED_SCHEME = 'agent-typewriter-followed';

/** The `resourceUri` that marks a lane's row as the followed one. */
export function followedRowUri(lane: string): vscode.Uri {
  return vscode.Uri.from({ scheme: FOLLOWED_SCHEME, path: '/' + encodeURIComponent(lane) });
}

/** What the followed lane is doing, as its row says it. */
export type Following = 'typing' | 'caught up' | { queued: number };

/**
 * How the lane's row is marked as followed, or undefined when it is not the
 * followed lane. The only lane is marked too: it says where playback goes.
 */
export function followingState(timeline: Timeline, lane: string): Following | undefined {
  if (timeline.followed !== lane) return undefined;
  const playing = timeline.playing !== undefined ? timeline.get(timeline.playing) : undefined;
  if (playing && laneOf(playing) === lane) return 'typing';
  const queued = timeline.pendingCount(lane);
  return queued > 0 ? { queued } : 'caught up';
}

/** The Checkouts view's header: which lane is followed, once there is one. */
export function followingHeader(timeline: Timeline): string | undefined {
  const followed = timeline.laneList().find((l) => l.id === timeline.followed);
  return followed && `Following: ${laneName(followed)}`;
}

/** The description words for a lane's queue: what the followed one is doing, else how many are queued. */
function queueText(following: Following | undefined, queued: number): string {
  if (following === undefined) return queued > 0 ? `${queued} queued` : '';
  return typeof following === 'string' ? following : `${following.queued} queued`;
}

/** Marks the followed row: an eye in the lane's color, and the tint and badge its `resourceUri` gets. */
function markFollowed(item: vscode.TreeItem, lane: LaneInfo, following: Following | undefined): void {
  if (following === undefined) return;
  item.iconPath = lane.color > 0 ? new vscode.ThemeIcon('eye', new vscode.ThemeColor(`agentTypewriter.lane${lane.color}`)) : new vscode.ThemeIcon('eye');
  item.resourceUri = followedRowUri(lane.id);
}

/** A workspace folder's node, shown only in a multi-root workspace. */
export class FolderNode extends vscode.TreeItem {
  constructor(readonly model: FolderCheckoutsModel) {
    super(model.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${model.folder.uri.toString()}`;
    this.iconPath = new vscode.ThemeIcon('root-folder');
  }
}

/** One checkout: ticked when recorded, in its lane's color once it has a lane. */
export class CheckoutRow extends vscode.TreeItem {
  constructor(
    readonly folder: vscode.WorkspaceFolder,
    readonly checkoutPath: string,
    /** Its lane id, recorded or not. */
    readonly lane: string,
    name: string,
    /** What the row says for where it is: 'this folder', a path inside the folder, or the checkout's own path. */
    where: string,
    recorded: boolean,
    info: LaneInfo | undefined,
    /** It is the followed lane, even when it is the only one. */
    followed: boolean,
    following: Following | undefined,
    queued: number,
  ) {
    super(name || folder.name, vscode.TreeItemCollapsibleState.None);
    this.id = `checkout:${lane}`;
    this.checkboxState = recorded ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.description = [where, info ? queueText(following, queued) : '', info && !info.recording ? 'stopped' : ''].filter(Boolean).join('  ·  ');
    this.tooltip = `${name || folder.name}\n${checkoutPath}${recorded ? '\nRecorded' : ''}${following !== undefined ? '\nFollowed: its changes are the ones typed' : ''}`;
    this.iconPath = info ? laneIcon(info) : new vscode.ThemeIcon('circle-large-outline');
    if (info) markFollowed(this, info, following);
    // The followed lane offers no follow action.
    this.contextValue = !info ? 'checkout' : followed ? 'lane.followed' : 'lane';
  }
}

/** A lane in the buffer that no listed checkout records: a removed worktree, or a loaded session's. */
export class LaneRow extends vscode.TreeItem {
  constructor(
    readonly lane: LaneInfo,
    followed: boolean,
    following: Following | undefined,
    queued: number,
  ) {
    super(laneName(lane), vscode.TreeItemCollapsibleState.None);
    this.id = `lane-row:${lane.id}`;
    this.description = queueText(following, queued);
    this.tooltip = `${laneName(lane)}${lane.root ? `\n${lane.root}` : ''}\nNot recording${following !== undefined ? '\nFollowed: its changes are the ones typed' : ''}`;
    this.iconPath = laneIcon(lane);
    markFollowed(this, lane, following);
    this.contextValue = followed ? 'lane.followed' : 'lane';
  }
}

/** Holds the lanes in the buffer that no listed checkout records. */
export class OthersNode extends vscode.TreeItem {
  constructor(readonly lanes: LaneRow[]) {
    super('Not recording', vscode.TreeItemCollapsibleState.Expanded);
    this.id = 'others';
    this.iconPath = new vscode.ThemeIcon('history');
  }
}

/**
 * `child` relative to `parent` with forward slashes, or undefined when it is
 * not strictly inside. Compare real paths: git lists worktrees by theirs.
 */
export function pathInside(parent: string, child: string): string | undefined {
  const rel = path.relative(parent, child);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/** Each path as it is on disk, symlinks resolved; one that can't be resolved stays as written. */
async function realPaths(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  const real = await Promise.all(unique.map((p) => fs.promises.realpath(p).catch(() => p)));
  return new Map(unique.map((p, i) => [p, real[i]]));
}

export type CheckoutsNode = FolderNode | CheckoutRow | LaneRow | OthersNode;

/**
 * Every checkout of each workspace folder, ticked when recorded, with its
 * lane's color, queue and whether it is followed. Lanes in the buffer that no
 * listed checkout records are listed apart, so they can still be followed.
 */
export class CheckoutsView implements vscode.TreeDataProvider<CheckoutsNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private models: FolderCheckoutsModel[] = [];
  /** Real paths of the folders and checkouts listed, read once per reload rather than on every redraw. */
  private real = new Map<string, string>();
  private pending: NodeJS.Timeout | undefined;
  private loads = 0;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly timeline: Timeline,
    private readonly load: () => Promise<FolderCheckoutsModel[]>,
    private readonly actions: CheckoutActions,
  ) {
    this.sub = timeline.onDidChange(() => this.redrawSoon());
  }

  /** Lists the checkouts again; only the newest of overlapping reloads is kept. */
  async reload(): Promise<void> {
    const n = ++this.loads;
    const models = await this.load();
    const real = await realPaths(models.flatMap((m) => [m.folder.uri.fsPath, ...m.checkouts.map((c) => c.path)]));
    if (n !== this.loads) return;
    this.models = models;
    this.real = real;
    this.emitter.fire();
  }

  getTreeItem(node: CheckoutsNode): vscode.TreeItem {
    return node;
  }

  getChildren(parent?: CheckoutsNode): CheckoutsNode[] {
    if (parent instanceof FolderNode) return this.rows(parent.model);
    if (parent instanceof OthersNode) return parent.lanes;
    if (parent) return [];
    const others = this.otherLanes();
    const top: CheckoutsNode[] = this.models.length === 1 ? this.rows(this.models[0]) : this.models.map((m) => new FolderNode(m));
    return others.length > 0 ? [...top, new OthersNode(others)] : top;
  }

  /** A box was ticked or cleared: records or stops that checkout, and puts the box back when refused. */
  async setChecked(row: CheckoutRow, checked: boolean): Promise<void> {
    try {
      if (checked) await this.actions.add(row.folder, row.checkoutPath);
      else await this.actions.remove(row.folder, row.checkoutPath);
    } catch (err) {
      this.actions.error(err instanceof Error ? err.message : String(err));
    }
    await this.reload();
  }

  private rows(model: FolderCheckoutsModel): CheckoutRow[] {
    const recorded = new Set(model.recorded.map(pathKey));
    const folderKey = model.folder.uri.toString();
    const realOf = (p: string) => this.real.get(p) ?? p;
    // A folder opened through a symlink is related to the worktrees by its real path.
    const folderReal = realOf(model.folder.uri.fsPath);
    return model.checkouts.map((c) => {
      const lane = laneKey(folderKey, c.own, c.path);
      const info = this.timeline.laneInfo(lane);
      const followed = info !== undefined && this.timeline.followed === lane;
      const following = info && followingState(this.timeline, lane);
      const where = c.own ? 'this folder' : (pathInside(folderReal, realOf(c.path)) ?? c.path);
      return new CheckoutRow(model.folder, c.path, lane, c.name, where, recorded.has(pathKey(c.path)), info, followed, following, info ? this.timeline.pendingCount(lane) : 0);
    });
  }

  private otherLanes(): LaneRow[] {
    const listed = new Set(this.models.flatMap((m) => m.checkouts.map((c) => laneKey(m.folder.uri.toString(), c.own, c.path))));
    const inBuffer = new Set(this.timeline.lanesInBuffer());
    return this.timeline
      .laneList()
      .filter((l) => !listed.has(l.id) && inBuffer.has(l.id))
      .map((l) => new LaneRow(l, l.id === this.timeline.followed, followingState(this.timeline, l.id), this.timeline.pendingCount(l.id)));
  }

  private redrawSoon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.emitter.fire();
    }, 120);
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.sub.dispose();
    this.emitter.dispose();
  }
}
