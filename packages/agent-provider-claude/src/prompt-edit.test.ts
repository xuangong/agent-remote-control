import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { forkPromptEdit, inspectPromptEdit, promptTurns, readTranscript, verifyPromptEditBranch } from './prompt-edit.js';

const id = '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6';
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function home(lines: object[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-prompt-edit-')); roots.push(root);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'claude-prompt-edit-workspace-'))); roots.push(cwd);
  const project = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const file = join(project, `${id}.jsonl`);
  const rows = lines.map(line => ({ sessionId: id, cwd, timestamp: '2026-10-21T00:00:00.000Z', isSidechain: false, ...line }));
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { env: { ...process.env, CLAUDE_CONFIG_DIR: root }, cwd, file, project };
}
const user = (n: number, parent: number | null, content: unknown, extra: object = {}) =>
  ({ type: 'user', uuid: u(n), parentUuid: parent === null ? null : u(parent), message: { role: 'user', content }, ...extra });
const assistant = (n: number, parent: number, content: unknown) =>
  ({ type: 'assistant', uuid: u(n), parentUuid: u(parent), message: { role: 'assistant', content } });
const tool = (n: number, parent: number, toolUse: string) => user(n, parent, [{ type: 'tool_result', tool_use_id: toolUse, content: 'ok' }]);

/** Two turns; the second ran parallel tools, absorbed a mid-turn message, and was followed by compaction and a third turn. */
const conversation = [
  user(1, null, 'First prompt'),
  assistant(2, 1, [{ type: 'text', text: 'First answer' }]),
  user(3, 2, [{ type: 'text', text: 'Second prompt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
  assistant(4, 3, [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }]),
  assistant(5, 4, [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }]),
  tool(6, 4, 'a'),
  tool(7, 5, 'b'),
  { type: 'attachment', uuid: u(8), parentUuid: u(7), attachment: { type: 'queued_command', prompt: 'Also check tests', commandMode: 'prompt' } },
  assistant(9, 8, [{ type: 'text', text: 'Second answer' }]),
  { type: 'custom-title', uuid: u(10), customTitle: 'Metadata entries have no parent link' },
  { type: 'system', subtype: 'compact_boundary', uuid: u(11), parentUuid: null, logicalParentUuid: u(9) },
  user(12, 11, 'This session is being continued from a previous conversation.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  user(13, 12, '<command-name>/compact</command-name>'),
  user(14, 13, 'Third prompt'),
  assistant(15, 14, [{ type: 'text', text: 'Third answer' }]),
];
const target = (message: number, turn = message) => ({ nativeSessionId: id, turnId: u(turn), messageId: u(message) });

it('assigns every conversation entry to the prompt that started its turn, including parallel tool branches', async () => {
  const { env } = await home(conversation);
  const turns = promptTurns((await readTranscript(id, env))!);
  expect(Object.fromEntries([...turns].map(([entry, turn]) => [entry.slice(-2), turn.slice(-2)]))).toEqual({
    '01': '01', '02': '01', '03': '03', '04': '03', '05': '03', '06': '03', '07': '03', '08': '03', '09': '03', '14': '14', '15': '14',
  });
});

it('branches before a prompt, keeps the original, and verifies the exact native prefix', async () => {
  const { env, cwd, file } = await home(conversation);
  const before = await readFile(file, 'utf8');
  await expect(inspectPromptEdit(id, target(3), env)).resolves.toEqual({ cwd, forkPoint: u(2) });
  await expect(inspectPromptEdit(id, target(14), env)).resolves.toEqual({ cwd, forkPoint: u(13) });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  let branch: { sessionId: string | null };
  try { branch = await forkPromptEdit(id, target(3), env); } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  expect(branch.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await readFile(file, 'utf8')).toBe(before);
  const copied = (await readTranscript(branch.sessionId!, env))!.filter(row => row.type === 'user' || row.type === 'assistant');
  expect(copied.map(row => JSON.stringify(row.message))).toEqual([conversation[0]!, conversation[1]!].map(row => JSON.stringify((row as { message: unknown }).message)));
  await expect(verifyPromptEditBranch(id, target(3), branch.sessionId!, env)).resolves.toBeUndefined();
  await expect(verifyPromptEditBranch(id, target(14), branch.sessionId!, env)).rejects.toThrow('exact native prompt-edit prefix');
});

it('rejects a branch whose conversation differs from the source prefix', async () => {
  const { env, project, cwd } = await home(conversation);
  const candidate = u(99);
  const rows = [user(201, null, 'First prompt'), assistant(202, 201, [{ type: 'text', text: 'A different answer' }])]
    .map(row => ({ ...row, sessionId: candidate, cwd, timestamp: '2026-10-21T00:00:00.000Z', isSidechain: false }));
  await writeFile(join(project, `${candidate}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await expect(verifyPromptEditBranch(id, target(3), candidate, env)).rejects.toThrow('exact native prompt-edit prefix');
  await expect(verifyPromptEditBranch(id, target(1), candidate, env)).rejects.toThrow('not an empty conversation');
});

it('starts the first prompt from an empty conversation', async () => {
  const { env, cwd } = await home(conversation);
  await expect(inspectPromptEdit(id, target(1), env)).resolves.toEqual({ cwd, forkPoint: null });
  await expect(forkPromptEdit(id, target(1), env)).resolves.toEqual({ cwd, sessionId: null });
  await expect(verifyPromptEditBranch(id, target(1), u(98), env)).resolves.toBeUndefined();
});

it.each([
  ['a message sent while Claude was working', target(8, 3), 'Only the first prompt of a turn'],
  ['a queued command addressed as its own turn', target(8), 'Only the first prompt of a turn'],
  ['a prompt addressed under another turn', target(14, 3), 'Only the first prompt of a turn'],
  ['the compaction summary', target(12), 'compaction summary is not a prompt'],
  ['a native command record', target(13), 'Native command records cannot be restored'],
  ['a tool result', target(7), 'not a prompt that can be edited'],
  ['an assistant reply', target(9), 'not a prompt that can be edited'],
  ['a missing message', target(97), 'no longer available'],
])('refuses %s', async (_label, selected, message) => {
  const { env } = await home(conversation);
  await expect(inspectPromptEdit(id, selected, env)).rejects.toThrow(message);
});

it('refuses prompts outside the current conversation and in native child conversations', async () => {
  const { env } = await home([
    ...conversation.slice(0, 2),
    user(20, 2, 'Abandoned prompt'),
    user(21, 2, 'Child prompt', { isSidechain: true }),
    user(22, 2, 'Current prompt'),
  ]);
  await expect(inspectPromptEdit(id, target(20), env)).rejects.toThrow('not part of the current conversation');
  await expect(inspectPromptEdit(id, target(21), env)).rejects.toThrow('native child conversations');
  await expect(inspectPromptEdit(id, target(22), env)).resolves.toMatchObject({ forkPoint: u(2) });
});
