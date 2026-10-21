import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
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

const SPEEDS = [0.5, 1, 1.5, 2, 3, 5];

const icon = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
const ICONS = {
  start: icon('<rect x="3" y="3" width="2" height="10"/><polygon points="13,3 13,13 6,8"/>'),
  play: icon('<polygon points="4,2 14,8 4,14"/>'),
  pause: icon('<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>'),
  finish: icon('<polygon points="9,1 3,9 7.5,9 6,15 13,6 8.5,6 10,1"/>'),
  next: icon('<polygon points="3,3 10,8 3,13"/><rect x="11" y="3" width="2" height="10"/>'),
  latest: icon('<polygon points="1,3 7,8 1,13"/><polygon points="7,3 13,8 7,13"/><rect x="13" y="3" width="2" height="10"/>'),
};

function renderHtml(nonce: string): string {
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  const options = SPEEDS.map((s) => `<option value="${s}">${s}x</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 6px 12px 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .row { display: flex; align-items: center; gap: 4px; }
  .spacer { flex: 1; }
  button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
    border: none; border-radius: 5px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; }
  button svg { fill: currentColor; }
  button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button:disabled { opacity: 0.4; cursor: default; }
  #play { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #play:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  #play .when-paused, #play.paused .when-playing { display: none; }
  #play.paused .when-paused { display: inline-flex; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; padding: 2px 4px; font: inherit; }
  input[type=range] { width: 100%; margin: 10px 0 4px; accent-color: var(--vscode-button-background); }
  .status { display: flex; gap: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  #label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #position { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <div class="row">
    <button id="start" data-cmd="replayAll" title="Replay from the start" aria-label="Replay from the start">${ICONS.start}</button>
    <button id="play" data-cmd="togglePause" title="Pause" aria-label="Pause"><span class="when-playing">${ICONS.pause}</span><span class="when-paused">${ICONS.play}</span></button>
    <button id="finish" data-cmd="finishCurrent" title="Finish current change instantly" aria-label="Finish current change instantly">${ICONS.finish}</button>
    <button id="next" data-cmd="skipToNext" title="Skip to next change" aria-label="Skip to next change">${ICONS.next}</button>
    <button id="latest" data-cmd="catchUp" title="Skip to latest" aria-label="Skip to latest">${ICONS.latest}</button>
    <span class="spacer"></span>
    <select id="speed" title="Playback speed" aria-label="Playback speed">${options}</select>
  </div>
  <input id="slider" type="range" min="0" max="0" value="0" step="1" aria-label="Playback position">
  <div class="status"><span id="label" aria-live="polite"></span><span id="position"></span></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const slider = $('slider'), label = $('label'), position = $('position'), play = $('play'), speed = $('speed');
  let state;
  let held = false;

  const describe = (c) => '#' + c.seq + ' ' + c.relPath;

  function statusText() {
    const n = state.changes.length;
    if (n === 0) return state.watching ? 'Waiting for changes' : 'Not watching';
    const queued = state.queued ? ' \\u00b7 ' + state.queued + ' queued' : '';
    const playing = state.changes.find((c) => c.seq === state.playingSeq);
    if (playing) return (state.paused ? 'Paused in ' : 'Typing ') + describe(playing) + queued;
    if (state.index >= n) return 'Caught up';
    return (state.paused ? 'Paused before ' : 'Next: ') + describe(state.changes[state.index]) + queued;
  }

  function seekText(i) {
    const n = state.changes.length;
    return i >= n ? 'Seek to latest' : 'Seek to ' + describe(state.changes[i]);
  }

  function render() {
    if (!state) return;
    const n = state.changes.length;
    slider.max = String(n);
    slider.disabled = n === 0;
    if (!held) slider.value = String(state.index);
    for (const id of ['start', 'finish', 'next', 'latest']) $(id).disabled = n === 0;
    play.classList.toggle('paused', state.paused);
    play.title = state.paused ? 'Play' : 'Pause';
    play.setAttribute('aria-label', play.title);
    const value = String(state.speed);
    if (![...speed.options].some((o) => o.value === value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value + 'x';
      speed.appendChild(o);
    }
    if (document.activeElement !== speed) speed.value = value;
    label.textContent = held ? seekText(Number(slider.value)) : statusText();
    position.textContent = Math.min(state.index + 1, n) + ' / ' + n;
  }

  for (const b of document.querySelectorAll('button[data-cmd]')) {
    b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.cmd }));
  }
  speed.addEventListener('change', () => vscode.postMessage({ type: 'speed', value: Number(speed.value) }));
  slider.addEventListener('pointerdown', () => { held = true; });
  // The slider's change event comes after pointerup; let it read the dragged value first.
  window.addEventListener('pointerup', () => {
    if (held) setTimeout(() => { held = false; render(); }, 0);
  });
  slider.addEventListener('input', render);
  slider.addEventListener('change', () => {
    const n = state ? state.changes.length : 0;
    if (n === 0) return;
    const i = Number(slider.value);
    const seq = i >= n ? state.changes[n - 1].seq + 1 : state.changes[i].seq;
    vscode.postMessage({ type: 'seek', seq });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      vscode.postMessage({ type: 'togglePause' });
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
