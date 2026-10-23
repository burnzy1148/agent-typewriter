import * as vscode from 'vscode';
import type { ChangeEvent, Timeline } from './timeline';

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

/** Newest-first list of recorded changes with their playback state. */
export class TimelineView implements vscode.TreeDataProvider<ChangeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private pending: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(private readonly timeline: Timeline) {
    this.sub = timeline.onDidChange(() => this.refreshSoon());
  }

  getTreeItem(item: ChangeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): ChangeItem[] {
    const events = this.timeline.all();
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
