// Types for core.mjs, the bundle scripts/build-claude-code.mjs makes from
// src/planner.ts and src/typingChunks.ts. Keep in step with those files.

/** One edit to type; each offset is into the text after every earlier hunk. */
export interface Hunk {
  offset: number;
  deleteText: string;
  insertText: string;
  continues?: boolean;
}

export function planHunks(before: string, after: string, maxLineEdits?: number): Hunk[];
export function authoringOrder(hunks: Hunk[], after: string): Hunk[];
export function typingChunkEnd(text: string, i: number, perTick: number): number;
export function backspaceStep(deleted: string, remaining: number, step: number): number;
