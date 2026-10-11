import { expect, test } from 'vitest';
import { encodeAgentStreamMessage, PROTOCOL_VERSION } from '../../agent-remote-protocol/src/index.js';
import { OpenCodeImages } from './images.js';
import { normalize, nativeError, usage } from './normalize.js';
import { turnIds, type NativeAssistant, type NativeMessage, type NativeTool } from './v2-native.js';
import { assistant, history, patch, png, tool } from './test-utils/v2-fixtures.js';

function project(part: NativeAssistant['content'][number]) { return normalize([assistant('msg_a', [part])], new OpenCodeImages('ses_test')).map(entry => entry.event.type === 'timeline' ? entry.event.item : null); }

test('projects v2 text, reasoning and user image history without legacy parts or parent IDs', () => {
  const observations = normalize(history, new OpenCodeImages('ses_test'), { startsAtBeginning: true });
  expect(observations.map(o => o.event.type === 'timeline' ? o.event.item.type : o.event.type)).toEqual(['user_message', 'reasoning', 'assistant_message', 'tool_call', 'user_message', 'assistant_message', 'user_message', 'user_message']);
  expect(observations[0]).toMatchObject({ occurredAt: 1, event: { turnId: 'msg_user', item: { text: 'Inspect this image', messageId: 'msg_user', content: [{ type: 'text' }, { type: 'image' }] } } });
  expect(observations[4]).toMatchObject({ event: { turnId: 'msg_user', item: { messageId: 'msg_steer' } } });
  expect(observations[6]!.event).not.toHaveProperty('turnId');
  expect(observations[6]).toMatchObject({ event: { item: { text: '[Injected context]\nBackground command completed' } } });
  expect(observations[6]!.event).not.toHaveProperty('item.messageId');
  expect(observations[7]).toMatchObject({ event: { turnId: 'msg_next' } });
  for (const observation of observations) {
    const event = observation.event;
    if (event.type !== 'timeline') throw new Error('Expected a timeline observation.');
    expect(encodeAgentStreamMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: {
      agentId: 'agent-test', epoch: 'epoch-test', seq: 1, timestamp: '2026-10-12T00:00:00.000Z',
      event: { type: 'timeline', providerId: 'opencode', ...(event.turnId ? { turnId: event.turnId } : {}), item: event.item, resources: [] },
    } })).toMatchObject({ status: 'ok' });
  }
});

test('uses only known user and idle boundaries and never invents the start of a truncated turn', () => {
  expect(Object.fromEntries(turnIds(history))).toEqual({ msg_next: 'msg_next' });
  const complete = turnIds(history, { startsAtBeginning: true });
  expect(complete.get('msg_first')).toBe('msg_user'); expect(complete.get('msg_steer')).toBe('msg_user'); expect(complete.get('msg_idle')).toBe('msg_user');
  expect(complete.has('msg_context')).toBe(false);
  const orphan = normalize([assistant('msg_orphan', [{ type: 'text', text: 'A partial page' }])], new OpenCodeImages('ses_test'));
  expect(orphan[0]!.event).not.toHaveProperty('turnId');
});

test('leaves system instructions, skill internals and selection history out of ordinary conversation', () => {
  const messages: NativeMessage[] = [
    { type: 'system', id: 'msg_system', time: { created: 1 }, text: 'Private native instruction' },
    { type: 'skill', id: 'msg_skill', time: { created: 2 }, skill: 'skill_test', name: 'Test', text: 'Skill internals' },
    { type: 'agent-switched', id: 'msg_agent', time: { created: 3 }, agent: 'plan' },
    { type: 'model-switched', id: 'msg_model', time: { created: 4 }, model: { id: 'model', providerID: 'test' } },
  ];
  expect(normalize(messages, new OpenCodeImages('ses_test'))).toEqual([]);
});

test('projects authoritative v2 edit and patch diffs without inferring rename provenance', () => {
  for (const name of ['edit', 'patch']) {
    expect(project(tool(name, { files: [{ file: '/work/test.ts', status: 'modified', patch, additions: 1, deletions: 1 }] }, { path: '/work/test.ts' }))[0]).toMatchObject({ result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [{ path: '/work/test.ts', kind: 'modified', diff: patch }] } }, { type: 'text', text: 'Native output' }] } });
  }
  expect(project(tool('patch', { files: [{ file: '/work/new.ts', status: 'added', patch }, { file: '/work/gone.ts', status: 'deleted', patch }] }))[0]).toMatchObject({ result: { content: [{ type: 'json', value: { files: [{ kind: 'added' }, { kind: 'deleted' }] } }, { type: 'text' }] } });
});

test('does not invent a final write diff or persist approval previews as applied changes', () => {
  expect(project(tool('write', {}, { path: '/work/new.ts', content: 'unformatted' }))[0]).toMatchObject({ detail: { type: 'write', filePath: '/work/new.ts' }, result: { content: [{ type: 'text', text: 'Native output' }] } });
  const part = tool('edit', {});
  part.state = { status: 'error', input: { path: '/work/test.ts' }, error: { type: 'PermissionDenied', message: 'Write denied' }, metadata: { files: [{ file: '/work/test.ts', status: 'modified', patch }] }, content: [{ type: 'text', text: 'Permission rejected' }] };
  expect(project(part)[0]).toMatchObject({ status: 'failed', error: 'Write denied', result: { durationMs: 40, content: [{ type: 'text', text: 'Permission rejected' }] } });
});

test('preserves shell output, exit code, elapsed time and truncation', () => {
  expect(project(tool('shell', { exit: 2, truncated: true }, { command: 'exit 2', workdir: '/work' }))[0]).toMatchObject({ detail: { type: 'shell', command: 'exit 2', cwd: '/work' }, result: { exitCode: 2, durationMs: 40, truncated: true, content: [{ type: 'text', stream: 'combined', text: 'Native output' }] } });
});

test('preserves structured output, bounds results and rejects invalid metrics', () => {
  expect(project(tool('mcp_lookup', { structuredContent: { count: 2, matches: ['a'] } }))[0]).toMatchObject({ result: { content: [{ type: 'text' }, { type: 'json', value: { count: 2, matches: ['a'] } }] } });
  const part = tool('shell', { exit: '2', structuredContent: { content: 'x'.repeat(100000) } });
  part.time = { created: 90, ran: 150, completed: 100 };
  const item = project(part)[0];
  expect(item?.type).toBe('tool_call'); if (item?.type !== 'tool_call') return;
  expect(item.result?.truncated).toBe(true); expect(item.result?.exitCode).toBeUndefined(); expect(item.result?.durationMs).toBeUndefined();
  expect(JSON.stringify(item.result).length).toBeLessThan(66000);
});

test('registers image and non-image tool resources from the actual v2 content array', async () => {
  const part = tool('read');
  if (part.state.status !== 'completed') throw new Error('Fixture must be completed.');
  part.state.content = [{ type: 'file', mime: 'image/png', name: 'result](https://example.org)', uri: `data:image/png;base64,${png.toString('base64')}` }, { type: 'file', mime: 'text/plain', name: 'Report', uri: `data:text/plain;base64,${Buffer.from('A report').toString('base64')}` }];
  const images = new OpenCodeImages('ses_test');
  const events = normalize([assistant('msg_a', [part])], images);
  const rendered = events.filter(e => e.event.type === 'timeline' && e.event.item.type === 'assistant_message');
  expect(rendered).toHaveLength(2);
  for (const event of rendered) {
    const ref = event.resourceReferences![0]!;
    expect(event.event).toMatchObject({ item: { text: expect.stringContaining(`](${ref.locator})`) } });
    expect(await images.read(ref.readLocator)).toMatchObject({ status: 'available' });
  }
  expect(await images.read(rendered[0]!.resourceReferences![0]!.readLocator)).toMatchObject({ bytes: Uint8Array.from(png) });
});

test('projects compaction lifecycle and actual failure reasons without a permanent loading notice', () => {
  const base = { type: 'compaction' as const, id: 'msg_compact', time: { created: 1 }, reason: 'auto' as const };
  const images = new OpenCodeImages('ses_test');
  expect(normalize([{ ...base, status: 'running', summary: '', recent: '' }], images)[0]).toMatchObject({ sourceKey: 'message:msg_compact', event: { item: { type: 'compaction', status: 'loading', trigger: 'auto' } } });
  expect(normalize([{ ...base, status: 'completed', summary: 'Compressed', recent: '' }], images)[0]).toMatchObject({ event: { item: { type: 'compaction', status: 'completed' } } });
  expect(normalize([{ ...base, status: 'failed', error: { type: 'ProviderError', message: 'Missing API credential' } }], images)[0]).toMatchObject({ sourceKey: 'message:msg_compact', event: { item: { type: 'error', message: 'OpenCode compaction failed: Missing API credential' } } });
  expect(nativeError({ type: 'ProviderError', message: 'stream disconnected before completion' })).toBe('stream disconnected before completion');
  expect(normalize([{ ...assistant(), error: { type: 'ProviderError', message: 'Context limit exceeded' } }], images)[0]).toMatchObject({ event: { item: { type: 'error', message: 'Context limit exceeded' } } });
});

test('projects direct shell messages with authoritative completion, cancellation and timeout', () => {
  const base = { type: 'shell' as const, id: 'msg_shell', time: { created: 1, completed: 20 }, shellID: 'sh_native', command: 'pwd', output: { output: '/work', cursor: 5, size: 5, truncated: false } };
  const images = new OpenCodeImages('ses_test');
  expect(normalize([{ ...base, status: 'exited', exit: 0 }], images)[0]).toMatchObject({ event: { item: { type: 'tool_call', callId: 'sh_native', status: 'completed', result: { exitCode: 0, durationMs: 19 } } } });
  expect(normalize([{ ...base, status: 'killed' }], images)[0]).toMatchObject({ event: { item: { status: 'canceled', error: null } } });
  expect(normalize([{ ...base, status: 'timeout' }], images)[0]).toMatchObject({ event: { item: { status: 'failed', error: 'OpenCode shell command timed out.' } } });
});

test('projects child request and returned response only with native endpoint identity and completion evidence', () => {
  const part = tool('subagent', { sessionID: 'ses_child', status: 'completed' }, { prompt: 'Inspect the implementation', agent: 'explore' });
  if (part.state.status !== 'completed') throw new Error('Fixture must be completed.');
  part.state.content = [{ type: 'text', text: '<subagent sessionID="ses_child" state="completed">\nReviewed the implementation\n</subagent>' }];
  const images = new OpenCodeImages('ses_parent');
  const letters = (p: NativeTool, sessionId?: string) => normalize([assistant('msg_a', [p])], images, { sessionId }).filter(e => e.event.type === 'timeline' && e.event.item.type === 'agent_communication');
  expect(letters(part)).toEqual([]);
  expect(letters(part, 'ses_parent')).toMatchObject([
    { occurredAt: 110, event: { item: { sender: 'ses_parent', recipient: 'ses_child', text: 'Inspect the implementation' } } },
    { occurredAt: 150, event: { item: { sender: 'ses_child', recipient: 'ses_parent', text: 'Reviewed the implementation' } } },
  ]);
  part.state.metadata = { status: 'completed' };
  expect(letters(part, 'ses_parent')).toEqual([]);
  part.state.metadata = { sessionID: 'ses_child', status: 'running' };
  expect(letters(part, 'ses_parent')).toHaveLength(1);
});

test('uses native session aggregates and the latest populated v2 model call for context', () => {
  const earlier = assistant();
  const pending = { ...assistant('msg_pending'), time: { created: 201 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const messages = [earlier, pending];
  expect(usage(messages, { session: { cost: 1.5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } } }, contextWindows: new Map([['test/model', 200000]]) })).toEqual({ tokenScope: 'session', inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, cacheCreationInputTokens: 10, totalTokens: 175, totalCostUsd: 1.5, contextScope: 'current', contextWindowMaxTokens: 200000, contextWindowUsedTokens: 40 });
  expect(usage(messages)).toEqual({ tokenScope: 'call', inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, cacheCreationInputTokens: 5, totalTokens: 40, contextScope: 'current', contextWindowUsedTokens: 40 });
  expect(usage([earlier, earlier])).toEqual(usage([earlier]));
  expect(usage([], { session: { cost: 0 } })).toEqual({ totalCostUsd: 0 });
});

test('retains zero session totals and rejects incomplete, fractional, unsafe and negative snapshots', () => {
  const zeros = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  expect(usage([assistant()], { session: { tokens: zeros } })).toEqual({ tokenScope: 'session', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, contextScope: 'current', contextWindowUsedTokens: 40 });
  const partial = { ...assistant(), tokens: { input: 15 } as NativeAssistant['tokens'] };
  expect(usage([assistant(), partial])).toEqual({ tokenScope: 'call', inputTokens: 15 });
  expect(usage([partial], { contextWindows: new Map([['test/model', 200000]]) })).toEqual({ tokenScope: 'call', inputTokens: 15, contextScope: 'current', contextWindowMaxTokens: 200000 });
  expect(usage([{ ...assistant(), tokens: undefined }])).toEqual({});
  expect(usage([{ ...assistant(), tokens: { input: 1.5, output: Number.MAX_SAFE_INTEGER, reasoning: 1, cache: { read: 10, write: -1 } } }])).toEqual({ tokenScope: 'call', cachedInputTokens: 10 });
});

const toolDetails: Array<{ name: string; input: Record<string, string>; detail: Record<string, unknown> }> = [
  { name: 'shell', input: { command: 'pwd', workdir: '/work' }, detail: { type: 'shell', command: 'pwd', cwd: '/work' } },
  { name: 'read', input: { path: '/work/file' }, detail: { type: 'read', filePath: '/work/file' } },
  { name: 'edit', input: { path: '/work/file' }, detail: { type: 'edit', filePath: '/work/file' } },
  { name: 'write', input: { path: '/work/file' }, detail: { type: 'write', filePath: '/work/file' } },
  { name: 'grep', input: { pattern: 'pattern' }, detail: { type: 'search', query: 'pattern' } },
  { name: 'glob', input: { pattern: '*.ts' }, detail: { type: 'search', query: '*.ts' } },
  { name: 'websearch', input: { query: 'query' }, detail: { type: 'search', query: 'query' } },
  { name: 'webfetch', input: { url: 'https://example.test' }, detail: { type: 'fetch', url: 'https://example.test' } },
];
test.each(toolDetails)('keeps $name streaming, running and completed v2 tools wire-encodable', ({ name, input, detail }) => {
  const part = tool(name);
  const encodedItem = () => {
    const item = project(part)[0]; if (item?.type !== 'tool_call') throw new Error('Expected a tool call.');
    expect(encodeAgentStreamMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: { agentId: 'agent-test', epoch: 'epoch-test', seq: 1, timestamp: '2026-10-12T00:00:00.000Z', event: { type: 'timeline', providerId: 'opencode', item, resources: [] } } })).toMatchObject({ status: 'ok' });
    return item;
  };
  part.state = { status: 'streaming', input: '{"incomplete":' };
  expect(encodedItem()).toMatchObject({ status: 'running', detail: { type: 'other', description: name } });
  part.state = { status: 'running', input, metadata: {} };
  expect(encodedItem()).toMatchObject({ status: 'running', detail });
  part.state = { status: 'completed', input, content: [{ type: 'text', text: 'Done' }] };
  expect(encodedItem()).toMatchObject({ status: 'completed', detail });
});
