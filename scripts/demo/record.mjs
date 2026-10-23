// Records the README demo (images/demo.gif) on macOS. It packages the
// extension, installs it into a throwaway VS Code profile so personal settings
// and extensions stay out of the shot, opens a copy of scripts/demo/workspace,
// lets agent.mjs edit it, and screen-records the window with ffmpeg.
//
//   node scripts/demo/record.mjs [--screen 0] [--origin 0,0] [--at 120,120] [--seconds 30]
//
// --screen is ffmpeg's avfoundation screen index (ffmpeg -f avfoundation
// -list_devices true -i ""), --origin that screen's top-left in global
// coordinates, and --at where the window goes on it. Needs ffmpeg and the
// Screen Recording permission for the terminal running this. Leave the window
// alone while it records.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

const { values: opts } = parseArgs({
  options: {
    screen: { type: 'string', default: '0' },
    origin: { type: 'string', default: '0,0' },
    at: { type: 'string', default: '120,120' },
    seconds: { type: 'string', default: '30' },
  },
});
const [originX, originY] = opts.origin.split(',').map(Number);
const [atX, atY] = opts.at.split(',').map(Number);
const width = 1280;
const height = 820;

const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, '.demo-out');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typewriter-demo-'));
const userData = path.join(tmp, 'user-data');
const extensionsDir = path.join(tmp, 'extensions');
const workspace = path.join(tmp, 'shop');
const goFile = path.join(tmp, 'go');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
// A VS Code terminal hands its children IPC variables that would send the
// launch to the parent window instead of a new instance.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE'));

fs.mkdirSync(outDir, { recursive: true });
const vsix = path.join(outDir, 'demo.vsix');
const helperVsix = path.join(outDir, 'helper.vsix');
run('npm', ['run', 'build', '--', '--minify']);
run('npx', ['vsce', 'package', '--no-dependencies', '-o', vsix]);
run('npx', ['vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', helperVsix], {
  cwd: path.join(import.meta.dirname, 'helper'),
});

const vscode = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, '.vscode-test') });
const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscode);
run(cli, ['--user-data-dir', userData, '--extensions-dir', extensionsDir, '--install-extension', vsix, '--install-extension', helperVsix], { env });

fs.cpSync(path.join(import.meta.dirname, 'workspace'), workspace, { recursive: true });
writeJson(path.join(workspace, '.vscode/settings.json'), {
  'agentTypewriter.autoStart': true,
  'agentTypewriter.extensions': ['ts'],
  'agentTypewriter.persistHistory': false,
  'agentTypewriter.viewColumn': 'active',
  'agentTypewriter.charsPerMinute': 1100,
});
writeJson(path.join(workspace, '.vscode/tasks.json'), {
  version: '2.0.0',
  tasks: [
    {
      label: 'agent',
      type: 'process',
      command: process.execPath,
      args: [path.join(import.meta.dirname, 'agent.mjs'), goFile],
      runOptions: { runOn: 'folderOpen' },
      presentation: { reveal: 'always', panel: 'dedicated', echo: false, showReuseMessage: false, focus: false },
      problemMatcher: [],
    },
  ],
});
writeJson(path.join(userData, 'User/settings.json'), {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.commandCenter': false,
  'window.title': '${rootName}',
  'security.workspace.trust.enabled': false,
  'task.allowAutomaticTasks': 'on',
  'chat.disableAIFeatures': true,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'explorer.openEditors.visible': 0,
  'breadcrumbs.enabled': false,
  'editor.fontSize': 15,
  'editor.lineHeight': 22,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.hover.enabled': false,
  'typescript.validate.enable': false,
  'terminal.integrated.fontSize': 13,
});
// Window bounds come from the profile's last window state.
writeJson(path.join(userData, 'User/globalStorage/storage.json'), {
  windowsState: {
    lastActiveWindow: {
      folder: `file://${workspace}`,
      uiState: { mode: 1, x: originX + atX, y: originY + atY, width, height },
    },
    openedWindows: [],
  },
});

const code = spawn(vscode, ['--user-data-dir', userData, '--extensions-dir', extensionsDir, '--skip-welcome', '--skip-release-notes', workspace], {
  env,
  stdio: 'ignore',
});
await sleep(8000);

const raw = path.join(outDir, 'demo.mkv');
const ffmpeg = spawn(
  'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '30', '-pixel_format', 'bgr0', '-i', `${opts.screen}:none`,
    '-vf', `crop=${width}:${height}:${atX}:${atY}`, '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', raw],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
await sleep(1500);
fs.writeFileSync(goFile, '');
await sleep(Number(opts.seconds) * 1000);
ffmpeg.stdin.write('q');
await new Promise((r) => ffmpeg.on('exit', r));
code.kill();

// Hold the last frame so the loop does not restart the moment typing ends.
const gif = path.join(root, 'images/demo.gif');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-vf',
  'fps=15,tpad=stop_mode=clone:stop_duration=2,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', gif]);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  path.join(outDir, 'demo.mp4')]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${path.relative(root, gif)} and .demo-out/demo.mp4`);
