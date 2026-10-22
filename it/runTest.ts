import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
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
        'agentTypewriter.charsPerMinute': 36000,
        'agentTypewriter.jitter': 0,
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

  // Review fix groups add their fixtures directly below their own anchor (see suite.ts).
  // --- review group PLAY: fixtures

  // --- review group SET: fixtures

  // --- review group ACT: fixtures

  // --- review group REC1: fixtures

  // VS Code puts an IPC socket in the user-data dir. The default one under
  // .vscode-test/ is too long for macOS's 104-char socket limit in deep
  // checkouts such as worktrees, so keep it short.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'atud-'));

  const launchArgs = [
    workspace,
    `--user-data-dir=${userData}`,
    '--disable-extensions',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-workspace-trust',
  ];
  // The first launch leaves the expected timeline here; the second checks it was restored.
  const extensionTestsEnv = { IT_EXPECT: path.join(userData, 'expected-timeline.json') };
  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs, extensionTestsEnv });
  await runTests({ extensionDevelopmentPath, extensionTestsPath: path.resolve(__dirname, 'restore.js'), launchArgs, extensionTestsEnv });

  // Review fix groups add any extra VS Code launches directly below their own anchor.
  // --- review group PLAY: launches

  // --- review group ACT: launches

  // --- review group REC1: launches
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
