import * as vscode from 'vscode';
import { MirrorFileSystem } from './mirrorFs';
import type { Player } from './player';
import type { ScrubberState } from './scrubberState';

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
  private pausedKey: boolean | undefined;
  private mirrorKey: string | undefined | null = null;

  constructor(
    private readonly player: Player,
    private readonly snapshot: () => ScrubberState,
    private readonly enabled: () => boolean,
  ) {
    this.subscription = player.onDidChangePlaybackMirror(() => this.refresh());
  }

  /** URI of the playback mirror, if anything has been played. */
  get playbackUri(): vscode.Uri | undefined {
    const rel = this.player.playbackRelPath;
    return rel === undefined ? undefined : MirrorFileSystem.uriFor(rel);
  }

  /** Updates the context keys now and the CodeLens row soon, coalescing bursts. */
  refresh(): void {
    this.updateContextKeys();
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.changed.fire();
    }, 100);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const uri = this.playbackUri;
    if (!this.enabled() || !uri || doc.uri.toString() !== uri.toString()) return [];
    const s = this.snapshot();
    const empty = s.changes.length === 0;
    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (title: string, command: string, tooltip: string) => new vscode.CodeLens(top, { title, command, tooltip });
    const lenses = [
      s.paused
        ? lens('$(play) Play', 'agentTypewriter.resume', 'Resume playback')
        : lens('$(debug-pause) Pause', 'agentTypewriter.pause', 'Pause playback'),
    ];
    if (!empty) {
      lenses.push(
        lens('$(zap) Finish', 'agentTypewriter.finishCurrent', 'Finish current change instantly'),
        lens('$(arrow-right) Next', 'agentTypewriter.skipToNext', 'Skip to next change'),
        lens('$(debug-continue) Latest', 'agentTypewriter.catchUp', 'Skip to latest'),
      );
    }
    lenses.push(
      lens(`${s.speed}x`, 'agentTypewriter.setSpeed', 'Playback speed'),
      lens(`${s.label} · ${s.position}`, 'agentTypewriter.scrubber.focus', 'Show the Playback panel'),
    );
    return lenses;
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.subscription.dispose();
    this.changed.dispose();
  }

  private updateContextKeys(): void {
    const paused = this.player.isPaused;
    if (paused !== this.pausedKey) {
      this.pausedKey = paused;
      void vscode.commands.executeCommand('setContext', 'agentTypewriter.paused', paused);
    }
    const path = this.playbackUri?.path;
    if (path !== this.mirrorKey) {
      this.mirrorKey = path;
      void vscode.commands.executeCommand('setContext', 'agentTypewriter.playbackMirror', path === undefined ? [] : [path]);
    }
  }
}
