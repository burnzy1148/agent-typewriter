// Shared setup for the recorderScope*.test.ts files, split so node --test runs
// them in parallel. Runs the real Recorder on real files and git repositories,
// with 'vscode' replaced by test/vscode-mock.ts.
import { afterEach } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Recorder, type CheckoutChoices } from '../src/recorder';
import { Timeline } from '../src/timeline';
import { listWorktrees, type WorktreeListResult } from '../src/worktrees';
import type { Settings } from '../src/config';
import { mock } from './vscode-mock';
import { git, tempRepo, write } from './gitFixture';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longer than the recorder's quiet period for deletes in a chosen worktree. */
export const HOLD_MS = 3600;

export function settings(over: Partial<Settings> = {}): Settings {
  return {
    autoStart: false,
    include: ['**/*'],
    exclude: ['**/.git/**', '**/node_modules/**'],
    extensions: ['ts'],
    respectGitignore: false,
    activeProfile: '',
    profiles: {},
    charsPerMinute: 2100,
    speedFromDeprecatedSetting: false,
    languageSpeeds: {},
    jitter: 0,
    catchUpFactor: 0,
    maxSpeedup: 1,
    maxAnimatedChars: 6000,
    fileSwitchDelayMs: 0,
    smoothScroll: false,
    readPauseSeconds: 0,
    readPauseFromDeprecatedSetting: false,
    scrollLinesPerSecond: 60,
    arrowNavigation: false,
    arrowKeysPerSecond: 15,
    debounceMs: 50,
    reorderWindowMs: 0,
    maxFileSizeKB: 512,
    gitBaselines: true,
    baselineBudgetMB: 256,
    historyLimit: 500,
    persistHistory: false,
    ignoreOwnSaves: true,
    ignoreGitOperations: true,
    viewColumn: 'beside',
    mirrorStatusRow: true,
    highlightAdditions: true,
    markDeletions: true,
    autoRecordWorktrees: 'off',
    autoFollow: false,
    ...over,
  };
}

let current: Recorder | undefined;

/** Disposes this recorder after the test, along with the mock's state. */
export function track(recorder: Recorder): void {
  current = recorder;
}

afterEach(() => {
  current?.dispose();
  current = undefined;
  mock.reset();
});

export interface Options {
  choices?: CheckoutChoices;
  lister?: (folder: string) => Promise<WorktreeListResult>;
}

export function recorderOn(s: Settings, opts: Options, dir: string) {
  mock.open(dir);
  const timeline = new Timeline(1000);
  const logs: string[] = [];
  const log = { appendLine: (l: string) => logs.push(l) } as unknown as vscode.OutputChannel;
  const recorder = new Recorder(timeline, () => s, log, opts.choices, opts.lister);
  track(recorder);
  const folder = mock.folders[0] as unknown as vscode.WorkspaceFolder;
  const uri = (file: string) => vscode.Uri.file(file);
  const fire = (kind: 'create' | 'change' | 'delete', file: string) => mock.fire(kind, file);
  /** Writes the file and reports it, as an agent's write and the watcher would. */
  const change = (file: string, text: string, kind: 'create' | 'change' = 'change') => {
    write(path.dirname(file), path.basename(file), text);
    fire(kind, file);
  };
  /** Waits for every debounce and read to finish, then hands held changes to the timeline. */
  const settle = async (extra = 0) => {
    await sleep(s.debounceMs + 150 + extra);
    for (let i = 0; i < 250 && !recorder.describeActivity().includes('debouncing: none; reading: 0;'); i++) await sleep(20);
    await sleep(50);
    recorder.drainHeld();
  };
  const events = () => timeline.all().map((e) => `${e.kind} ${e.relPath}`);
  const checkout = () => recorder.checkoutOf(folder);
  return { recorder, timeline, logs, folder, uri, fire, change, settle, events, checkout };
}

export async function until(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export function committedRepo(files: Record<string, string>, prefix = 'at-rs-'): string {
  const repo = tempRepo(prefix);
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/** A repository with a sibling worktree `side` outside it, chosen for the folder. */
export function repoWithChosenSibling(files: Record<string, string>) {
  const repo = committedRepo(files);
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  const choices = new Map<string, string>([[vscode.Uri.file(repo).toString(), side]]);
  return { repo, side, choices };
}

/** Choices that keep each value in memory but fail to save it, as a read-only checkouts.json does. */
export class UnsavableChoices implements CheckoutChoices {
  readonly map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: string | undefined): Error {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return new Error('EACCES: permission denied');
  }
}

/** Deletes a path, retrying for a while when Windows reports it busy or locked. */
export async function rm(p: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt >= 100) throw err;
      await sleep(100);
    }
  }
}

export const doc = (file: string, text: string) => ({ uri: vscode.Uri.file(file), getText: () => text });
export const live = () => mock.watchers.filter((w) => !w.disposed).length;


export function flakyLister() {
  const state = { fail: false, calls: 0 };
  const lister = async (folder: string): Promise<WorktreeListResult> => {
    state.calls++;
    return state.fail ? { kind: 'unavailable', reason: 'spawn git EAGAIN' } : listWorktrees(folder);
  };
  return { state, lister };
}
/** A repository with a nested worktree `feat` and a sibling worktree `side`. */
export function repoWithWorktrees(files: Record<string, string>) {
  const repo = committedRepo(files);
  const nested = path.join(repo, '.worktrees', 'feat');
  const side = `${repo}-side`;
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', nested);
  git(repo, 'worktree', 'add', '-q', '-b', 'side', side);
  return { repo, nested, side };
}

export const laneOf = (t: ReturnType<typeof recorderOn>, i: number) => t.timeline.all()[i]?.lane;
/** Adds a sibling worktree and reports it the way git's common directory watcher would. */
export function addWorktree(t: ReturnType<typeof recorderOn>, repo: string, name: string): string {
  const dir = `${repo}-${name}`;
  git(repo, 'worktree', 'add', '-q', '-b', name, dir);
  t.fire('create', path.join(fs.realpathSync.native(repo), '.git', 'worktrees', path.basename(dir)));
  return dir;
}
