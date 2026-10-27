// Opens the Agent Typewriter views in the demo window so they are in the shot.
// With AGENT_TYPEWRITER_DEMO_TRACE set to a file, it also appends a JSON line
// there whenever the lanes change: which lane is followed, what is being
// typed, and each lane's queue. record.mjs reads it to check the shot.
const fs = require('node:fs');
const vscode = require('vscode');

exports.activate = async () => {
  await vscode.commands.executeCommand('agentTypewriter.scrubber.focus');
  await vscode.commands.executeCommand('agentTypewriter.timeline.focus');
  await vscode.commands.executeCommand('agentTypewriter.checkouts.focus');
  const trace = process.env.AGENT_TYPEWRITER_DEMO_TRACE;
  if (trace) await traceLanes(trace);
};

async function traceLanes(file) {
  const api = await vscode.extensions.getExtension('burnzy1148.agent-typewriter')?.activate();
  if (!api) return;
  const { timeline } = api;
  const label = (id) => timeline.laneList().find((l) => l.id === id)?.label ?? id;
  let last = '';
  const write = () => {
    const playing = timeline.playing === undefined ? undefined : timeline.all().find((e) => e.seq === timeline.playing)?.relPath;
    const state = JSON.stringify({
      followed: label(timeline.followed),
      playing,
      lanes: timeline.laneList().map((l) => ({ label: l.label, color: l.color, recording: l.recording, queued: timeline.pendingCount(l.id) })),
    });
    if (state === last) return;
    last = state;
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...JSON.parse(state) }) + '\n');
  };
  write();
  timeline.onDidChange(write);
}
