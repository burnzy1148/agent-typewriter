import * as vscode from 'vscode';
import { laneBadge } from './lanes';
import { MIRROR_SCHEME } from './mirrorFs';
import { FOLLOWED_SCHEME } from './checkoutsView';
import { laneOf, type LaneInfo, type Timeline } from './timeline';

/** The lane a mirror path belongs to: that of the newest change at it, or undefined when the buffer has none. */
export function mirrorLane(timeline: Timeline, relPath: string): LaneInfo | undefined {
  const events = timeline.all();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.relPath !== relPath && e.fromRelPath !== relPath) continue;
    const id = laneOf(e);
    return timeline.laneList().find((l) => l.id === id);
  }
  return undefined;
}

/**
 * Tints each mirror tab in its lane's color and gives it a two-letter badge,
 * while the buffer holds more than one lane. With one lane, tabs look as
 * before. Also tints the followed lane's row in the Checkouts view and badges
 * it with a play mark.
 */
export class LaneDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private pending: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(private readonly timeline: Timeline) {
    this.sub = timeline.onDidChange(() => {
      if (this.pending) return;
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.emitter.fire(undefined);
      }, 200);
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === FOLLOWED_SCHEME) return this.followedRow(decodeURIComponent(uri.path.replace(/^\/+/, '')));
    if (uri.scheme !== MIRROR_SCHEME || this.timeline.lanesInBuffer().length < 2) return undefined;
    const lane = mirrorLane(this.timeline, uri.path.replace(/^\/+/, ''));
    if (!lane || lane.color === 0) return undefined;
    return new vscode.FileDecoration(laneBadge(lane.label), lane.label, new vscode.ThemeColor(`agentTypewriter.lane${lane.color}`));
  }

  /** The followed row's mark, while that lane is still followed. */
  private followedRow(id: string): vscode.FileDecoration | undefined {
    if (id !== this.timeline.followed) return undefined;
    const lane = this.timeline.laneList().find((l) => l.id === id);
    if (!lane) return undefined;
    const color = lane.color > 0 ? new vscode.ThemeColor(`agentTypewriter.lane${lane.color}`) : undefined;
    return new vscode.FileDecoration('\u25B6', 'Followed: its changes are the ones typed', color);
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.sub.dispose();
    this.emitter.dispose();
  }
}
