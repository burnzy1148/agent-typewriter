import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { renderHtml } from '../src/scrubberHtml';
import type { ScrubberState } from '../src/scrubberState';

type Listener = (e: unknown) => void;

/** Just enough of an element for the panel script. */
class FakeElement {
  value = '';
  max = '';
  disabled = false;
  title = '';
  textContent = '';
  dataset: Record<string, string> = {};
  options: FakeElement[] = [];
  private listeners = new Map<string, Listener[]>();
  private classes = new Set<string>();
  readonly classList = {
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
  };

  constructor(readonly id = '') {}

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, e: unknown = { target: this }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  setAttribute(): void {}
  appendChild(child: FakeElement): void {
    this.options.push(child);
  }
}

/** Runs the panel's inline script against a fake DOM and records what it posts. */
function loadPanel() {
  const html = renderHtml('abc');
  const script = /<script nonce="abc">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'panel has an inline script');
  const ids = ['slider', 'label', 'position', 'play', 'speed', 'start', 'finish', 'next', 'latest'];
  const el = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
  for (const id of ['start', 'play', 'finish', 'next', 'latest']) el[id].dataset.cmd = id;
  el.speed.options = [0.5, 1, 2].map((s) => Object.assign(new FakeElement(), { value: String(s) }));
  const body = new FakeElement('body');
  const doc = Object.assign(new FakeElement('document'), {
    body,
    activeElement: body as FakeElement,
    getElementById: (id: string) => el[id],
    querySelectorAll: () => ['start', 'play', 'finish', 'next', 'latest'].map((id) => el[id]),
    createElement: () => new FakeElement(),
  });
  const win = new FakeElement('window');
  const posted: unknown[] = [];
  const timers: Array<() => void> = [];
  vm.runInNewContext(script, {
    document: doc,
    window: win,
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(m) }),
    setTimeout: (fn: () => void) => timers.push(fn),
  });
  return {
    el,
    posted,
    seeks: () => posted.flatMap((m) => ((m as { type: string }).type === 'seek' ? [(m as { seq: number }).seq] : [])),
    state: (s: Partial<ScrubberState>) => win.dispatch('message', { data: { ...STATE, ...s } }),
    pointerup: () => win.dispatch('pointerup'),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

const STATE: ScrubberState = {
  type: 'state',
  changes: [1, 2, 3, 4, 5].map((seq) => ({ seq, relPath: `f${seq}.ts`, kind: 'modify' as const })),
  index: 1,
  playingSeq: 2,
  queued: 3,
  paused: false,
  speed: 1,
  watching: true,
};

test('keyboard steps on the slider seek to the stepped-to change', () => {
  const p = loadPanel();
  p.state({});
  assert.equal(p.el.slider.value, '1');
  for (const value of ['2', '3', '5']) {
    p.el.slider.value = value;
    p.el.slider.dispatch('input');
    p.el.slider.dispatch('change');
    // The value stays where the keyboard put it until the next state message.
    assert.equal(p.el.slider.value, value);
  }
  assert.deepEqual(p.seeks(), [3, 4, 6]);
  assert.equal(p.el.label.textContent, 'Seek to latest');
  p.state({ index: 5, playingSeq: undefined, queued: 0 });
  assert.equal(p.el.slider.value, '5');
  assert.equal(p.el.label.textContent, 'Caught up');
});

test('dragging the slider seeks once to the released position', () => {
  const p = loadPanel();
  p.state({});
  p.el.slider.dispatch('pointerdown');
  p.el.slider.value = '2';
  p.el.slider.dispatch('input');
  assert.equal(p.el.label.textContent, 'Seek to #3 f3.ts');
  // A state push mid-drag does not move the thumb.
  p.state({});
  assert.equal(p.el.slider.value, '2');
  assert.equal(p.el.label.textContent, 'Seek to #3 f3.ts');
  p.el.slider.value = '4';
  p.el.slider.dispatch('input');
  p.pointerup();
  p.el.slider.dispatch('change');
  assert.deepEqual(p.seeks(), [5]);
  p.runTimers();
  p.state({ index: 4, playingSeq: undefined, queued: 1 });
  assert.equal(p.el.slider.value, '4');
  assert.equal(p.el.label.textContent, 'Next: #5 f5.ts · 1 queued');
});
