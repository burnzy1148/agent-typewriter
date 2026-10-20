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
        'agentTypewriter.charsPerSecond': 600,
        'agentTypewriter.jitter': 0,
        'agentTypewriter.fileSwitchDelayMs': 30,
        'agentTypewriter.debounceMs': 100,
        'agentTypewriter.catchUpFactor': 0,
      },
      null,
      2,
    ),
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-gpu', '--no-sandbox', '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
