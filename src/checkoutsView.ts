import * as vscode from 'vscode';
import * as path from 'node:path';
import type { LaneInfo, Timeline } from './timeline';
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
    own: boolean,
    recorded: boolean,
    info: LaneInfo | undefined,
    followed: boolean,
    queued: number,
  ) {
    super(name || folder.name, vscode.TreeItemCollapsibleState.None);
    this.id = `checkout:${lane}`;
    this.checkboxState = recorded ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    const rel = path.relative(folder.uri.fsPath, checkoutPath);
    const where = own ? 'this folder' : rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : checkoutPath;
    this.description = [where, info && queued > 0 ? `${queued} queued` : '', followed ? 'following' : '', info && !info.recording ? 'stopped' : '']
      .filter(Boolean)
      .join('  ·  ');
    this.tooltip = `${name || folder.name}\n${checkoutPath}${recorded ? '\nRecorded' : ''}`;
    this.iconPath = info ? laneIcon(info) : new vscode.ThemeIcon('circle-large-outline');
    this.contextValue = !info ? 'checkout' : followed ? 'lane.followed' : 'lane';
  }
}

/** A lane in the buffer that no listed checkout records: a removed worktree, or a loaded session's. */
export class LaneRow extends vscode.TreeItem {
  constructor(
    readonly lane: LaneInfo,
    followed: boolean,
    queued: number,
  ) {
    super(laneName(lane), vscode.TreeItemCollapsibleState.None);
    this.id = `lane-row:${lane.id}`;
    this.description = [queued > 0 ? `${queued} queued` : '', followed ? 'following' : ''].filter(Boolean).join('  ·  ');
    this.tooltip = `${laneName(lane)}${lane.root ? `\n${lane.root}` : ''}\nNot recording`;
    this.iconPath = laneIcon(lane);
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
    if (n !== this.loads) return;
    this.models = models;
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
    return model.checkouts.map((c) => {
      const lane = laneKey(folderKey, c.own, c.path);
      const info = this.timeline.laneInfo(lane);
      const followed = info !== undefined && this.timeline.followed === lane;
      return new CheckoutRow(model.folder, c.path, lane, c.name, c.own, recorded.has(pathKey(c.path)), info, followed, info ? this.timeline.pendingCount(lane) : 0);
    });
  }

  private otherLanes(): LaneRow[] {
    const listed = new Set(this.models.flatMap((m) => m.checkouts.map((c) => laneKey(m.folder.uri.toString(), c.own, c.path))));
    const inBuffer = new Set(this.timeline.lanesInBuffer());
    return this.timeline
      .laneList()
      .filter((l) => !listed.has(l.id) && inBuffer.has(l.id))
      .map((l) => new LaneRow(l, l.id === this.timeline.followed, this.timeline.pendingCount(l.id)));
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
