// ci.yml pipes the PR's changed paths (NUL- or newline-separated, renames split
// into delete and add) to this script, which writes extension=true|false to $GITHUB_OUTPUT.
// ci.yml treats a missing value as true, so a failure here runs everything.
import { appendFileSync, readFileSync } from 'node:fs';
import { needsExtensionChecks } from './ci-paths.mjs';

const line = `extension=${needsExtensionChecks(readFileSync(0, 'utf8').split(/[\0\n]/))}`;
console.log(line);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
