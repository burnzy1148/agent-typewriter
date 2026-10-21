import * as vscode from 'vscode';
import type { FilterSettings } from './filter';
import { resolveReorderWindow } from './reorder';
import { pickLayer, type RepoValues } from './repoSettings';

export const SECTION = 'agentTypewriter';

export interface Settings extends FilterSettings {
  autoStart: boolean;
  charsPerSecond: number;
  /** Language id → base chars per second. Raw from settings; pace.ts ignores bad entries. */
  languageSpeeds: Record<string, unknown>;
  jitter: number;
  catchUpFactor: number;
  maxSpeedup: number;
  maxAnimatedChars: number;
  fileSwitchDelayMs: number;
  debounceMs: number;
  /** Resolved reorder window in ms ("auto" already mapped to the platform default). */
  reorderWindowMs: number;
  maxFileSizeKB: number;
  /** Use git index blobs as baselines for clean tracked files when git is available. */
  gitBaselines: boolean;
  /** Size budget for in-memory baselines. */
  baselineBudgetMB: number;
  historyLimit: number;
  /** Keep the timeline in workspace storage across reloads. */
  persistHistory: boolean;
  ignoreOwnSaves: boolean;
  viewColumn: 'beside' | 'active';
}

/** Values from the repository settings file; they sit between user and workspace settings. */
let repoValues: RepoValues = {};

export function setRepoValues(values: RepoValues): void {
  repoValues = values;
}

/** Of these repository file keys, the ones a workspace setting overrides. */
export function workspaceOverrides(keys: string[]): string[] {
  const c = vscode.workspace.getConfiguration(SECTION);
  return keys.filter((k) => c.inspect(k)?.workspaceValue !== undefined);
}

export function readSettings(): Settings {
  const c = layered(vscode.workspace.getConfiguration(SECTION));
  return {
    autoStart: c.get('autoStart', false),
    include: c.get('include', ['**/*']),
    exclude: c.get('exclude', []),
    extensions: c.get('extensions', []),
    charsPerSecond: Math.max(1, c.get('charsPerSecond', 35)),
    languageSpeeds: asRecord(c.get<unknown>('languageSpeeds', {})),
    jitter: clamp(c.get('jitter', 0.6), 0, 1),
    catchUpFactor: Math.max(0, c.get('catchUpFactor', 0.5)),
    maxSpeedup: Math.max(1, c.get('maxSpeedup', 8)),
    maxAnimatedChars: c.get('maxAnimatedChars', 6000),
    fileSwitchDelayMs: Math.max(0, c.get('fileSwitchDelayMs', 600)),
    debounceMs: Math.max(0, c.get('debounceMs', 200)),
    reorderWindowMs: resolveReorderWindow(c.get<unknown>('reorderWindowMs', 'auto'), process.platform),
    maxFileSizeKB: Math.max(1, c.get('maxFileSizeKB', 512)),
    gitBaselines: c.get('gitBaselines', true),
    baselineBudgetMB: Math.max(0, c.get('baselineBudgetMB', 256)),
    historyLimit: Math.max(10, c.get('historyLimit', 500)),
    persistHistory: c.get('persistHistory', true),
    ignoreOwnSaves: c.get('ignoreOwnSaves', true),
    viewColumn: c.get('viewColumn', 'beside'),
  };
}

/** Writes to workspace settings when a folder is open, otherwise user settings. */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

/** Reads like `cfg.get`, with repository file values slotted between user and workspace settings. */
function layered(cfg: vscode.WorkspaceConfiguration) {
  return {
    get: <T>(key: string, fallback: T): T =>
      pickLayer(cfg.inspect<T>(key)?.workspaceValue, repoValues[key], () => cfg.get<T>(key, fallback)),
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
