import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { candidateDirs, encodeProjectPath, projectsDir, promptText, READ_BACK_MS, selfAndAncestors, TEXT_MAX, TranscriptIndex } from '../src/transcripts';
import { SessionLines, tempDir, writeLines } from './transcriptFixture';

test('project folders are named by replacing every non-alphanumeric character', () => {
  assert.equal(encodeProjectPath('/Users/me/repo/.claude/worktrees/sad-x1'), '-Users-me-repo--claude-worktrees-sad-x1');
  assert.equal(encodeProjectPath('C:\\work\\my_repo'), 'C--work-my-repo');
});

test('the projects folder honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(projectsDir({}, '/home/me'), path.join('/home/me', '.claude', 'projects'));
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me'), path.join('/cfg', 'projects'));
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/me'), path.join('/home/me', '.claude', 'projects'));
});

test('a root and the folders above it, without the filesystem root', () => {
  assert.deepEqual(selfAndAncestors('/a/b/c/'), ['/a/b/c', '/a/b', '/a']);
  assert.deepEqual(selfAndAncestors('C:\\a\\b'), ['C:\\a\\b', 'C:\\a']);
});

test('candidate folders: the root, folders above it, and folders inside it', () => {
  const names = ['-work-repo', '-work', '-work-repo--claude-worktrees-x', '-work-repo-other', '-elsewhere', '-work-repository'];
  const got = candidateDirs(names, ['/work/repo']);
  assert.deepEqual(got, ['-work-repo', '-work', '-work-repo--claude-worktrees-x', '-work-repo-other']);
  assert.deepEqual(candidateDirs(['C--work-repo', 'C--work', 'C--other'], ['C:\\work\\repo']), ['C--work-repo', 'C--work']);
});

test("candidate folders ignore case: VS Code's lowercase drive letter finds Claude Code's uppercase one", () => {
  assert.deepEqual(candidateDirs(['C--work-repo', 'C--work', 'C--work-repo--claude-worktrees-x', 'C--other'], ['c:\\work\\repo']), [
    'C--work-repo',
    'C--work',
    'C--work-repo--claude-worktrees-x',
  ]);
});

test('prompt text drops system reminders, tool results and empty prompts', () => {
  assert.equal(promptText('<system-reminder>\nnoise\n</system-reminder>\n\nFix the parser'), 'Fix the parser');
  assert.equal(promptText([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]), 'one\ntwo');
  assert.equal(promptText([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), undefined);
  assert.equal(promptText('<system-reminder>only</system-reminder>'), undefined);
  assert.equal(promptText('<task-notification>\n<task-id>x</task-id>\n</task-notification>'), undefined);
  assert.equal(promptText(42), undefined);
  const long = promptText('x'.repeat(5000))!;
  assert.equal(long.length, TEXT_MAX);
  assert.ok(long.endsWith('\u2026'));
});

function setup() {
  const projects = tempDir('at-projects-');
  const root = '/work/repo';
  const dir = path.join(projects, encodeProjectPath(root));
  return { projects, root, dir, index: new TranscriptIndex(() => projects) };
}

test('reads turns, narration, edit and command calls, and skips everything else', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s1');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  writeLines(path.join(dir, 's1.jsonl'), [
    JSON.stringify({ type: 'queue-operation', sessionId: 's1', content: 'x' }),
    s.prompt(t0, '<system-reminder>r</system-reminder>Rename the helper', 'p1'),
    s.text(t0 + 100, 'Renaming the helper.'),
    s.use(t0 + 200, 'tu1', 'Edit', { file_path: '/work/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
    s.blob('tu-blob', 'Edit', { file_path: '/work/repo/src/z.ts' }),
    '{ not json',
    s.result(t0 + 300, 'tu1'),
    s.use(t0 + 400, 'tu2', 'Bash', { command: 'npm run format\nnext line', description: 'Format the code' }),
    s.use(t0 + 450, 'tu3', 'Read', { file_path: '/work/repo/src/a.ts' }),
    s.use(t0 + 500, 'tu4', 'Bash', { command: 'ls -la' }),
  ]);
  await index.refresh([root], t0);
  const calls = new Map(index.calls().map((c) => [c.id, c]));
  assert.deepEqual([...calls.keys()].sort(), ['tu1', 'tu2', 'tu4']);
  const edit = calls.get('tu1')!;
  assert.deepEqual(edit.turn, { id: 'p1', time: t0, prompt: 'Rename the helper' });
  assert.equal(edit.file, '/work/repo/src/a.ts');
  assert.equal(edit.detail, 'a.ts');
  assert.equal(edit.narration, 'Renaming the helper.');
  assert.equal(edit.session, 's1');
  assert.equal(edit.start, t0 + 200);
  assert.equal(edit.end, t0 + 300);
  assert.equal(calls.get('tu2')!.detail, 'Format the code');
  assert.equal(calls.get('tu2')!.end, undefined);
  assert.equal(calls.get('tu4')!.detail, 'ls -la');
});

test('task notifications do not start a turn', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('tn');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const note = (at: number, extra: Record<string, unknown>) =>
    JSON.stringify({ type: 'user', sessionId: 'tn', uuid: `tn-n${at}`, promptId: `n${at}`, timestamp: new Date(at).toISOString(), ...extra, message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' } });
  writeLines(path.join(dir, 'tn.jsonl'), [
    s.prompt(t0, 'Run the build in the background', 'p1'),
    // Marked by origin, as recent versions write it.
    note(t0 + 100, { origin: { kind: 'task-notification', producer: 'session-task' } }),
    // Unmarked, as older versions write it.
    note(t0 + 200, {}),
    s.use(t0 + 300, 'e1', 'Edit', { file_path: '/work/repo/a.ts' }),
    JSON.stringify({ type: 'user', sessionId: 'tn', uuid: 'h', promptId: 'p2', origin: { kind: 'human' }, timestamp: new Date(t0 + 400).toISOString(), message: { role: 'user', content: 'Now fix it' } }),
    s.use(t0 + 500, 'e2', 'Edit', { file_path: '/work/repo/b.ts' }),
  ]);
  await index.refresh([root], t0);
  const calls = new Map(index.calls().map((c) => [c.id, c]));
  assert.equal(calls.get('e1')!.turn!.prompt, 'Run the build in the background');
  assert.equal(calls.get('e2')!.turn!.prompt, 'Now fix it');
});

test('a prompt without promptId uses its line uuid, and meta lines start no turn', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s2');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  writeLines(path.join(dir, 's2.jsonl'), [
    s.prompt(t0, 'First'),
    JSON.stringify({ type: 'user', isMeta: true, sessionId: 's2', uuid: 'meta', timestamp: new Date(t0 + 50).toISOString(), message: { role: 'user', content: 'Caveat' } }),
    s.use(t0 + 100, 'e1', 'Write', { file_path: '/work/repo/b.ts', content: 'x' }),
  ]);
  await index.refresh([root], t0);
  const [call] = index.calls();
  assert.equal(call.turn!.id, 's2-u1');
  assert.equal(call.turn!.prompt, 'First');
});

test('reads only what was appended, across a line split between writes', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s3');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const file = path.join(dir, 's3.jsonl');
  writeLines(file, [s.prompt(t0, 'Go', 'p'), s.use(t0 + 10, 'a', 'Edit', { file_path: '/work/repo/a.ts' })]);
  await index.refresh([root], t0);
  assert.equal(index.calls().length, 1);
  const next = s.use(t0 + 20, 'b', 'Edit', { file_path: '/work/repo/é.ts' });
  // Split inside the multi-byte character.
  const bytes = Buffer.from(next + '\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
  fs.appendFileSync(file, bytes.subarray(0, cut));
  await index.refresh([root], t0);
  assert.equal(index.calls().length, 1);
  fs.appendFileSync(file, bytes.subarray(cut));
  fs.appendFileSync(file, s.result(t0 + 30, 'a') + '\n');
  await index.refresh([root], t0);
  const calls = new Map(index.calls().map((c) => [c.id, c]));
  assert.equal(calls.get('b')!.file, '/work/repo/é.ts');
  assert.equal(calls.get('a')!.end, t0 + 30);
});

test('files last written long before the oldest waiting change are not read', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('old');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const file = path.join(dir, 'old.jsonl');
  writeLines(file, [s.prompt(t0, 'Go', 'p'), s.use(t0 + 10, 'a', 'Edit', { file_path: '/work/repo/a.ts' })]);
  fs.utimesSync(file, new Date(t0 + 20), new Date(t0 + 20));
  await index.refresh([root], t0 + READ_BACK_MS + 1000);
  assert.equal(index.calls().length, 0);
  await index.refresh([root], t0);
  assert.equal(index.calls().length, 1);
});

test('a transcript quiet since a long command started is still read for a write late in the command', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('long');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const file = path.join(dir, 'long.jsonl');
  writeLines(file, [s.prompt(t0, 'Build it', 'p'), s.use(t0 + 10, 'b', 'Bash', { command: 'npm run build' })]);
  fs.utimesSync(file, new Date(t0 + 10), new Date(t0 + 10));
  await index.refresh([root], t0 + 60_000);
  assert.deepEqual(index.calls().map((c) => c.id), ['b']);
});

test("a subagent's parent transcript is read even when it has been quiet since the subagent started", async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('quiet');
  const sub = new SessionLines('quiet');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const parent = path.join(dir, 'quiet.jsonl');
  writeLines(parent, [s.prompt(t0, 'Delegate it', 'pq'), s.use(t0 + 100, 'spawn', 'Agent', { prompt: 'x' })]);
  fs.utimesSync(parent, new Date(t0 + 100), new Date(t0 + 100));
  const agentFile = path.join(dir, 'quiet', 'subagents', 'agent-q.jsonl');
  const tw = t0 + 20 * 60_000;
  writeLines(agentFile, [sub.use(tw - 50, 'subq', 'Edit', { file_path: '/work/repo/c.ts' }, { agentId: 'q' })]);
  fs.writeFileSync(agentFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ toolUseId: 'spawn' }));
  fs.utimesSync(agentFile, new Date(tw), new Date(tw));
  await index.refresh([root], tw);
  const [call] = index.calls();
  assert.equal(call?.id, 'subq');
  assert.equal(call.turn!.id, 'pq');
});

test('prune keeps a file whose call is still running', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('run');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const file = path.join(dir, 'run.jsonl');
  writeLines(file, [s.prompt(t0, 'Go', 'p'), s.use(t0 + 10, 'spawn', 'Agent', { prompt: 'x' }), s.use(t0 + 20, 'b', 'Bash', { command: 'sleep' })]);
  fs.utimesSync(file, new Date(t0 + 20), new Date(t0 + 20));
  await index.refresh([root], t0);
  index.prune(t0 + 3_600_000);
  assert.equal(index.calls().length, 1);
  writeLines(file, [s.result(t0 + 30, 'b'), s.result(t0 + 40, 'spawn')], true);
  fs.utimesSync(file, new Date(t0 + 40), new Date(t0 + 40));
  await index.refresh([root], t0);
  index.prune(t0 + 3_600_000);
  assert.equal(index.calls().length, 0);
});

test('transcripts of unrelated projects are not read', async () => {
  const { projects, index } = setup();
  const s = new SessionLines('x');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  writeLines(path.join(projects, encodeProjectPath('/elsewhere'), 'x.jsonl'), [s.prompt(t0, 'Go', 'p'), s.use(t0 + 10, 'a', 'Edit', { file_path: '/work/repo/a.ts' })]);
  await index.refresh(['/work/repo'], t0);
  assert.equal(index.calls().length, 0);
});

test("a subagent's calls get the turn of the call that started it", async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s4');
  const sub = new SessionLines('s4');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const agentFile = path.join(dir, 's4', 'subagents', 'agent-abc.jsonl');
  writeLines(agentFile, [
    sub.prompt(t0 + 110, 'Subagent task'),
    sub.text(t0 + 150, 'Editing c.'),
    sub.use(t0 + 200, 'sub1', 'Edit', { file_path: '/work/repo/c.ts' }, { agentId: 'abc', isSidechain: true }),
  ]);
  fs.writeFileSync(agentFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'helper', description: 'Fix c', toolUseId: 'spawn' }));
  writeLines(path.join(dir, 's4.jsonl'), [s.prompt(t0, 'Do it', 'p4'), s.use(t0 + 100, 'spawn', 'Agent', { prompt: 'Subagent task' })]);
  await index.refresh([root], t0);
  const [call] = index.calls();
  assert.equal(call.id, 'sub1');
  assert.equal(call.turn!.id, 'p4');
  assert.equal(call.narration, 'Editing c.');
  assert.deepEqual(call.subagent, { id: 'abc', type: 'helper', description: 'Fix c' });
});

test('old sidechain lines in the session transcript belong to the current turn', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s5');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  writeLines(path.join(dir, 's5.jsonl'), [
    s.prompt(t0, 'Main prompt', 'p5'),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: 's5', uuid: 'sc', timestamp: new Date(t0 + 10).toISOString(), message: { role: 'user', content: 'Sub prompt' } }),
    s.use(t0 + 20, 'sc1', 'Edit', { file_path: '/work/repo/d.ts' }, { isSidechain: true, agentId: 'old' }),
  ]);
  await index.refresh([root], t0);
  const [call] = index.calls();
  assert.equal(call.turn!.prompt, 'Main prompt');
  assert.deepEqual(call.subagent, { id: 'old' });
});

test('prune forgets files not written to since a time, and a refresh reads them again', async () => {
  const { root, dir, index } = setup();
  const s = new SessionLines('s6');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const file = path.join(dir, 's6.jsonl');
  writeLines(file, [s.prompt(t0, 'Go', 'p'), s.use(t0 + 10, 'a', 'Edit', { file_path: '/work/repo/a.ts' }), s.result(t0 + 15, 'a')]);
  fs.utimesSync(file, new Date(t0 + 20), new Date(t0 + 20));
  await index.refresh([root], t0);
  assert.equal(index.calls().length, 1);
  index.prune(t0 + 1000);
  assert.equal(index.calls().length, 0);
  await index.refresh([root], t0);
  assert.equal(index.calls().length, 1);
});

test('a read error is reported once per file', async () => {
  const { root, dir } = setup();
  const errors: string[] = [];
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(file, '');
  const index = new TranscriptIndex(
    () => path.dirname(dir),
    (f) => errors.push(f),
    { ...fs.promises, open: (async () => { throw new Error('denied'); }) as unknown as typeof fs.promises.open },
  );
  await index.refresh([root], 0);
  await index.refresh([root], 0);
  assert.deepEqual(errors, [file]);
});
