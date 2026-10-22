import * as vscode from 'vscode';
import { MirrorFileSystem } from './mirrorFs';
import type { Player } from './player';
import { rowReadout, type ScrubberState } from './scrubberState';

/**
 * VS Code asks for lenses again only after 250 ms without a change event or an
 * edit, so change events closer together than that would hold the row back.
 */
const MIN_EVENT_GAP_MS = 300;

/**
 * Playback controls on the playback mirror: the context keys its title bar
 * buttons are scoped by, and a CodeLens row above its first line. Every
 * control runs an existing command, the same way the Playback panel does.
 */
export class MirrorControls implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private pending: NodeJS.Timeout | undefined;
  private lastEvent = 0;
  /** What the row showed when the last change event fired; an unchanged row fires nothing. */
  private eventRow: string | undefined;
  private pausedKey: boolean | undefined;
  private changesKey: boolean | undefined;
  private mirrorKey: string | undefined | null = null;

  constructor(
    private readonly player: Player,
    private readonly snapshot: () => ScrubberState,
    private readonly enabled: () => boolean,
    private readonly hasChanges: () => boolean,
  ) {
    this.subscription = player.onDidChangePlaybackMirror(() => this.refresh());
  }

  /** URI of the playback mirror, if anything has been played. */
  get playbackUri(): vscode.Uri | undefined {
    const rel = this.player.playbackRelPath;
    return rel === undefined ? undefined : MirrorFileSystem.uriFor(rel);
  }

  /** Updates the context keys now and the CodeLens row soon, at most once per MIN_EVENT_GAP_MS. */
  refresh(): void {
    this.updateContextKeys();
    if (this.pending) return;
    const wait = Math.max(100, this.lastEvent + MIN_EVENT_GAP_MS - Date.now());
    this.pending = setTimeout(() => {
      this.pending = undefined;
      const row = this.rowKey();
      if (row === this.eventRow) return;
      this.eventRow = row;
      this.lastEvent = Date.now();
      this.changed.fire();
    }, wait);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const uri = this.playbackUri;
    if (!this.enabled() || !uri || doc.uri.toString() !== uri.toString()) return [];
    return this.row(this.snapshot()).map(
      ([title, command, tooltip]) => new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title, command, tooltip }),
    );
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.subscription.dispose();
    this.changed.dispose();
  }

  /** Title, command and tooltip of each lens in the row. */
  private row(s: ScrubberState): Array<[string, string, string]> {
    const row: Array<[string, string, string]> = [
      s.paused
        ? ['$(play) Play', 'agentTypewriter.resume', 'Resume playback']
        : ['$(debug-pause) Pause', 'agentTypewriter.pause', 'Pause playback'],
    ];
    if (s.changes.length > 0) {
      row.push(
        ['$(zap) Finish', 'agentTypewriter.finishCurrent', 'Finish current change instantly'],
        ['$(arrow-right) Next', 'agentTypewriter.skipToNext', 'Skip to next change'],
        ['$(debug-continue) Latest', 'agentTypewriter.catchUp', 'Skip to latest'],
      );
    }
    row.push([`${s.speed}x`, 'agentTypewriter.setSpeed', 'Playback speed'], [rowReadout(s), 'agentTypewriter.scrubber.focus', 'Show the Playback panel']);
    return row;
  }

  /** Everything the provider's answer depends on, as one string. */
  private rowKey(): string {
    const uri = this.playbackUri;
    if (!this.enabled() || !uri) return '';
    return uri.toString() + '\n' + this.row(this.snapshot()).map(([title]) => title).join('\n');
  }

  private updateContextKeys(): void {
    const paused = this.player.isPaused;
    if (paused !== this.pausedKey) {
      this.pausedKey = paused;
      void vscode.commands.executeCommand('setContext', 'agentTypewriter.paused', paused);
    }
    const changes = this.hasChanges();
    if (changes !== this.changesKey) {
      this.changesKey = changes;
      void vscode.commands.executeCommand('setContext', 'agentTypewriter.hasChanges', changes);
    }
    const path = this.playbackUri?.path;
    if (path !== this.mirrorKey) {
      this.mirrorKey = path;
      void vscode.commands.executeCommand('setContext', 'agentTypewriter.playbackMirror', path === undefined ? [] : [path]);
    }
  }
}
