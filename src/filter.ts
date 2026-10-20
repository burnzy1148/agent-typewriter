import { minimatch } from 'minimatch';

export interface FilterSettings {
  include: string[];
  exclude: string[];
  /** Extensions without the leading dot, any case. Empty = any extension. */
  extensions: string[];
}

/**
 * Decides whether a workspace-relative path should be recorded.
 * Order: extension allow-list, then exclude globs, then include globs.
 */
export class PathFilter {
  private readonly include: string[];
  private readonly exclude: string[];
  private readonly extensions: Set<string>;

  constructor(settings: FilterSettings) {
    this.include = clean(settings.include);
    this.exclude = clean(settings.exclude);
    this.extensions = new Set(
      settings.extensions.map((e) => e.trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean),
    );
  }

  matches(relPath: string): boolean {
    const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (this.extensions.size > 0 && !this.extensions.has(extensionOf(path))) return false;
    if (this.exclude.some((g) => globMatch(path, g))) return false;
    if (this.include.length === 0) return true;
    return this.include.some((g) => globMatch(path, g));
  }

  describe(): string {
    const parts: string[] = [];
    if (this.extensions.size > 0) parts.push([...this.extensions].map((e) => '.' + e).join(' '));
    const inc = this.include.filter((g) => g !== '**/*' && g !== '**');
    if (inc.length > 0) parts.push(inc.join(', '));
    return parts.length > 0 ? parts.join(' in ') : 'all files';
  }
}

function clean(globs: string[]): string[] {
  return globs.map((g) => g.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

function globMatch(path: string, glob: string): boolean {
  // A pattern with no slash ("*.ts", "Dockerfile") matches the file name anywhere.
  return minimatch(path, glob, { dot: true, matchBase: !glob.includes('/'), nocase: false });
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Parses "ts, .java  md" style user input into ["ts","java","md"]. */
export function parseExtensionList(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((e) => e.trim().replace(/^\*?\./, '').toLowerCase())
    .filter(Boolean);
}
