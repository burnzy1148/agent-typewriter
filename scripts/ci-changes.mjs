// Decides whether a pull request needs the extension's checks. ci.yml pipes the
// PR's changed paths (one per line, renames split into delete and add) to this
// script, which writes extension=true|false to $GITHUB_OUTPUT. Only a PR whose
// every path belongs to the site skips them; anything else, or no paths at all,
// runs everything.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SITE_ONLY = [/^site\//, /^\.github\/workflows\/site\.yml$/];

export function needsExtensionChecks(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  if (files.length === 0) return true;
  return files.some((f) => !SITE_ONLY.some((re) => re.test(f)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const paths = readFileSync(0, 'utf8').split('\n');
  const line = `extension=${needsExtensionChecks(paths)}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}
