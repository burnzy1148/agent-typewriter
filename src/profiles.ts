/** Named filter sets: `agentTypewriter.profiles` and the repository file's `profiles`, merged by name. */
export const PROFILE_KEYS = ['include', 'exclude', 'extensions', 'respectGitignore'] as const;

export interface FilterProfile {
  include?: string[];
  exclude?: string[];
  extensions?: string[];
  respectGitignore?: boolean;
}

export type Profiles = Readonly<Record<string, FilterProfile>>;

/** Keeps valid profiles and entries; everything dropped is listed in `problems`. */
export function parseProfiles(raw: unknown): { profiles: Record<string, FilterProfile>; problems: string[] } {
  const profiles: Record<string, FilterProfile> = {};
  const problems: string[] = [];
  if (raw === undefined) return { profiles, problems };
  if (!isObject(raw)) return { profiles, problems: ['"profiles" should be an object of named profiles; ignored.'] };
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      problems.push(`profile "${name}" should be an object; ignored.`);
      continue;
    }
    const profile: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
        problems.push(`profile "${name}": "${key}" is not a filter setting; ignored.`);
      } else if (key === 'respectGitignore' ? typeof v !== 'boolean' : !isStringArray(v)) {
        problems.push(`profile "${name}": "${key}" should be ${key === 'respectGitignore' ? 'true or false' : 'an array of strings'}; ignored.`);
      } else {
        profile[key] = v;
      }
    }
    profiles[name] = profile as FilterProfile;
  }
  return { profiles, problems };
}

/** Combines layers by name, lowest priority first; a higher layer's profile replaces a lower one's whole. */
export function mergeProfiles(...layers: (Profiles | undefined)[]): Profiles {
  return Object.assign({}, ...layers.filter(Boolean));
}

/** The active profile, or undefined when none is chosen or the name is unknown. */
export function activeProfileOf(s: { activeProfile: string; profiles: Profiles }): FilterProfile | undefined {
  return s.activeProfile !== '' && Object.hasOwn(s.profiles, s.activeProfile) ? s.profiles[s.activeProfile] : undefined;
}

/** One-line summary for pickers, e.g. "include: docs/** · extensions: md". */
export function describeProfile(p: FilterProfile): string {
  const parts = Object.entries(p).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') || '(none)' : String(v)}`);
  return parts.length > 0 ? parts.join(' · ') : 'no filters set';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
