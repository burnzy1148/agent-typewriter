/** The Playback panel's HTML and inline script. No vscode import, so unit tests can run the script. */

const SPEEDS = [0.5, 1, 1.5, 2, 3, 5];

const icon = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
const ICONS = {
  start: icon('<rect x="3" y="3" width="2" height="10"/><polygon points="13,3 13,13 6,8"/>'),
  play: icon('<polygon points="4,2 14,8 4,14"/>'),
  pause: icon('<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>'),
  finish: icon('<polygon points="9,1 3,9 7.5,9 6,15 13,6 8.5,6 10,1"/>'),
  next: icon('<polygon points="3,3 10,8 3,13"/><rect x="11" y="3" width="2" height="10"/>'),
  latest: icon('<polygon points="1,3 7,8 1,13"/><polygon points="7,3 13,8 7,13"/><rect x="13" y="3" width="2" height="10"/>'),
  clear: icon(
    '<rect x="1" y="3" width="9" height="1.5"/><rect x="1" y="7" width="7" height="1.5"/><rect x="1" y="11" width="5" height="1.5"/>' +
      '<path d="M9.5 9.5l5 5M14.5 9.5l-5 5" stroke="currentColor" stroke-width="1.5"/>',
  ),
};

export function renderHtml(nonce: string): string {
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
    <button id="clear" data-cmd="clearHighlights" title="Clear highlights" aria-label="Clear highlights">${ICONS.clear}</button>
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

  const describe = (c) => '#' + c.seq + ' ' + (c.fromRelPath !== undefined ? c.fromRelPath + ' \u2192 ' : '') + c.relPath;

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
    $('clear').disabled = !state.hasHighlights;
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
    label.textContent = held ? seekText(Number(slider.value)) : (state.lane ? state.lane + ' \u00b7 ' : '') + state.label;
    position.textContent = state.position;
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
  // Only the label: render() would reset a keyboard-moved value before its change event reads it.
  slider.addEventListener('input', () => {
    if (state) label.textContent = seekText(Number(slider.value));
  });
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
