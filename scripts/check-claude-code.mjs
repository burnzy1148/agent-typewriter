// Checks the Claude Code plugin with a pinned Claude Code CLI: validates the
// repository's marketplace catalog and the plugin, runs the plugin's tests,
// then installs the plugin from this checkout's marketplace, which catches a
// catalog entry pointing at a missing folder (validation does not). It also
// fails if the plugin sets a version, which would stop Claude Code versioning it
// by commit. Everything runs with a fresh CLAUDE_CONFIG_DIR and without your
// CLAUDE_CODE_PLUGIN_* variables, so your user settings and plugins stay out of
// it, as in CI; the checkout's own .claude/ settings still apply. None of it
// needs a login.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = '@anthropic-ai/claude-code@2.1.309';
const NAME = 'agent-typewriter';
const PLUGIN = `${NAME}@${NAME}`;
// The plugin sets no version so that Claude Code versions it by commit. The
// validator warns about that; every other warning fails the check.
const ALLOWED_WARNING = /^No version specified\b/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = mkdtempSync(join(tmpdir(), 'agent-typewriter-claude-'));
const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
// CLAUDE_CODE_PLUGIN_CACHE_DIR and its kin point the CLI at your own plugin folders.
for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_CODE_PLUGIN_')) delete env[key];

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

function noVersion() {
  const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const manifest = 'claude-code/.claude-plugin/plugin.json';
  const catalog = '.claude-plugin/marketplace.json';
  const entry = read(catalog).plugins?.find((p) => p.name === NAME);
  const set = [read(manifest).version !== undefined && manifest, entry?.version !== undefined && catalog].filter(Boolean);
  if (set.length > 0) {
    throw new Error(`the plugin must set no version, so that Claude Code versions it by commit: remove it from ${set.join(' and ')}`);
  }
  console.log('✔ the plugin sets no version');
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
  const list = claude(['plugin', 'list', '--json'], { capture: true });
  if (list.status !== 0) throw new Error('claude plugin list --json failed');
  const listed = JSON.parse(list.stdout).find((p) => p.id === PLUGIN);
  const folder = realpathSync(join(root, 'claude-code'));
  const from = listed?.readFromFolder && existsSync(listed.readFromFolder) ? realpathSync(listed.readFromFolder) : listed?.readFromFolder;
  // Windows paths can differ in case alone.
  const same = process.platform === 'win32' ? from?.toLowerCase() === folder.toLowerCase() : from === folder;
  if (!listed?.enabled || !same) {
    throw new Error(`${PLUGIN} is not installed and enabled from ${folder}: ${JSON.stringify(listed)}`);
  }
  console.log(`✔ ${PLUGIN} installs from the checkout's marketplace`);
}

try {
  validate('.');
  validate('claude-code');
  noVersion();
  run(['plugin', 'test', 'claude-code']);
  install();
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exitCode = 1;
} finally {
  // Windows can hold a file open for a moment after the CLI exits.
  try {
    rmSync(config, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    console.warn(`could not remove ${config}: ${e.message}`);
  }
}
