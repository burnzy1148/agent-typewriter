/** Committable per-repository settings, read from the first workspace folder's root. */
export const REPO_SETTINGS_FILE = '.agent-typewriter.json';

type Kind = 'boolean' | 'number' | 'stringArray' | 'object' | 'stringOrNumber' | { enum: readonly string[] };

/** Every `agentTypewriter.*` setting, without the prefix, and the JSON shape the file must use for it. */
export const REPO_SETTING_KINDS: Readonly<Record<string, Kind>> = {
  autoStart: 'boolean',
  include: 'stringArray',
  exclude: 'stringArray',
  extensions: 'stringArray',
  respectGitignore: 'boolean',
  charsPerSecond: 'number',
  languageSpeeds: 'object',
  jitter: 'number',
  catchUpFactor: 'number',
  maxSpeedup: 'number',
  maxAnimatedChars: 'number',
  fileSwitchDelayMs: 'number',
  debounceMs: 'number',
  reorderWindowMs: 'stringOrNumber',
  maxFileSizeKB: 'number',
  gitBaselines: 'boolean',
  baselineBudgetMB: 'number',
  historyLimit: 'number',
  persistHistory: 'boolean',
  ignoreOwnSaves: 'boolean',
  viewColumn: { enum: ['beside', 'active'] },
};

export type RepoValues = Readonly<Record<string, unknown>>;

export type ParseResult =
  | { ok: true; values: RepoValues; problems: string[] }
  | { ok: false; error: string };

/** Parses the file. Bad entries are dropped and listed in `problems`; only unusable files fail. */
export function parseRepoSettings(text: string): ParseResult {
  if (text.trim() === '') return { ok: true, values: {}, problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!isObject(raw)) return { ok: false, error: 'the file must contain a JSON object' };
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') continue;
    const kind = Object.hasOwn(REPO_SETTING_KINDS, key) ? REPO_SETTING_KINDS[key] : undefined;
    if (!kind) problems.push(`"${key}" is not an Agent Typewriter setting; ignored.`);
    else if (!fits(value, kind)) problems.push(`"${key}" should be ${describeKind(kind)}; ignored.`);
    else values[key] = value;
  }
  return { ok: true, values, problems };
}

/**
 * Resolves one setting: workspace value, then the repository file, then
 * whatever VS Code resolves below workspace (user setting or default).
 */
export function pickLayer<T>(workspaceValue: T | undefined, repoValue: unknown, below: () => T): T {
  if (workspaceValue !== undefined) return workspaceValue;
  if (repoValue !== undefined) return repoValue as T;
  return below();
}

/** Keys whose value differs between two parsed files. */
export function changedKeys(a: RepoValues, b: RepoValues): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function fits(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'stringArray':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'object':
      return isObject(value);
    case 'stringOrNumber':
      return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    default:
      return typeof value === 'string' && kind.enum.includes(value);
  }
}

function describeKind(kind: Kind): string {
  switch (kind) {
    case 'boolean':
      return 'true or false';
    case 'number':
      return 'a number';
    case 'stringArray':
      return 'an array of strings';
    case 'object':
      return 'an object';
    case 'stringOrNumber':
      return 'a string or a number';
    default:
      return `one of ${kind.enum.map((v) => `"${v}"`).join(', ')}`;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
