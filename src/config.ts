import * as vscode from 'vscode';
import type { FilterSettings } from './filter';
import { resolveReorderWindow } from './reorder';
import { mergeProfiles, parseProfiles, type FilterProfile, type Profiles } from './profiles';
import { pickLayer, REPO_SETTING_KINDS, type RepoValues } from './repoSettings';
import { isFiniteNumber, numberSetting } from './numberSetting';
import { resolveCharsPerMinute } from './pace';

export const SECTION = 'agentTypewriter';

export interface Settings extends FilterSettings {
  /** Also skip paths git reports as ignored. */
  respectGitignore: boolean;
  /** Raw `activeProfile`; it may name no profile (see activeProfileOf). */
  activeProfile: string;
  /** Profiles from user settings, the repository file, and workspace settings, merged by name. */
  profiles: Profiles;
  autoStart: boolean;
  charsPerMinute: number;
  /** The base speed came from the deprecated `charsPerSecond` setting. */
  speedFromDeprecatedSetting: boolean;
  /** Language id → base chars per minute. Raw from settings; pace.ts ignores bad entries. */
  languageSpeeds: Record<string, unknown>;
  jitter: number;
  catchUpFactor: number;
  maxSpeedup: number;
  maxAnimatedChars: number;
  fileSwitchDelayMs: number;
  /** Scroll to the next edit in the same file instead of jumping. */
  smoothScroll: boolean;
  scrollPauseMs: number;
  scrollLinesPerSecond: number;
  /** Walk the caret to nearby edits with arrow keys instead of clicking there. */
  arrowNavigation: boolean;
  arrowKeysPerSecond: number;
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
  /** Show the CodeLens status row on the playback mirror. */
  mirrorStatusRow: boolean;
  /** Keep added text highlighted until cleared, instead of a brief flash. */
  highlightAdditions: boolean;
  /** Preview deletions in red and mark where text was removed. */
  markDeletions: boolean;
  /** Give worktrees added while recording their own lane: never, while there is room, or by stopping the idlest lane. */
  autoRecordWorktrees: 'off' | 'fill' | 'rotate';
  /** Move playback to the lane with the oldest queued change once the followed lane is caught up and idle. */
  autoFollow: boolean;
}

/** Values from the repository settings file; they sit between user and workspace settings. */
let repoValues: RepoValues = {};

export function setRepoValues(values: RepoValues): void {
  repoValues = values;
}

/** Of these repository file keys, the ones a workspace setting overrides (a wrong-typed one does not). */
export function workspaceOverrides(keys: string[]): string[] {
  const c = vscode.workspace.getConfiguration(SECTION);
  return keys.filter((k) => {
    const v = c.inspect(k)?.workspaceValue;
    return v !== undefined && (checkFor(k)?.(v) ?? true);
  });
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const c = layered(cfg);
  const profiles = resolveProfiles(cfg);
  const rawActive = c.get<unknown>('activeProfile', '');
  const activeProfile = typeof rawActive === 'string' ? rawActive : '';
  // The active profile's filters sit between the repository file and workspace settings.
  const f = layered(cfg, Object.hasOwn(profiles, activeProfile) ? profiles[activeProfile] : undefined);
  // A wrong-typed value counts as unset; numbers are then clamped.
  const num = (key: string, fallback: number, min?: number, max?: number) =>
    numberSetting(c.get(key, fallback, isFiniteNumber), fallback, min, max);
  const speed = resolveSpeed(cfg);
  return {
    autoStart: c.get('autoStart', false),
    include: f.get('include', ['**/*'], isStringArray),
    exclude: f.get('exclude', [], isStringArray),
    extensions: f.get('extensions', [], isStringArray),
    respectGitignore: f.get('respectGitignore', false),
    activeProfile,
    profiles,
    charsPerMinute: speed.charsPerMinute,
    speedFromDeprecatedSetting: speed.fromDeprecated,
    languageSpeeds: asRecord(c.get<unknown>('languageSpeeds', {})),
    jitter: num('jitter', 0.6, 0, 1),
    catchUpFactor: num('catchUpFactor', 0.5, 0),
    maxSpeedup: num('maxSpeedup', 8, 1),
    maxAnimatedChars: num('maxAnimatedChars', 6000),
    fileSwitchDelayMs: num('fileSwitchDelayMs', 600, 0),
    smoothScroll: c.get('smoothScroll', true),
    scrollPauseMs: num('scrollPauseMs', 400, 0, 5000),
    scrollLinesPerSecond: num('scrollLinesPerSecond', 60, 1),
    arrowNavigation: c.get('arrowNavigation', true),
    arrowKeysPerSecond: num('arrowKeysPerSecond', 15, 1),
    debounceMs: num('debounceMs', 200, 0),
    reorderWindowMs: resolveReorderWindow(c.get<unknown>('reorderWindowMs', 'auto'), process.platform),
    maxFileSizeKB: num('maxFileSizeKB', 512, 1),
    gitBaselines: c.get('gitBaselines', true),
    baselineBudgetMB: num('baselineBudgetMB', 256, 0),
    historyLimit: num('historyLimit', 500, 10),
    persistHistory: c.get('persistHistory', true),
    ignoreOwnSaves: c.get('ignoreOwnSaves', true),
    viewColumn: c.get('viewColumn', 'beside'),
    mirrorStatusRow: c.get('mirrorStatusRow', true),
    autoRecordWorktrees: oneOf(c.get<unknown>('autoRecordWorktrees', 'off'), ['off', 'fill', 'rotate'] as const, 'off'),
    autoFollow: c.get<unknown>('autoFollow', false) === true,
    ...readHighlightSettings(),
  };
}

/** `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Only the highlight settings; the highlight view reads them on every render. */
export function readHighlightSettings(): Pick<Settings, 'highlightAdditions' | 'markDeletions'> {
  const c = layered(vscode.workspace.getConfiguration(SECTION));
  return { highlightAdditions: c.get('highlightAdditions', true), markDeletions: c.get('markDeletions', true) };
}

/** Only `mirrorStatusRow`; the CodeLens provider reads it on every request. */
export function readMirrorStatusRow(): boolean {
  return layered(vscode.workspace.getConfiguration(SECTION)).get('mirrorStatusRow', true);
}

/** True when commands write workspace settings; false when no folder is open and they write user settings. */
export function writesWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

/** Writes to workspace settings when a folder is open, otherwise user settings. */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  const target = writesWorkspace() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

/**
 * The `profiles` object exactly as stored where updateSetting writes, unvalidated,
 * so saving a profile keeps every other entry as the user wrote it.
 */
export function storedProfiles(): Record<string, unknown> {
  const i = vscode.workspace.getConfiguration(SECTION).inspect<unknown>('profiles');
  return asRecord(writesWorkspace() ? i?.workspaceValue : i?.globalValue);
}

/**
 * Reads like `cfg.get`, with repository file values slotted between user and
 * workspace settings, and the active profile's values just above the file.
 * With `valid`, a value that fails it is treated as unset and the next layer
 * applies, down to `fallback`.
 */
function layered(cfg: vscode.WorkspaceConfiguration, profile?: FilterProfile) {
  const above = (profile ?? {}) as Record<string, unknown>;
  return {
    get: <T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T => {
      const below = () => {
        const v = cfg.get<unknown>(key, fallback);
        if (!valid || valid(v)) return v;
        // cfg.get prefers the workspace value; when that one is wrong-typed, try the user setting, then the contributed default.
        const i = cfg.inspect<unknown>(key);
        return [i?.globalValue, i?.defaultValue].find(valid);
      };
      return pickLayer(cfg.inspect<unknown>(key)?.workspaceValue, above[key] ?? repoValues[key], below, valid && { valid, fallback });
    },
  };
}

/**
 * charsPerMinute, with the deprecated charsPerSecond (times 60) standing in
 * for it in any layer that sets only the old key, so the layers keep their order.
 */
function resolveSpeed(cfg: vscode.WorkspaceConfiguration) {
  const perMinute = cfg.inspect<unknown>('charsPerMinute');
  const perSecond = cfg.inspect<unknown>('charsPerSecond');
  return resolveCharsPerMinute([
    { charsPerMinute: perMinute?.workspaceValue, charsPerSecond: perSecond?.workspaceValue },
    { charsPerMinute: repoValues.charsPerMinute, charsPerSecond: repoValues.charsPerSecond },
    { charsPerMinute: perMinute?.globalValue, charsPerSecond: perSecond?.globalValue },
  ]);
}

/** `profiles` is merged by name across layers instead of replaced whole. */
function resolveProfiles(cfg: vscode.WorkspaceConfiguration): Profiles {
  const i = cfg.inspect<unknown>('profiles');
  return mergeProfiles(
    parseProfiles(i?.globalValue).profiles,
    repoValues.profiles as Profiles | undefined,
    parseProfiles(i?.workspaceValue).profiles,
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The type check readSettings applies to a setting, if any. */
function checkFor(key: string): ((v: unknown) => boolean) | undefined {
  const kind = Object.hasOwn(REPO_SETTING_KINDS, key) ? REPO_SETTING_KINDS[key] : undefined;
  return kind === 'number' ? isFiniteNumber : kind === 'stringArray' ? isStringArray : undefined;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
