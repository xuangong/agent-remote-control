import { expect, test } from 'vitest';
import { encodeAgentStreamMessage, PROTOCOL_VERSION } from '../../agent-remote-protocol/src/index.js';
import type { AssistantMessage, FilePart, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { OpenCodeImages } from './images.js';
import { normalize, usage, type NativeMessage } from './normalize.js';

function assistant(id = 'msg_a'): AssistantMessage {
  return { id, sessionID: 'ses_test', role: 'assistant', parentID: 'msg_u', modelID: 'model', providerID: 'test', mode: 'build', agent: 'build', path: { cwd: '/tmp', root: '/tmp' }, time: { created: 100, completed: 200 }, cost: 0.25, tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 10, write: 5 } } };
}
function tool(name: string, metadata: Record<string, unknown>, input: Record<string, unknown> = {}): ToolPart {
  return { id: 'prt_tool', messageID: 'msg_a', sessionID: 'ses_test', type: 'tool', callID: 'call_1', tool: name, state: { status: 'completed', input, metadata, output: 'Native output', title: name, time: { start: 110, end: 150 } } };
}
function project(part: Part) { return normalize([{ info: assistant(), parts: [part] }], new OpenCodeImages('ses_test')).map(entry => entry.event.type === 'timeline' ? entry.event.item : null); }
const patch = '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n';

test('projects native edit and patch metadata as file changes with authoritative rename paths', () => {
  const edited = project(tool('edit', { diff: patch, filediff: { file: '/tmp/test.ts', patch } }, { filePath: 'test.ts' }));
  expect(edited[0]).toMatchObject({ result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/tmp/test.ts', kind: 'modified', diff: patch }] } }, { type: 'text', text: 'Native output' }] } });
  const applied = project(tool('apply_patch', { files: [{ filePath: '/tmp/old.ts', movePath: '/tmp/new.ts', type: 'move', patch }, { filePath: '/tmp/gone.ts', type: 'delete', patch }, { filePath: '/tmp/added.ts', type: 'add', patch }] }));
  expect(applied[0]).toMatchObject({ result: { content: [{ type: 'json', value: { files: [{ path: '/tmp/new.ts', previousPath: '/tmp/old.ts', kind: 'renamed', diff: patch }, { path: '/tmp/gone.ts', kind: 'deleted', diff: patch }, { path: '/tmp/added.ts', kind: 'added', diff: patch }] } }, { type: 'text', text: 'Native output' }] } });
});

test('projects write status without inventing a diff from requested pre-format content', () => {
  expect(project(tool('write', { filepath: '/tmp/new.ts', exists: false }, { filePath: '/tmp/new.ts', content: 'unformatted' }))[0]).toMatchObject({ result: { content: [{ type: 'json', value: { files: [{ path: '/tmp/new.ts', kind: 'added', diff: '' }] } }, { type: 'text', text: 'Native output' }] } });
});

test('preserves shell exit code, elapsed time and native truncation', () => {
  expect(project(tool('shell', { exit: 2, truncated: true }, { command: 'exit 2', workdir: '/tmp' }))[0]).toMatchObject({ detail: { type: 'shell', command: 'exit 2', cwd: '/tmp' }, result: { exitCode: 2, durationMs: 40, truncated: true, content: [{ type: 'text', stream: 'combined', text: 'Native output' }] } });
});

test('preserves native structured output without interpreting text as JSON', () => {
  expect(project(tool('mcp_server_lookup', { structuredContent: { count: 2, matches: ['a'] } }))[0]).toMatchObject({ result: { content: [{ type: 'text', text: 'Native output' }, { type: 'json', value: { count: 2, matches: ['a'] } }] } });
});

test('projects assistant files and tool image attachments with registered resource references', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZcAAAAASUVORK5CYII=', 'base64');
  const image: FilePart = { type: 'file', id: 'prt_image', messageID: 'msg_a', sessionID: 'ses_test', mime: 'image/png', filename: 'result](https://example.org)', url: `data:image/png;base64,${bytes.toString('base64')}` };
  const attached = tool('read', {}, { filePath: '/tmp/result.png' });
  if (attached.state.status === 'completed') attached.state.attachments = [{ ...image, id: 'prt_attachment' }];
  const images = new OpenCodeImages('ses_test');
  const events = normalize([{ info: assistant(), parts: [image, attached] }], images);
  const rendered = events.filter(entry => entry.event.type === 'timeline' && entry.event.item.type === 'assistant_message');
  expect(rendered).toHaveLength(2);
  for (const event of rendered) {
    expect(event.resourceReferences).toHaveLength(1);
    const ref = event.resourceReferences![0]!;
    expect(event.event).toMatchObject({ item: { text: expect.stringContaining(`](${ref.locator})`) } });
    expect(await images.read(ref.readLocator)).toMatchObject({ status: 'available', mediaType: 'image/png', bytes: Uint8Array.from(bytes) });
  }
});

test('uses native session aggregate while context remains the latest populated model step', () => {
  const earlier = assistant();
  const pending = { ...assistant('msg_pending'), time: { created: 201 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const messages: NativeMessage[] = [{ info: earlier, parts: [] }, { info: pending, parts: [] }];
  expect(usage(messages, { session: { cost: 1.5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } } }, contextWindows: new Map([['test/model', 200000]]) })).toEqual({ inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, totalCostUsd: 1.5, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 40 });
  expect(usage(messages)).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, contextWindowUsedTokens: 40 });
});

test('does not claim partial history cost as a session total and uses the native context UI token breakdown', () => {
  const info = assistant(); info.tokens.total = 45;
  expect(usage([{ info, parts: [] }])).toEqual({ inputTokens: 20, cachedInputTokens: 10, outputTokens: 5, contextWindowUsedTokens: 40 });
});

test('keeps failed tool diagnostics and timing without claiming unapplied file changes', () => {
  const part = tool('edit', {});
  part.state = { status: 'error', input: { filePath: '/tmp/test.ts' }, error: 'Write denied', metadata: { diff: patch, output: 'Permission rejected' }, time: { start: 110, end: 160 } };
  expect(project(part)[0]).toMatchObject({ status: 'failed', error: 'Write denied', result: { durationMs: 50, content: [{ type: 'text', text: 'Permission rejected' }] } });
});

test('bounds structured native results and does not create shell metrics from invalid metadata', () => {
  const part = tool('shell', { exit: '2', structuredContent: { content: 'x'.repeat(100000) } });
  if (part.state.status === 'completed') part.state.time = { start: 150, end: 100 };
  const item = project(part)[0];
  expect(item?.type).toBe('tool_call');
  if (item?.type !== 'tool_call') return;
  expect(item.result?.truncated).toBe(true);
  expect(item.result?.exitCode).toBeUndefined(); expect(item.result?.durationMs).toBeUndefined();
  expect(JSON.stringify(item.result).length).toBeLessThan(66000);
});

test('omits unknown token metrics and accepts aggregate cost without history', () => {
  expect(usage([], { session: { cost: 0 } })).toEqual({ totalCostUsd: 0 });
  const info = assistant(); info.tokens.input = Number.NaN; info.tokens.cache.read = -1;
  expect(usage([{ info, parts: [] }], { contextWindows: new Map([['test/model', -1]]) })).toEqual({ outputTokens: 5 });
});

test('marks oversized native file diffs truncated even when no textual output follows', () => {
  const part = tool('edit', { diff: 'x'.repeat(100000), filediff: { file: '/tmp/test.ts' } });
  if (part.state.status === 'completed') part.state.output = '';
  expect(project(part)[0]).toMatchObject({ result: { truncated: true } });
});

const nativeToolDetails: Array<{ name: string; input: Record<string, unknown>; detail: Record<string, unknown> }> = [
  { name: 'bash', input: { command: 'pwd' }, detail: { type: 'shell', command: 'pwd' } },
  { name: 'shell', input: { command: 'pwd', workdir: '/tmp' }, detail: { type: 'shell', command: 'pwd', cwd: '/tmp' } },
  { name: 'read', input: { filePath: '/tmp/file' }, detail: { type: 'read', filePath: '/tmp/file' } },
  { name: 'edit', input: { filePath: '/tmp/file' }, detail: { type: 'edit', filePath: '/tmp/file' } },
  { name: 'multiedit', input: { filePath: '/tmp/file' }, detail: { type: 'edit', filePath: '/tmp/file' } },
  { name: 'write', input: { filePath: '/tmp/file' }, detail: { type: 'write', filePath: '/tmp/file' } },
  { name: 'grep', input: { pattern: 'pattern' }, detail: { type: 'search', query: 'pattern' } },
  { name: 'glob', input: { pattern: '*.ts' }, detail: { type: 'search', query: '*.ts' } },
  { name: 'websearch', input: { query: 'query' }, detail: { type: 'search', query: 'query' } },
  { name: 'webfetch', input: { url: 'https://example.test' }, detail: { type: 'fetch', url: 'https://example.test' } },
];

test.each(nativeToolDetails)('keeps $name lifecycle encodable while native arguments arrive', ({ name, input, detail }) => {
  const part = tool(name, {});
  const encodedItem = () => {
    const item = project(part)[0];
    expect(item?.type).toBe('tool_call');
    if (!item || item.type !== 'tool_call') throw new Error('Expected a normalized tool call.');
    expect(encodeAgentStreamMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: {
      agentId: 'agent-test', epoch: 'epoch-test', seq: 1, timestamp: '2026-09-25T00:00:00.000Z',
      event: { type: 'timeline', providerId: 'opencode', turnId: 'msg_u', item, resources: [] },
    } })).toMatchObject({ status: 'ok' });
    return item;
  };
  part.state = { status: 'pending', input: {}, raw: '' };
  expect(encodedItem()).toMatchObject({ callId: 'call_1', status: 'running', detail: { type: 'other', description: name } });
  for (const missing of ['', 42]) {
    part.state = { status: 'running', input: Object.fromEntries(Object.keys(input).map(key => [key, missing])), time: { start: 110 } };
    expect(encodedItem().detail).toEqual({ type: 'other', description: name });
  }
  part.state = { status: 'running', input, time: { start: 110 } };
  expect(encodedItem()).toMatchObject({ callId: 'call_1', status: 'running', detail });
  part.state = { status: 'completed', input, output: 'Done', title: name, metadata: {}, time: { start: 110, end: 150 } };
  expect(encodedItem()).toMatchObject({ callId: 'call_1', status: 'completed', detail });
}, 10000);
