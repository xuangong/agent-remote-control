import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it } from 'vitest';
import { readSubagentTranscript, readTranscript } from './prompt-edit.js';
import { withTranscriptExtras } from './transcript-extras.js';
import { ClaudeEventProjector } from './projector.js';

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

const extras = async (messages: SessionMessage[], env: NodeJS.ProcessEnv, id = sessionId) => withTranscriptExtras(id, messages, await readTranscript(id, env));

it('restores folded prompt input after the conversation entry it followed', async () => {
  const env = await transcript(native);
  const restored = await extras(rows, env);
  expect(restored.map(message => message.uuid)).toEqual(['u1', 'a1', 't1', 'q1', 'a2']);
  expect(restored[3]).toEqual(row('q1', 'user', 'Also check the README'));
});

it('gives folded input the uuid the Controller gave it, which its live row has', async () => {
  const env = await transcript(native.map(entry => entry.uuid === 'q1' ? { ...entry, attachment: { ...entry.attachment, source_uuid: 'steer-1' } } : entry));
  expect((await extras(rows, env)).map(message => message.uuid)).toEqual(['u1', 'a1', 't1', 'steer-1', 'a2']);
});

it('keeps the images of folded input', async () => {
  const blocks = [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
  const env = await transcript(native.map(entry => entry.uuid === 'q1' ? { ...entry, attachment: { ...entry.attachment, prompt: blocks } } : entry));
  expect((await extras(rows, env))[3]).toEqual(row('q1', 'user', blocks));
});

it('omits folded input whose position lies beyond a bounded read', async () => {
  const env = await transcript(native);
  expect((await extras(rows.slice(0, 2), env)).map(message => message.uuid)).toEqual(['u1', 'a1']);
});

it('returns rows unchanged without a transcript, folded input, tool results or a valid identity', async () => {
  expect(await extras(rows, { CLAUDE_CONFIG_DIR: join(tmpdir(), 'claude-folded-missing') })).toBe(rows);
  const env = await transcript(native.filter(entry => entry.type !== 'attachment').map(({ ...entry }) => entry));
  expect(await extras(rows, env)).toBe(rows);
  expect(await extras(rows, env, '../escape')).toBe(rows);
});

/** A native transcript with a Write, an Edit and a Bash row, whose results the public read leaves out. */
const toolTranscript = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Change it' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'a.txt' } }] } },
  { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'updated' }] },
    toolUseResult: { filePath: '/workspace/a.txt', oldString: 'hello', newString: 'goodbye', originalFile: 'hello\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hello', '+goodbye'] }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'r1', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
];
const publicRead = [row('u1', 'user', 'Change it'), row('a1', 'assistant', toolTranscript[1]!.message!.content), row('r1', 'user', toolTranscript[2]!.message!.content), row('a2', 'assistant', toolTranscript[3]!.message!.content)];

it('gives a reread tool row the structured result its live frame carries, so both project alike and keep their diffs', async () => {
  const restored = await extras(publicRead, await transcript(toolTranscript));
  expect((restored[2] as { tool_use_result?: unknown }).tool_use_result).toEqual(toolTranscript[2]!.toolUseResult);
  expect(restored[0]).toBe(publicRead[0]);
  const history = new ClaudeEventProjector(sessionId, 'history');
  const live = new ClaudeEventProjector(sessionId, 'live');
  const live_frame = { ...publicRead[2], tool_use_result: toolTranscript[2]!.toolUseResult };
  const fromHistory = restored.flatMap(message => history.project(message));
  const fromLive = [publicRead[1], live_frame].flatMap(message => live.project(message));
  const tool = (observations: ReturnType<typeof history.project>) => observations.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'completed' ? [event.item] : []);
  expect(tool(fromHistory)).toEqual(tool(fromLive));
  expect(JSON.stringify(tool(fromHistory))).toContain('goodbye');
  // Without the restored result the same row has no diff, as before.
  expect(JSON.stringify(tool(publicRead.flatMap(message => new ClaudeEventProjector(sessionId, 'history').project(message))))).not.toContain('goodbye');
});

it('does not attach a result to a row of another uuid, and leaves a row without a raw result as it is', async () => {
  const env = await transcript(toolTranscript.map(entry => entry.uuid === 'r1' ? { ...entry, uuid: 'other' } : entry));
  expect(await extras(publicRead, env)).toBe(publicRead);
});

it('drops the user row a finished sub-agent wakes the session with, which the stream never shows', async () => {
  const wake = { type: 'user', uuid: 'w1', parentUuid: 'a2', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } };
  const env = await transcript([...toolTranscript, wake]);
  expect((await extras([...publicRead, row('w1', 'user', wake.message.content)], env)).map(message => message.uuid)).toEqual(['u1', 'a1', 'r1', 'a2']);
});

it('reads a sub-agent transcript beside the session, for the tool rows of a child view', async () => {
  const env = await transcript(toolTranscript);
  const dir = join(env.CLAUDE_CONFIG_DIR!, 'projects', '-workspace', sessionId, 'subagents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent-abc123.jsonl'), toolTranscript.map(line => JSON.stringify({ ...line, isSidechain: true })).join('\n') + '\n');
  const restored = withTranscriptExtras(sessionId, publicRead, await readSubagentTranscript(sessionId, 'abc123', env));
  expect((restored[2] as { tool_use_result?: unknown }).tool_use_result).toEqual(toolTranscript[2]!.toolUseResult);
  expect(await readSubagentTranscript(sessionId, '../escape', env)).toBeUndefined();
  expect(await readSubagentTranscript(sessionId, 'missing', env)).toBeUndefined();
});

it('restores a long transcript with big Edit and Read results far under the catalog cap, without holding the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-large-')); roots.push(root);
  const project = join(root, 'projects', '-workspace');
  await mkdir(project, { recursive: true });
  const file = join(project, `${sessionId}.jsonl`);
  const big = 'x'.repeat(400_000);
  const messages: SessionMessage[] = [];
  const { createWriteStream } = await import('node:fs');
  const out = createWriteStream(file);
  const write = (value: object) => new Promise<void>(resolve => { if (out.write(`${JSON.stringify(value)}\n`)) resolve(); else out.once('drain', () => resolve()); });
  let parent: string | null = null;
  for (let at = 0; at < 150; at += 1) {
    const edit = at % 2 === 0;
    const use = { type: 'assistant', uuid: `a${at}`, parentUuid: parent, message: { id: `m${at}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${at}`, name: edit ? 'Edit' : 'Read', input: { file_path: '/w/a.txt' } }] } };
    const result = { type: 'user', uuid: `r${at}`, parentUuid: use.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${at}`, content: 'ok' }] },
      toolUseResult: edit ? { filePath: '/w/a.txt', originalFile: big, oldString: 'a', newString: 'b', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }
        : { type: 'image', file: { base64: big, type: 'image/png', originalSize: 400000 } } };
    await write(use); await write(result);
    parent = result.uuid;
    messages.push(row(use.uuid, 'assistant', use.message.content), row(result.uuid, 'user', result.message.content));
  }
  await new Promise<void>(resolve => out.end(() => resolve()));
  const before = process.memoryUsage().heapUsed;
  const restored = withTranscriptExtras(sessionId, messages, await readTranscript(sessionId, { CLAUDE_CONFIG_DIR: root }, true));
  const grown = process.memoryUsage().heapUsed - before;
  expect(Buffer.byteLength(JSON.stringify(restored))).toBeLessThan(2 * 1024 * 1024);
  expect(grown).toBeLessThan(80 * 1024 * 1024);
  expect(JSON.stringify(restored)).toContain('structuredPatch');
  expect(JSON.stringify(restored)).not.toContain(big.slice(0, 1000));
}, 60_000);

/**
 * The rows Claude Code 2.1.319 writes for six Edits of one streamed message, the first approved and written while the third streams
 * (the parallel-edits recording): the fourth links to that result, so the second and third leave the parent chain. The public read
 * follows the chain and adds what left it after the message's last chained row; the stream showed the rows in file order.
 */
const parallelTranscript = (() => {
  const lines: Array<Record<string, unknown>> = [{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Rename in all six' } }];
  const use = (uuid: string, parent: string, id: string) => lines.push({ type: 'assistant', uuid, parentUuid: parent, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: {} }] } });
  const result = (uuid: string, parent: string, id: string) => lines.push({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'updated' }] } });
  lines.push({ type: 'assistant', uuid: 'think', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Edit all six.' }] } });
  use('ua', 'think', 'edit-a'); use('ub', 'ua', 'edit-b'); use('uc', 'ub', 'edit-c');
  result('ra', 'ua', 'edit-a');
  use('ud', 'ra', 'edit-d'); use('ue', 'ud', 'edit-e');
  result('rb', 'ub', 'edit-b'); result('rc', 'uc', 'edit-c'); result('rd', 'ud', 'edit-d'); result('re', 'ue', 'edit-e');
  use('uf', 're', 'edit-f'); result('rf', 'uf', 'edit-f');
  lines.push({ type: 'assistant', uuid: 'done', parentUuid: 'rf', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'EDITED' }] } });
  return lines;
})();
const messageOf = (uuid: string) => { const line = parallelTranscript.find(entry => entry.uuid === uuid)!; return row(uuid, line.type as 'user' | 'assistant', (line.message as { content: unknown }).content); };
/** What `getSessionMessages` of SDK 0.3.247 returns for that transcript. */
const sdkOrder = ['u1', 'think', 'ua', 'ra', 'ud', 'ue', 're', 'uf', 'ub', 'uc', 'rb', 'rc', 'rd', 'rf', 'done'];

it('orders a reread as the transcript was written, which is the order the stream showed, when parallel tools leave the parent chain', async () => {
  const restored = await extras(sdkOrder.map(messageOf), await transcript(parallelTranscript));
  expect(restored.map(message => message.uuid)).toEqual(parallelTranscript.map(entry => entry.uuid));
  const tools = new ClaudeEventProjector(sessionId, 'history');
  const toolOrder = [...new Set(restored.flatMap(message => tools.project(message)).flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' ? [event.item.callId] : []))];
  expect(toolOrder).toEqual(['edit-a', 'edit-b', 'edit-c', 'edit-d', 'edit-e', 'edit-f']);
});

it('keeps a row the transcript lacks after the row it followed', async () => {
  const extra = row('synthetic', 'assistant', [{ type: 'text', text: 'x' }]);
  const messages = sdkOrder.map(messageOf);
  messages.splice(sdkOrder.indexOf('ub'), 0, extra);
  const restored = await extras(messages, await transcript(parallelTranscript));
  const order = restored.map(message => message.uuid);
  expect(order.indexOf('synthetic')).toBe(order.indexOf('uf') + 1);
});
