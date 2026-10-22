import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { renderHtml } from './scrubberHtml';
import { parseScrubberMessage, type ScrubberState } from './scrubberState';

/**
 * The "Playback" webview above the timeline tree: play/pause, seek, and speed.
 * Every control runs the matching command, so the panel never has its own
 * copy of playback logic, and state is pushed back after each change.
 */
export class ScrubberView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'agentTypewriter.scrubber';
  private view: vscode.WebviewView | undefined;
  private viewSubs: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;
  /** HTML most recently served to the webview; read by integration tests. */
  html = '';

  constructor(private readonly snapshot: () => ScrubberState) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.html = renderHtml(randomBytes(16).toString('hex'));
    view.webview.html = this.html;
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((m) => void this.receive(m)),
      view.onDidChangeVisibility(() => view.visible && this.post()),
      view.onDidDispose(() => this.disposeView()),
    );
  }

  get isResolved(): boolean {
    return this.view !== undefined;
  }

  /** Pushes fresh state to the panel, coalescing bursts into one message. */
  refresh(): void {
    if (!this.view || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 100);
  }

  /** Handles one message from the webview. Malformed messages are dropped. */
  async receive(raw: unknown): Promise<void> {
    const m = parseScrubberMessage(raw);
    if (!m) return;
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'seek':
        await vscode.commands.executeCommand('agentTypewriter.seek', m.seq);
        return;
      case 'speed':
        await vscode.commands.executeCommand('agentTypewriter.setSpeed', m.value);
        return;
      default:
        await vscode.commands.executeCommand(`agentTypewriter.${m.type}`);
    }
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.disposeView();
  }

  private post(): void {
    void this.view?.webview.postMessage(this.snapshot());
  }

  private disposeView(): void {
    for (const d of this.viewSubs.splice(0)) d.dispose();
    this.view = undefined;
  }
}
