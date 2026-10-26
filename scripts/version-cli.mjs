// CLI over scripts/version.mjs for ci.yml, release.yml and prerelease.yml.
// Reads the stable version from ./package.json and tags from `git tag -l`.
//
//   next-stable <patch|minor|major>   version the Release workflow bumps to
//   next-prerelease                   version the next pre-v tag gets
//   stream-tag                        newest pre-v tag in the current stream, if any
//   newest-prerelease-tag             newest pre-v tag, if any
//   previous-stable-tag <version>     v tag below version, if any
//   notes-start <version>             where a pre-release's notes start; stdin: published pre-v tags
//   publish-check <version>           publish|finish, or exit 1; stdin: `marketplace.mjs versions` JSON
//   prune <keep>                      versions to remove; stdin: [{ version, preRelease }] JSON
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as v from './version.mjs';

const [command, arg] = process.argv.slice(2);
const stable = () => JSON.parse(readFileSync('package.json', 'utf8')).version;
const tags = () => execFileSync('git', ['tag', '-l'], { encoding: 'utf8' }).split('\n');
const stdin = () => readFileSync(0, 'utf8');
const print = (value) => { if (value !== undefined) console.log(value); };

switch (command) {
  case 'next-stable': print(v.nextStable(stable(), arg)); break;
  case 'next-prerelease': print(v.nextPrerelease(stable(), tags())); break;
  case 'stream-tag': print(v.streamTag(stable(), tags())); break;
  case 'newest-prerelease-tag': print(v.newestPrereleaseTag(tags())); break;
  case 'previous-stable-tag': print(v.previousStableTag(arg, tags())); break;
  case 'notes-start': print(v.prereleaseNotesStart(arg, stdin().split('\n'), tags())); break;
  case 'publish-check': {
    const check = v.publishCheck(arg, JSON.parse(stdin()));
    if (check.action === 'refuse') {
      console.error(check.reason);
      process.exit(1);
    }
    print(check.action);
    break;
  }
  case 'prune': v.toPrune(JSON.parse(stdin()), Number(arg)).forEach((x) => print(x)); break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
