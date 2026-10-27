// A hands-on tour of replay for manual testing. It builds the extension, makes
// a throwaway git repository, opens it in a VS Code window running the
// extension from this checkout (in a throwaway profile), then plays the part
// of an agent: one scenario per step, each saying what to watch for. The last
// steps add two git worktrees and play two agents in them at once, each in its
// own lane. A checklist of things to try by hand follows at the end.
// The repository and the steps live in tour-scenarios.mjs, which the README
// demo recorder (demo/record.mjs) shares.
//
//   node scripts/replay-tour.mjs [--auto] [--delay 8000] [--dir <path>] [--no-launch]
//
// --auto runs every step without waiting for Enter, --delay ms apart.
// --dir uses that folder instead of a new temporary one; it must not exist yet.
// --no-launch only prepares the repository and plays the agent, for a window
// you open yourself (start watching there before the first step).
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { makeRepo, steps, workspace } from './tour-scenarios.mjs';

const { values: opts } = parseArgs({
  options: {
    auto: { type: 'boolean', default: false },
    delay: { type: 'string', default: '8000' },
    dir: { type: 'string' },
    'no-launch': { type: 'boolean', default: false },
  },
});

const root = path.resolve(import.meta.dirname, '..');
// Holds the default repository and the throwaway VS Code profile; made only when one is needed.
let tmpDir;
// Resolved, because git reports worktrees by their real path and the Checkouts
// view would otherwise show macOS's /private/var/... in full.
const tmp = () => (tmpDir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'typewriter-tour-'))));
const repo = opts.dir ? path.resolve(opts.dir) : path.join(tmp(), 'shop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checklist = `
Things to try by hand now (Agent Typewriter in the Activity Bar, and the replay editor):

  [ ] Drag the Playback slider back a few changes and release: highlights of
      changes not yet replayed disappear, and come back as they replay.
  [ ] Pause, then press Skip to Latest: everything that jumped in is highlighted.
  [ ] On the replay editor's title bar, press Clear Highlights in This File:
      that file clears, others keep theirs. The button only shows on the tab
      being played into, and only while it has highlights.
  [ ] Press Clear Highlights in the Playback panel: every file clears and the
      button greys out. Edit a file in a terminal: only the new edit is green.
  [ ] Press Replay from the start: the cleared highlights come back as it replays.
  [ ] Settings: turn agentTypewriter.highlightAdditions off (brief flash
      instead of green), then agentTypewriter.markDeletions off (no red, no
      triangles). Turn both back on: highlights reappear.
  [ ] Switch themes (Preferences: Color Theme): a dark, a light, and a high
      contrast theme. Colors stay soft; gutter icons stay visible.
  [ ] In the Checkouts view, click the eye on the coupons lane: playback
      follows it again, and the header and status bar name it. Turn
      Auto-Follow off in the view's title bar, then append a line to
      .claude/worktrees/tax/src/cart.ts in a terminal: it queues in tax's
      row but nothing is typed.
  [ ] Clear the tax checkout's box: it stops recording but keeps its queued
      change, and its eye still follows it. Tick it again to record it.
  [ ] Developer: Reload Window: the timeline, the playback position and any
      clear come back; reopened tabs show the same highlights.
  [ ] Agent Typewriter: Save Session to File..., then Load Session from File...:
      the session starts paused with no highlights and replays from the start.
  [ ] Agent Typewriter: Replay Git Commits..., range main..feature: three commits
      replay (a new file, an edit, a rename) without touching the repository.
  [ ] Close a mirror tab mid-typing: it reopens and typing carries on.

The repository stays at ${repo} for more experiments; delete it when done.
`;

// ------------------------------------------------------------------ run

function launch() {
  // On Windows npm is npm.cmd, which only a shell can run.
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('npm run build failed');
  // A VS Code terminal hands its children IPC variables that would send the
  // launch to the parent window instead of a new instance.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE'));
  const userData = path.join(tmp(), 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'chat.disableAIFeatures': true,
  }, null, 2));
  return import('@vscode/test-electron').then(async ({ downloadAndUnzipVSCode }) => {
    const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, '.vscode-test') });
    spawn(exe, [
      '--extensionDevelopmentPath', root,
      '--user-data-dir', userData,
      '--extensions-dir', path.join(tmp(), 'extensions'),
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
      repo,
    ], { env, stdio: 'ignore', detached: true }).unref();
  });
}

if (fs.existsSync(repo)) throw new Error(`${repo} already exists; pass a new --dir`);
makeRepo(repo);
console.log(`Tour repository: ${repo}`);
if (!opts['no-launch']) await launch();

const rl = opts.auto ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
let auto = opts.auto;
if (rl) {
  console.log('\nWait for the VS Code window to open and show "Watching" in the status bar.');
  console.log('Open Agent Typewriter in the Activity Bar to follow along. Before each step, press Enter; type "a" to run the rest without stopping, "q" to stop.');
} else {
  await sleep(opts['no-launch'] ? 0 : 12000);
}

const ws = workspace(repo);
for (const [i, step] of steps.entries()) {
  console.log(`\n${i + 1}/${steps.length}  ${step.title}\n     Watch: ${step.look}`);
  if (rl && !auto) {
    const answer = (await rl.question('     Enter to run > ')).trim().toLowerCase();
    if (answer === 'q') break;
    if (answer === 'a') auto = true;
  }
  await step.run(ws);
  console.log('     Done.');
  if (auto && i < steps.length - 1) await sleep(Number(opts.delay));
}
rl?.close();
console.log(checklist);
