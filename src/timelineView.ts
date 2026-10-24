import * as vscode from 'vscode';
import type { ChangeEvent, LaneInfo, Timeline } from './timeline';

const MAX_ITEMS = 300;

export class ChangeItem extends vscode.TreeItem {
  constructor(readonly event: ChangeEvent, state: 'played' | 'playing' | 'pending') {
    const slash = event.relPath.lastIndexOf('/');
    const name = event.relPath.slice(slash + 1);
    const dir = slash > 0 ? event.relPath.slice(0, slash) : '';
    super(name, vscode.TreeItemCollapsibleState.None);

    const time = new Date(event.time).toLocaleTimeString();
    const counts = `+${event.linesAdded} -${event.linesRemoved}`;
    const delta =
      event.kind === 'delete'
        ? 'deleted'
        : event.kind === 'create'
          ? `new +${event.linesAdded}`
          : event.kind === 'rename'
            ? `renamed from ${event.fromRelPath}${event.before === event.after ? '' : ` ${counts}`}`
            : counts;
    this.description = [delta, dir, time].filter(Boolean).join('  ·  ');
    this.tooltip = new vscode.MarkdownString(
      `**${event.fromRelPath !== undefined ? `${event.fromRelPath} \u2192 ` : ''}${event.relPath}**  \n#${event.seq} · ${event.kind} · ${time}  \n${delta} lines · ${state}`,
    );
    this.contextValue = 'changeEvent';
    this.iconPath =
      state === 'playing'
        ? new vscode.ThemeIcon('loading~spin')
        : state === 'pending'
          ? new vscode.ThemeIcon('circle-outline')
          : event.kind === 'delete'
            ? new vscode.ThemeIcon('trash')
            : event.kind === 'rename'
              ? new vscode.ThemeIcon('diff-renamed')
              : new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    this.command = { command: 'agentTypewriter.showDiff', title: 'Show Diff', arguments: [this] };
  }
}

/** A lane's icon: a dot in its color, or an outline for the default lane, which has none. */
export function laneIcon(info: LaneInfo): vscode.ThemeIcon {
  return info.color > 0 ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(`agentTypewriter.lane${info.color}`)) : new vscode.ThemeIcon('circle-outline');
}

/** A lane's label, or what to call the default lane of changes recorded or loaded without one. */
export function laneName(info: LaneInfo): string {
  return info.label || 'Earlier changes';
}

/** One lane's node in the Changes view, holding its changes. */
export class LaneItem extends vscode.TreeItem {
  constructor(
    readonly lane: LaneInfo,
    followed: boolean,
    queued: number,
  ) {
    super(laneName(lane), followed ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    // The id keeps each lane's expanded state while others come and go.
    this.id = `lane:${lane.id}`;
    this.description = [`${queued} queued`, followed ? 'following' : '', lane.recording ? '' : 'stopped'].filter(Boolean).join('  ·  ');
    this.tooltip = `${laneName(lane)}${lane.root ? `\n${lane.root}` : ''}`;
    this.iconPath = laneIcon(lane);
    this.contextValue = followed ? 'lane.followed' : 'lane';
  }
}

/**
 * Newest-first list of recorded changes with their playback state. With more
 * than one lane in the buffer, one node per lane holds its changes, the
 * followed lane first.
 */
export class TimelineView implements vscode.TreeDataProvider<ChangeItem | LaneItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private pending: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(private readonly timeline: Timeline) {
    this.sub = timeline.onDidChange(() => this.refreshSoon());
  }

  getTreeItem(item: ChangeItem | LaneItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: ChangeItem | LaneItem): Array<ChangeItem | LaneItem> {
    if (parent instanceof ChangeItem) return [];
    if (parent) return this.changes(this.timeline.laneEvents(parent.lane.id));
    const inBuffer = new Set(this.timeline.lanesInBuffer());
    if (inBuffer.size <= 1) return this.changes(this.timeline.all());
    const followed = this.timeline.followed;
    const lanes = this.timeline.laneList().filter((l) => inBuffer.has(l.id));
    lanes.sort((a, b) => Number(b.id === followed) - Number(a.id === followed));
    return lanes.map((l) => new LaneItem(l, l.id === followed, this.timeline.pendingCount(l.id)));
  }

  private changes(events: readonly ChangeEvent[]): ChangeItem[] {
    const out: ChangeItem[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < MAX_ITEMS; i--) {
      out.push(new ChangeItem(events[i], this.timeline.stateOf(events[i].seq)));
    }
    return out;
  }

  refreshSoon(): void {
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
