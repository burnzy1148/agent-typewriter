// How the player scrolls a mirror to the next edit: which line ends up on top,
// and the top line of every frame on the way there.

/** One frame at 60 per second. */
export const SCROLL_FRAME_MS = 1000 / 60;

/** Longest a scroll takes at 1x. */
export const SCROLL_MAX_MS = 1000;

/** The top line that puts `line` mid-viewport, kept where the viewport still fits the document. */
export function centeredTop(line: number, height: number, lineCount: number): number {
  const top = line - Math.floor(height / 2);
  return Math.max(0, Math.min(top, lineCount - height));
}

/**
 * Top lines, one per frame, that scroll a `height`-line viewport from top
 * line `from` to `to`. More than two viewports away, the first frame jumps
 * to two viewports short of `to`. The rest eases in and out at about
 * `linesPerSecond`, capped at SCROLL_MAX_MS, all divided by `speed`.
 */
export function scrollSteps(from: number, to: number, height: number, linesPerSecond: number, speed: number): number[] {
  if (from === to) return [];
  const reach = 2 * Math.max(1, height);
  const steps: number[] = [];
  let start = from;
  if (Math.abs(to - from) > reach) {
    start = to - Math.sign(to - from) * reach;
    steps.push(start);
  }
  const distance = Math.abs(to - start);
  const ms = Math.min(SCROLL_MAX_MS, (distance * 1000) / Math.max(1, linesPerSecond)) / Math.max(0.1, speed);
  const frames = Math.max(1, Math.ceil(ms / SCROLL_FRAME_MS));
  for (let k = 1; k <= frames; k++) {
    const eased = (1 - Math.cos((Math.PI * k) / frames)) / 2;
    steps.push(k === frames ? to : Math.round(start + (to - start) * eased));
  }
  return steps;
}
