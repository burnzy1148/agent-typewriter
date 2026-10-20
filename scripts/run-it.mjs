// Launches the integration runner. Headless Linux has no display, so wrap it
// in xvfb-run there; macOS and Windows run it directly.
import { spawnSync } from 'node:child_process';

const runner = ['.it-out/runTest.js'];
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const [cmd, args] = needsXvfb ? ['xvfb-run', ['-a', process.execPath, ...runner]] : [process.execPath, runner];

const r = spawnSync(cmd, args, { stdio: 'inherit' });
if (r.error) {
  console.error(needsXvfb && r.error.code === 'ENOENT' ? 'xvfb-run not found; install xvfb to run integration tests headless.' : r.error);
  process.exit(1);
}
process.exit(r.status ?? 1);
