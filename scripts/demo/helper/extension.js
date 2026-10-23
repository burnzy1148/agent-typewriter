// Opens the Agent Typewriter views in the demo window so they are in the shot.
const vscode = require('vscode');

exports.activate = async () => {
  await vscode.commands.executeCommand('agentTypewriter.scrubber.focus');
  await vscode.commands.executeCommand('agentTypewriter.timeline.focus');
};
