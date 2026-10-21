import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it } from 'vitest';
import { withFoldedInput } from './folded-input.js';

const sessionId = '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function transcript(lines: object[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-folded-')); roots.push(root);
  const project = join(root, 'projects', '-workspace');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return { CLAUDE_CONFIG_DIR: root };
}
const row = (uuid: string, type: 'user' | 'assistant', content: unknown): SessionMessage =>
  ({ type, uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } });
const native = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Start' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
  { type: 'user', uuid: 't1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
  { type: 'progress', uuid: 'p1', parentUuid: 't1' },
  { type: 'attachment', uuid: 'q1', parentUuid: 'p1', attachment: { type: 'queued_command', prompt: 'Also check the README', commandMode: 'prompt' } },
  { type: 'attachment', uuid: 'q2', parentUuid: 'q1', attachment: { type: 'queued_command', prompt: 'ls', commandMode: 'bash' } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'q2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
];
const rows = [row('u1', 'user', 'Start'), row('a1', 'assistant', native[1]!.message!.content), row('t1', 'user', native[2]!.message!.content), row('a2', 'assistant', native[6]!.message!.content)];

it('restores folded prompt input after the conversation entry it followed', async () => {
  const env = await transcript(native);
  const restored = await withFoldedInput(sessionId, rows, env);
  expect(restored.map(message => message.uuid)).toEqual(['u1', 'a1', 't1', 'q1', 'a2']);
  expect(restored[3]).toEqual(row('q1', 'user', 'Also check the README'));
});

it('omits folded input whose position lies beyond a bounded read', async () => {
  const env = await transcript(native);
  expect((await withFoldedInput(sessionId, rows.slice(0, 2), env)).map(message => message.uuid)).toEqual(['u1', 'a1']);
});

it('returns rows unchanged without a transcript, folded input or a valid identity', async () => {
  expect(await withFoldedInput(sessionId, rows, { CLAUDE_CONFIG_DIR: join(tmpdir(), 'claude-folded-missing') })).toBe(rows);
  const env = await transcript(native.filter(entry => entry.type !== 'attachment'));
  expect(await withFoldedInput(sessionId, rows, env)).toBe(rows);
  expect(await withFoldedInput('../escape', rows, env)).toBe(rows);
});
