// Checks the Claude Code plugin with a pinned Claude Code CLI: validates the
// repository's marketplace catalog and the plugin, runs the plugin's tests,
// then installs the plugin from this checkout's marketplace, which catches a
// catalog entry pointing at a missing folder (validation does not). Everything
// runs with a fresh CLAUDE_CONFIG_DIR, so your own Claude Code settings stay
// out of it, as in CI. None of it needs a login.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = '@anthropic-ai/claude-code@2.1.309';
const PLUGIN = 'agent-typewriter@agent-typewriter';
// The plugin sets no version so that Claude Code versions it by commit. The
// validator warns about that; every other warning fails the check.
const ALLOWED_WARNING = /^No version specified\b/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = mkdtempSync(join(tmpdir(), 'agent-typewriter-claude-'));
const env = { ...process.env, CLAUDE_CONFIG_DIR: config };

function claude(args, { capture = false } = {}) {
  const r = spawnSync('npx', ['-y', CLI, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.error) throw r.error;
  return r;
}

function run(args) {
  if (claude(args).status !== 0) throw new Error(`claude ${args.join(' ')} failed`);
}

function validate(target) {
  const r = claude(['plugin', 'validate', target, '--json'], { capture: true });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude plugin validate ${target} printed no report:\n${r.stdout}`);
  }
  const problems = [report.manifest, ...(report.contents ?? [])].filter(Boolean).flatMap((f) => [
    ...(f.errors ?? []).map((e) => `error: ${f.file} ${e.path ?? ''}: ${e.message}`),
    ...(f.warnings ?? []).filter((w) => !ALLOWED_WARNING.test(w.message)).map((w) => `warning: ${f.file} ${w.path ?? ''}: ${w.message}`),
  ]);
  for (const a of report.advice ?? []) console.log(`  advice: ${a.file}: ${a.message}`);
  if (r.status !== 0 || !report.success || problems.length > 0) {
    throw new Error(`claude plugin validate ${target} failed:\n  ${problems.join('\n  ') || r.stdout}`);
  }
  console.log(`✔ ${target} is valid`);
}

function install() {
  run(['plugin', 'marketplace', 'add', './']);
  run(['plugin', 'install', PLUGIN]);
  const listed = JSON.parse(claude(['plugin', 'list', '--json'], { capture: true }).stdout).find((p) => p.id === PLUGIN);
  const folder = realpathSync(join(root, 'claude-code'));
  const from = listed?.readFromFolder && existsSync(listed.readFromFolder) ? realpathSync(listed.readFromFolder) : listed?.readFromFolder;
  if (!listed?.enabled || from !== folder) {
    throw new Error(`${PLUGIN} is not installed and enabled from ${folder}: ${JSON.stringify(listed)}`);
  }
  console.log(`✔ ${PLUGIN} installs from the checkout's marketplace`);
}

try {
  validate('.');
  validate('claude-code');
  run(['plugin', 'test', 'claude-code']);
  install();
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(config, { recursive: true, force: true });
}
