import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = path.resolve(__dirname, '..');
/** VS Code flags every launch shares, after its workspace and user-data dir. */
const flags = ['--disable-extensions', '--disable-gpu', '--no-sandbox', '--disable-workspace-trust'];

// IT_GROUP picks launches to run, as a comma-separated list: a part of
// suite.ts (recording, playback, reload or edits, see PARTS there), each in a
// fresh main workspace; suite, for every part in one launch; or workspaces,
// for the launches with workspaces of their own. CI runs them as parallel
// jobs. Unset, suite and workspaces run.
const PARTS = ['recording', 'playback', 'reload', 'edits'];

async function main() {
  // Launches get IT_PART only from suiteLaunches; one left in the shell would reach them all.
  delete process.env.IT_PART;
  for (const group of process.env.IT_GROUP?.split(',') ?? ['suite', 'workspaces']) {
    if (group === 'workspaces') await workspaceLaunches();
    else if (group === 'suite') await suiteLaunches();
    else if (PARTS.includes(group)) await suiteLaunches(group);
    else throw new Error(`unknown IT_GROUP ${group}`);
  }
}

/**
 * The main workspace: suite.ts, or one part of it, then, unless the part
 * leaves nothing for them, reloads of it that check what it left.
 */
async function suiteLaunches(part?: string) {
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');

  const workspace = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-ws-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/existing.ts'), 'const total = 1;\nexport default total;\n');
  fs.writeFileSync(
    path.join(workspace, '.vscode/settings.json'),
    JSON.stringify(
      {
        'agentTypewriter.extensions': ['ts'],
        'agentTypewriter.readPauseSeconds': 0,
        'agentTypewriter.charsPerMinute': 36000,
        'agentTypewriter.jitter': 0,
        'agentTypewriter.arrowNavigation': false,
        'agentTypewriter.naturalOrder': false,
        'agentTypewriter.fileSwitchDelayMs': 30,
        'agentTypewriter.debounceMs': 100,
        'agentTypewriter.catchUpFactor': 0,
      },
      null,
      2,
    ),
  );

  // Committed files for the git-backed baseline sections, then make the
  // workspace a repository with one commit.
  // A committed file that the gitignore section's patterns match; tracked files are never ignored.
  fs.writeFileSync(path.join(workspace, 'src/tracked.cfg'), 'level = 1\n');
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(workspace, `src/committed${n}.ts`), `export const committed${n} = ${n};\nexport default committed${n};\n`);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], {
      cwd: workspace,
      stdio: 'ignore',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  // Worktrees for the checkout-scope section: one inside the workspace, the
  // way agent tools make them, and one next to it.
  git('worktree', 'add', '-q', '-b', 'nested', '.worktrees/nested');
  git('worktree', 'add', '-q', '-b', 'sibling', `${workspace}-sibling`);

  // REC2: committed files for the baseline sections, in a second commit.
  fs.mkdirSync(path.join(workspace, 'src/rec2'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/rec2/hidden.ts'), 'export const hidden = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src/rec2/agents.ts'), '// Agents\nexport const one = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src/rec2/plain.ts'), 'export const plain = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src/rec2/toggle.ts'), 'export const toggle = 1;\n');
  fs.writeFileSync(path.join(workspace, 'src/rec2/big.ts'), `export const big = '${'b'.repeat(2000)}';\n`);
  git('add', 'src/rec2');
  git('commit', '-q', '-m', 'rec2 fixtures');

  // VS Code puts an IPC socket in the user-data dir. The default one under
  // .vscode-test/ is too long for macOS's 104-char socket limit in deep
  // checkouts such as worktrees, so keep it short.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'));

  const launchArgs = [workspace, `--user-data-dir=${userData}`, ...flags];
  // The first launch leaves the expected timeline here; the second checks it was restored.
  const extensionTestsEnv = { IT_EXPECT: path.join(userData, 'expected-timeline.json') };
  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs, extensionTestsEnv: part ? { ...extensionTestsEnv, IT_PART: part } : extensionTestsEnv });
  if (part && part !== 'reload') return;
  await runTests({ extensionDevelopmentPath, extensionTestsPath: path.resolve(__dirname, 'restore.js'), launchArgs, extensionTestsEnv });

  // The repository file's autoStart applies at activation: true there starts
  // watching, false there beats a user-level true. Each launch runs this probe.
  const actRepoFile = path.join(workspace, '.agent-typewriter.json');
  const actRepo = fs.existsSync(actRepoFile) ? JSON.parse(fs.readFileSync(actRepoFile, 'utf8')) : {};
  const actUserFile = path.join(userData, 'User', 'settings.json');
  const actProbe = path.join(userData, 'act-autostart.js');
  fs.writeFileSync(
    actProbe,
    `const vscode = require('vscode');
exports.run = async () => {
  const api = await vscode.extensions.getExtension('burnzy1148.agent-typewriter').activate();
  const expected = process.env.IT_ACT_AUTOSTART === 'true';
  const deadline = Date.now() + (expected ? 30000 : 3000);
  while ((expected ? !api.recorder.isRunning : true) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (api.recorder.isRunning !== expected) throw new Error('autoStart ' + expected + ' in .agent-typewriter.json was not applied at activation');
  await vscode.commands.executeCommand('agentTypewriter.stop');
  console.log('[it] ACT: autoStart ' + expected + ' from the repository file ok');
};
`,
  );
  for (const [fileValue, userValue] of [
    [true, undefined],
    [false, true],
  ] as const) {
    fs.writeFileSync(actRepoFile, JSON.stringify({ ...actRepo, autoStart: fileValue }));
    const user = fs.existsSync(actUserFile) ? JSON.parse(fs.readFileSync(actUserFile, 'utf8')) : {};
    user['agentTypewriter.autoStart'] = userValue;
    fs.mkdirSync(path.dirname(actUserFile), { recursive: true });
    fs.writeFileSync(actUserFile, JSON.stringify(user, null, 2));
    await runTests({ extensionDevelopmentPath, extensionTestsPath: actProbe, launchArgs, extensionTestsEnv: { IT_ACT_AUTOSTART: String(fileValue) } });
  }
  // Leave later launches the settings the reload check ran with.
  fs.writeFileSync(actRepoFile, JSON.stringify(actRepo));
  const actUser = JSON.parse(fs.readFileSync(actUserFile, 'utf8'));
  delete actUser['agentTypewriter.autoStart'];
  fs.writeFileSync(actUserFile, JSON.stringify(actUser, null, 2));
}

/** Launches that each set up a workspace of their own. */
async function workspaceLaunches() {
  // A saved multi-root workspace [a, b] where b has a sibling worktree, for
  // adding and removing folders while recording (folders.ts). Adding a folder
  // to a single-folder window restarts the extension host, so it needs its own
  // launch.
  const multi = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-multi-'));
  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'ignore' });
  for (const name of ['a', 'b', 'c']) {
    const repo = path.join(multi, name);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/x.ts'), `export const x = '${name}';\n`);
    gitAt(repo, 'init', '-q');
    gitAt(repo, 'add', '-A');
    gitAt(repo, 'commit', '-q', '-m', 'initial');
  }
  gitAt(path.join(multi, 'b'), 'worktree', 'add', '-q', '-b', 'feature', path.join(multi, 'b-feature'));
  const multiFile = path.join(multi, 'multi.code-workspace');
  fs.writeFileSync(
    multiFile,
    JSON.stringify({
      folders: [{ path: 'a' }, { path: 'b' }],
      settings: {
        'agentTypewriter.extensions': ['ts'],
        'agentTypewriter.readPauseSeconds': 0,
        'agentTypewriter.debounceMs': 100,
        'agentTypewriter.reorderWindowMs': 0,
        'agentTypewriter.charsPerMinute': 240000,
        'agentTypewriter.jitter': 0,
        'agentTypewriter.arrowNavigation': false,
        'agentTypewriter.naturalOrder': false,
        'agentTypewriter.persistHistory': false,
      },
    }),
  );
  const multiUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'));
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'folders.js'),
    launchArgs: [multiFile, `--user-data-dir=${multiUserData}`, ...flags],
    extensionTestsEnv: { IT_MULTI: multi },
  });

  // REC2: a saved workspace whose folders nest, [repo, repo/pkg], outer
  // first, for git baselines of the inner folder's files (nestedFolders.ts).
  const nest = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-nest-'));
  const nestRepo = path.join(nest, 'repo');
  fs.mkdirSync(path.join(nestRepo, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(nestRepo, 'package.json'), '{ "name": "ROOT" }\n');
  fs.writeFileSync(path.join(nestRepo, 'pkg', 'package.json'), '{ "name": "PKG" }\n');
  gitAt(nestRepo, 'init', '-q');
  gitAt(nestRepo, 'add', '-A');
  gitAt(nestRepo, 'commit', '-q', '-m', 'initial');
  const nestFile = path.join(nest, 'nest.code-workspace');
  fs.writeFileSync(
    nestFile,
    JSON.stringify({
      folders: [{ path: 'repo' }, { path: 'repo/pkg' }],
      settings: {
        'agentTypewriter.extensions': ['json'],
        'agentTypewriter.readPauseSeconds': 0,
        'agentTypewriter.debounceMs': 100,
        'agentTypewriter.reorderWindowMs': 0,
        'agentTypewriter.gitBaselines': true,
        'agentTypewriter.persistHistory': false,
      },
    }),
  );
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'nestedFolders.js'),
    launchArgs: [nestFile, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'))}`, ...flags],
    extensionTestsEnv: { IT_NEST: nestRepo },
  });

  // REC4: a saved multi-root workspace for display paths and checkout choices
  // (rec4.ts): two folders both named app, a folder holding a bare
  // repository's one worktree, and a repository with a nested worktree. It is
  // opened through a symlink (a plain path on Windows), as a workspace under
  // ~/code linked elsewhere would be.
  const rec4 = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-rec4-'));
  for (const side of ['client', 'server']) {
    fs.mkdirSync(path.join(rec4, side, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(rec4, side, 'app', 'src', 'index.ts'), `export const side = '${side}';\n`);
  }
  const rec4Origin = path.join(rec4, 'origin');
  const rec4Repo = path.join(rec4, 'repo');
  for (const repo of [rec4Origin, rec4Repo]) {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    gitAt(repo, 'init', '-q');
    gitAt(repo, 'add', '-A');
    gitAt(repo, 'commit', '-q', '-m', 'initial');
  }
  const rec4Proj = path.join(rec4, 'proj');
  fs.mkdirSync(rec4Proj);
  gitAt(rec4Proj, 'clone', '-q', '--bare', rec4Origin, '.bare');
  fs.writeFileSync(path.join(rec4Proj, '.git'), 'gitdir: ./.bare\n');
  gitAt(rec4Proj, 'worktree', 'add', '-q', 'main');
  gitAt(rec4Repo, 'worktree', 'add', '-q', '-b', 'nested', '.worktrees/nested');
  fs.writeFileSync(
    path.join(rec4, 'rec4.code-workspace'),
    JSON.stringify({
      folders: [{ path: 'client/app' }, { path: 'server/app' }, { path: 'proj' }, { path: 'repo' }],
      settings: {
        'agentTypewriter.extensions': ['ts'],
        'agentTypewriter.readPauseSeconds': 0,
        'agentTypewriter.debounceMs': 100,
        'agentTypewriter.reorderWindowMs': 0,
        'agentTypewriter.charsPerMinute': 240000,
        'agentTypewriter.jitter': 0,
        'agentTypewriter.arrowNavigation': false,
        'agentTypewriter.naturalOrder': false,
        'agentTypewriter.fileSwitchDelayMs': 0,
        'agentTypewriter.persistHistory': false,
      },
    }),
  );
  let rec4Open = rec4;
  if (process.platform !== 'win32') {
    rec4Open = `${rec4}-link`;
    fs.symlinkSync(rec4, rec4Open, 'dir');
  }
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'folders.js'),
    launchArgs: [path.join(rec4Open, 'rec4.code-workspace'), `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'))}`, ...flags],
    extensionTestsEnv: { IT_REC4: rec4Open },
  });

  // Git replay (gitReplay.ts): main is checked out with an uncommitted edit;
  // feature has two commits on main and a merge of main, and is not checked out.
  const replayRepo = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-replay-'));
  const replayWrite = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(replayRepo, rel)), { recursive: true });
    fs.writeFileSync(path.join(replayRepo, rel), text);
  };
  replayWrite('src/a.ts', 'export const a = 1;\n');
  replayWrite('src/gone.ts', 'export const gone = true;\n');
  replayWrite('notes.txt', 'notes\n');
  gitAt(replayRepo, 'init', '-q', '-b', 'main');
  gitAt(replayRepo, 'add', '-A');
  gitAt(replayRepo, 'commit', '-q', '-m', 'initial');
  gitAt(replayRepo, 'checkout', '-q', '-b', 'feature');
  replayWrite('src/a.ts', 'export const a = 2;\n');
  replayWrite('src/b.ts', 'export const b = 1;\n');
  replayWrite('notes.txt', 'notes, filtered out\n');
  gitAt(replayRepo, 'add', '-A');
  gitAt(replayRepo, 'commit', '-q', '-m', 'Change a, add b');
  gitAt(replayRepo, 'checkout', '-q', 'main');
  replayWrite('notes.txt', 'notes on main\n');
  gitAt(replayRepo, 'commit', '-q', '-am', 'Main: notes');
  gitAt(replayRepo, 'checkout', '-q', 'feature');
  gitAt(replayRepo, 'merge', '-q', '--no-edit', '-X', 'theirs', 'main');
  replayWrite('src/a.ts', 'export const a = 3;\nexport const twice = a * 2;\n');
  fs.rmSync(path.join(replayRepo, 'src/gone.ts'));
  gitAt(replayRepo, 'add', '-A');
  gitAt(replayRepo, 'commit', '-q', '-m', 'Change a again, remove gone');
  gitAt(replayRepo, 'checkout', '-q', 'main');
  replayWrite('src/a.ts', 'export const a = 1; // uncommitted\n');
  fs.mkdirSync(path.join(replayRepo, '.vscode'));
  fs.writeFileSync(
    path.join(replayRepo, '.vscode/settings.json'),
    JSON.stringify({
      'agentTypewriter.extensions': ['ts'],
      'agentTypewriter.readPauseSeconds': 0,
      'agentTypewriter.debounceMs': 100,
      'agentTypewriter.reorderWindowMs': 0,
      'agentTypewriter.charsPerMinute': 240000,
      'agentTypewriter.jitter': 0,
      'agentTypewriter.arrowNavigation': false,
      'agentTypewriter.naturalOrder': false,
      'agentTypewriter.fileSwitchDelayMs': 0,
      'agentTypewriter.persistHistory': false,
    }),
  );
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'gitReplay.js'),
    launchArgs: [replayRepo, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'))}`, ...flags],
  });

  // Lanes (lanes.ts): a repository with a nested worktree, recorded together.
  // The second launch checks the lanes were restored.
  const lanesRepo = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-lanes-'));
  fs.mkdirSync(path.join(lanesRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(lanesRepo, 'src/a.ts'), 'export const a = 0;\n');
  fs.writeFileSync(path.join(lanesRepo, '.gitignore'), '.vscode/\n');
  gitAt(lanesRepo, 'init', '-q', '-b', 'main');
  gitAt(lanesRepo, 'add', '-A');
  gitAt(lanesRepo, 'commit', '-q', '-m', 'initial');
  gitAt(lanesRepo, 'worktree', 'add', '-q', '-b', 'feat', '.worktrees/feat');
  fs.mkdirSync(path.join(lanesRepo, '.vscode'));
  fs.writeFileSync(
    path.join(lanesRepo, '.vscode/settings.json'),
    JSON.stringify({
      'agentTypewriter.extensions': ['ts'],
      'agentTypewriter.readPauseSeconds': 0,
      'agentTypewriter.debounceMs': 100,
      'agentTypewriter.reorderWindowMs': 0,
      'agentTypewriter.charsPerMinute': 240000,
      'agentTypewriter.jitter': 0,
      'agentTypewriter.arrowNavigation': false,
      'agentTypewriter.naturalOrder': false,
      'agentTypewriter.fileSwitchDelayMs': 0,
    }),
  );
  const lanesUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'));
  const lanesEnv = { IT_LANES_EXPECT: path.join(lanesUserData, 'expected-lanes.json') };
  for (const phase of ['record', 'restore']) {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'lanes.js'),
      launchArgs: [lanesRepo, `--user-data-dir=${lanesUserData}`, ...flags],
      extensionTestsEnv: { ...lanesEnv, IT_LANES_PHASE: phase },
    });
  }

  // Ignored worktrees (ignoreWorktrees.ts): review-style worktrees that
  // autoIgnoreWorktrees names get no lane while a branch `pr` has a diff to
  // apply into them.
  const ignoreRepo = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-ignore-'));
  fs.mkdirSync(path.join(ignoreRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ignoreRepo, 'src/a.ts'), 'export const a = 0;\n');
  fs.writeFileSync(path.join(ignoreRepo, '.gitignore'), '.vscode/\n');
  gitAt(ignoreRepo, 'init', '-q', '-b', 'main');
  gitAt(ignoreRepo, 'add', '-A');
  gitAt(ignoreRepo, 'commit', '-q', '-m', 'initial');
  gitAt(ignoreRepo, 'checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(ignoreRepo, 'src/a.ts'), 'export const a = "pr";\n');
  fs.writeFileSync(path.join(ignoreRepo, 'src/new.ts'), 'export const n = 1;\n');
  gitAt(ignoreRepo, 'add', '-A');
  gitAt(ignoreRepo, 'commit', '-q', '-m', 'pr');
  gitAt(ignoreRepo, 'checkout', '-q', 'main');
  fs.mkdirSync(path.join(ignoreRepo, '.vscode'));
  fs.writeFileSync(
    path.join(ignoreRepo, '.vscode/settings.json'),
    JSON.stringify({
      'agentTypewriter.extensions': ['ts'],
      'agentTypewriter.readPauseSeconds': 0,
      'agentTypewriter.debounceMs': 100,
      'agentTypewriter.reorderWindowMs': 0,
      'agentTypewriter.charsPerMinute': 240000,
      'agentTypewriter.jitter': 0,
      'agentTypewriter.arrowNavigation': false,
      'agentTypewriter.naturalOrder': false,
      'agentTypewriter.fileSwitchDelayMs': 0,
      'agentTypewriter.autoRecordWorktrees': 'fill',
      'agentTypewriter.autoFollow': true,
      'agentTypewriter.autoIgnoreWorktrees': ['**/.claude/worktrees/review-*', 'tmp.*', 'branch:review/*'],
    }),
  );
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'ignoreWorktrees.js'),
    launchArgs: [ignoreRepo, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'))}`, ...flags],
  });

  // Git operations (gitOperations.ts): main is behind `feature`, which a
  // fast-forward merge brings in, and `clash` changes the same line of
  // src/a.ts as feature does.
  const opsRepo = fs.mkdtempSync(path.join(process.env.IT_TMP ?? os.tmpdir(), 'typewriter-gitops-'));
  const opsWrite = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(opsRepo, rel)), { recursive: true });
    fs.writeFileSync(path.join(opsRepo, rel), text);
  };
  opsWrite('src/a.ts', 'export const a = 1;\n');
  opsWrite('.gitignore', '.vscode/\n');
  gitAt(opsRepo, 'init', '-q', '-b', 'main');
  gitAt(opsRepo, 'add', '-A');
  gitAt(opsRepo, 'commit', '-q', '-m', 'initial');
  gitAt(opsRepo, 'checkout', '-q', '-b', 'clash');
  opsWrite('src/a.ts', 'export const a = "clash";\n');
  gitAt(opsRepo, 'commit', '-q', '-am', 'clash');
  gitAt(opsRepo, 'checkout', '-q', '-b', 'feature', 'main');
  opsWrite('src/a.ts', 'export const a = 2;\n');
  opsWrite('src/c.ts', 'export const c = 1;\n');
  gitAt(opsRepo, 'add', '-A');
  gitAt(opsRepo, 'commit', '-q', '-m', 'feature');
  gitAt(opsRepo, 'checkout', '-q', 'main');
  opsWrite(
    '.vscode/settings.json',
    JSON.stringify({
      'agentTypewriter.extensions': ['ts'],
      'agentTypewriter.debounceMs': 100,
      'agentTypewriter.charsPerMinute': 240000,
      'agentTypewriter.jitter': 0,
      'agentTypewriter.arrowNavigation': false,
      'agentTypewriter.naturalOrder': false,
      'agentTypewriter.fileSwitchDelayMs': 0,
      'agentTypewriter.persistHistory': false,
    }),
  );
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, 'gitOperations.js'),
    launchArgs: [opsRepo, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'))}`, ...flags],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
