// Decides whether a pull request needs the extension's checks: only a PR whose
// every path belongs to the site skips them; anything else, or no paths at all,
// runs everything. scripts/ci-changes.mjs is the CLI ci.yml calls.

const SITE_ONLY = [/^site\//, /^\.github\/workflows\/site\.yml$/];

export function needsExtensionChecks(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  if (files.length === 0) return true;
  return files.some((f) => !SITE_ONLY.some((re) => re.test(f)));
}
