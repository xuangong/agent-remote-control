import { expect, it } from 'vitest';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { CodexAppServerTransport } from './app-server-transport.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';
import { preparePromptEdit } from './prompt-edit.js';

const prompt = { id: 'message-2', type: 'userMessage', content: [{ type: 'text', text: 'Edit me', text_elements: [] }] };
const target = { nativeSessionId: 'source', turnId: 'turn-2', messageId: 'message-2' };
function fixture(turns: unknown[], nextCursor: string | null = null) {
  const app = createScriptedAppServer({
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp', turns: [] } }),
    'thread/turns/list': params => (params as { cursor?: string }).cursor
      ? { data: [{ id: 'turn-1', status: 'completed', items: [] }], nextCursor: null }
      : { data: turns, nextCursor },
  });
  return { app, transport: new CodexAppServerTransport(app.child) };
}
it('resolves a stable native boundary without modifying the source', async () => {
  const { app, transport } = fixture([{ id: 'turn-2', status: 'completed', items: [prompt] }], 'older');
  try {
    expect(await preparePromptEdit(transport, target)).toMatchObject({ beforeTurnId: 'turn-2', previousTurnId: 'turn-1', cwd: '/tmp' });
    expect(app.requests.every(r => r.method.startsWith('thread/') && ['thread/read', 'thread/turns/list'].includes(r.method))).toBe(true);
  } finally { await transport.dispose(); }
});
it('starts fresh for the first prompt, like Esc', async () => {
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [prompt] }]);
  try { expect(await preparePromptEdit(transport, target)).not.toHaveProperty('beforeTurnId'); }
  finally { await transport.dispose(); }
});
it.each([
  { id: 'turn-2', status: 'inProgress', items: [prompt] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, id: 'first' }, prompt] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, id: 'different' }] },
  { id: 'turn-2', status: 'completed', items: [{ type: 'enteredReviewMode' }, prompt, { type: 'exitedReviewMode' }] },
  { id: 'turn-2', status: 'completed', items: [{ ...prompt, content: [{ type: 'skill', name: 'test', path: '/tmp/test' }] }] },
])('rejects unsafe or unrepresentable prompt edits before dispatch', async turn => {
  const { transport } = fixture([turn]);
  try { await expect(preparePromptEdit(transport, target)).rejects.toThrow(); }
  finally { await transport.dispose(); }
});

it.each(['codex_cli_rs/0.155.1', 'codex_cli_rs/0.158.0', 'codex-tui/99.0.0', undefined])('forks at the verified boundary without a version allowlist (%s)', async userAgent => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent }),
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp' } }),
    'thread/turns/list': params => (params as { threadId: string }).threadId === 'source'
      ? { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }, { id: 'turn-1', status: 'completed', items: [] }], nextCursor: null }
      : { data: [{ id: 'turn-1', status: 'completed', items: [] }], nextCursor: null },
    'thread/fork': () => ({ thread: { id: 'branch', cwd: '/tmp' }, model: 'model' }),
  });
  const session = await new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target);
  try {
    expect(await session.runtimeInfo()).toMatchObject({ sessionId: 'branch', cwd: '/tmp' });
    expect(app.requests.filter(r => r.method === 'thread/fork')).toEqual([expect.objectContaining({ params: expect.objectContaining({ threadId: 'source', beforeTurnId: 'turn-2', excludeTurns: true }) })]);
    expect(app.requests.some(r => ['thread/rollback', 'thread/revert', 'turn/start'].includes(r.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('materializes a first-prompt branch without requesting paginated history', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent: 'codex-tui/0.155.1 (Mac OS; arm64)' }),
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd: '/tmp', ...((params as any).includeTurns ? { turns: [] } : {}) } }),
    'thread/turns/list': params => {
      expect((params as { threadId: string }).threadId).toBe('source');
      return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }], nextCursor: null };
    },
    'thread/start': () => ({ thread: { id: 'fresh', cwd: '/tmp' } }),
  });
  const session = await new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target);
  try {
    expect((await session.runtimeInfo()).sessionId).toBe('fresh');
    expect((await session.observe()[Symbol.asyncIterator]().next()).value).toMatchObject({ type: 'history_boundary' });
    expect(app.requests.some(request => ['thread/fork', 'turn/start'].includes(request.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('allows persisted image placeholders that the web composer can restore', async () => {
  const content = [
    { type: 'text', text: '[image #1]', text_elements: [{ byteRange: { start: 0, end: 10 }, placeholder: '[image #1]' }] },
    { type: 'localImage', path: '/managed/image.png' },
  ];
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [{ ...prompt, content }] }]);
  try { await expect(preparePromptEdit(transport, target)).resolves.toMatchObject({ cwd: '/tmp' }); }
  finally { await transport.dispose(); }
});
it('still rejects other native text bindings during prompt editing', async () => {
  const content = [{ type: 'text', text: '$skill', text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: '$skill' }] }];
  const { transport } = fixture([{ id: 'turn-2', status: 'completed', items: [{ ...prompt, content }] }]);
  try { await expect(preparePromptEdit(transport, target)).rejects.toThrow(/bindings/); }
  finally { await transport.dispose(); }
});

it.each(['turn-2', 'later-turn', undefined])('does not publish a branch when native fork ignored its boundary (%s)', async lastTurnId => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent: 'codex_cli_rs/0.155.1' }),
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp' } }),
    'thread/turns/list': params => (params as { threadId: string }).threadId === 'source'
      ? { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }, { id: 'turn-1', status: 'completed', items: [] }], nextCursor: null }
      : { data: lastTurnId ? [{ id: lastTurnId, status: 'completed', items: [] }] : [], nextCursor: null },
    'thread/fork': () => ({ thread: { id: 'branch', cwd: '/tmp' } }),
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target)).rejects.toThrow(/boundary/i);
  expect(app.requests.filter(r => r.method === 'thread/fork')).toHaveLength(1);
  expect(app.requests.some(r => r.method === 'turn/start')).toBe(false);
});

it('rejects a missing pagination capability before creating a branch', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    initialize: () => ({ userAgent: 'unknown' }),
    'thread/read': () => ({ thread: { id: 'source', cwd: '/tmp' } }),
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).validatePromptEdit(target)).rejects.toThrow();
  expect(app.requests.some(request => ['thread/start', 'thread/fork'].includes(request.method))).toBe(false);
});

function completeFixture(first = false) {
  const cwd = realpathSync(process.cwd());
  const source = [
    { id: 'turn-1', status: 'completed', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Keep' }] }, { id: 'answer-1', type: 'agentMessage', text: 'Answer' }] },
    { id: 'turn-2', status: 'completed', items: [prompt] },
    { id: 'turn-3', status: 'completed', items: [{ id: 'user-3', type: 'userMessage', content: [{ type: 'text', text: 'Later' }] }] },
  ];
  const candidate = structuredClone(first ? [] : source.slice(0, 1));
  const selection = first ? { nativeSessionId: 'source', turnId: 'turn-1', messageId: 'user-1' } : target;
  const app = createScriptedAppServer({
    initialize: () => ({}),
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd, status: { type: 'idle' }, parentThreadId: null, canAcceptDirectInput: true, ...((params as any).includeTurns ? { turns: candidate } : {}) } }),
    'thread/turns/list': params => {
      const values = (params as any).threadId === 'source' ? source : candidate;
      const offset = Number((params as any).cursor ?? 0), limit = (params as any).limit;
      return { data: [...values].reverse().slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
    },
    'thread/start': () => ({ thread: { id: 'branch', cwd, status: { type: 'idle' } } }),
    'thread/fork': () => ({ thread: { id: 'branch', cwd, status: { type: 'idle' } } }),
    'thread/queue/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({ data: [], nextCursor: null }),
  });
  return { cwd, source, candidate, selection, app };
}
it.each([true, false])('binds inherited Host callbacks and instructions on the first prompt-edit attachment (first=%s)', async first => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const f = completeFixture(first), original = structuredClone(f.source);
  const provider = new CodexAppServerProvider({ spawn: () => f.app.child });
  const tools = [{ name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' }, execute: async () => 'source-proof' }];
  const session = await provider.forkForPromptEdit(f.selection, { tools, systemPrompt: 'Base instruction.', instructions: 'Team role.' });
  const lines = createInterface({ input: f.app.child.stdin });
  try {
    const request = f.app.requests.find(r => r.method === (first ? 'thread/start' : 'thread/fork'))!;
    expect(request.params).toMatchObject({ developerInstructions: 'Base instruction.\n\nTeam role.' });
    if (first) expect(request.params).toMatchObject({ dynamicTools: [{ type: 'function', name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' } }] });
    else expect(request.params).not.toHaveProperty('dynamicTools');
    const response = new Promise<any>(resolve => lines.on('line', line => { const value = JSON.parse(line); if (value.id === 'callback') resolve(value); }));
    f.app.child.stdout.write(JSON.stringify({ id: 'callback', method: 'item/tool/call', params: { threadId: 'branch', turnId: 'turn', tool: 'read_source_session', arguments: {} } }) + '\n');
    expect((await response).result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'source-proof' }] });
    expect(session.promptEditEvidence?.version).toBe(1);
    expect(await session.promptEditEvidence!.inspectReadiness()).toEqual({ cwd: f.cwd, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
    const token = session.promptEditEvidence!.captureValidity();
    expect(session.promptEditEvidence!.isCurrent(token)).toBe(true);
    f.app.child.stdout.write(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'branch', status: { type: 'idle' } } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.promptEditEvidence!.isCurrent(token)).toBe(false);
    expect(f.source).toEqual(original);
    expect(f.app.requests.some(r => ['turn/start', 'thread/rollback'].includes(r.method))).toBe(false);
  } finally { lines.close(); await session.dispose(); }
});
it.each([true, false])('independently verifies the full prefix with preexisting and newly appended source suffixes (first=%s)', async first => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const f = completeFixture(first);
  const provider = new CodexAppServerProvider({ spawn: () => f.app.child });
  f.source.push({ id: 'turn-4', status: 'inProgress', items: [] });
  await provider.verifyPromptEditBranch(f.selection, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd: f.cwd }) });
  expect(f.app.requests.every(r => ['initialize', 'thread/read', 'thread/turns/list'].includes(r.method))).toBe(true);
});
it.each(['corrupt', 'extra', 'provider', 'source', 'workspace'])('rejects an invalid native candidate without mutation (%s)', async corruption => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const f = completeFixture();
  if (corruption === 'corrupt') f.candidate[0]!.items[0] = { ...f.candidate[0]!.items[0]!, content: [{ type: 'text', text: 'Changed' }] };
  if (corruption === 'extra') f.candidate.push(f.source[1]!);
  const handle = { providerId: corruption === 'provider' ? 'other' : 'codex', sessionId: corruption === 'source' ? 'source' : 'branch', opaque: JSON.stringify({ cwd: corruption === 'workspace' ? '/' : f.cwd }) };
  await expect(new CodexAppServerProvider({ spawn: () => f.app.child }).verifyPromptEditBranch(target, handle)).rejects.toThrow();
  expect(f.app.requests.some(r => ['thread/fork', 'thread/start', 'turn/start'].includes(r.method))).toBe(false);
});

it.each([false, true])('reads the complete native prefix across pages and detects older content corruption (corrupt=%s)', async corrupt => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const f = completeFixture();
  const older = Array.from({ length: 25 }, (_, index) => ({ id: `older-${index}`, status: 'completed', items: [{ id: `older-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Earlier ${index}` }] }] }));
  f.source.unshift(...older); f.candidate.unshift(...structuredClone(older));
  if (corrupt) f.candidate[0]!.items[0]!.content = [{ type: 'text', text: 'Corrupted oldest input' }];
  const verification = new CodexAppServerProvider({ spawn: () => f.app.child }).verifyPromptEditBranch(target, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd: f.cwd }) });
  if (corrupt) await expect(verification).rejects.toThrow(/prefix/i); else await verification;
  expect(f.app.requests.filter(r => r.method === 'thread/turns/list' && (r.params as any).threadId === 'branch')).toHaveLength(3);
});

it('materializes a first-prompt native candidate without input before exposing its persistence handle', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const f = completeFixture(true);
  const session = await new CodexAppServerProvider({ spawn: () => f.app.child }).forkForPromptEdit(f.selection);
  try {
    expect(f.app.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'thread/read', params: { threadId: 'branch', includeTurns: true } })]));
    expect((await session.runtimeInfo()).persistence?.sessionId).toBe('branch');
    expect(f.app.requests.some(r => ['turn/start', 'thread/rollback'].includes(r.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('rejects ambiguous first-prompt materialization readback without dispatching input', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const app = createScriptedAppServer({
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd: '/tmp' } }),
    'thread/turns/list': () => ({ data: [{ id: 'turn-2', status: 'completed', items: [prompt] }], nextCursor: null }),
    'thread/start': () => ({ thread: { id: 'branch', cwd: '/tmp' } }),
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).forkForPromptEdit(target)).rejects.toThrow(/materializ|history/i);
  expect(app.requests.some(r => r.method === 'turn/start')).toBe(false);
});
it.each([true, false])('uses complete authoritative legacy readback when candidate pagination is unsupported (first=%s)', async first => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const cwd = realpathSync(process.cwd());
  const before = { id: 'turn-1', status: 'completed', items: [] };
  const app = createScriptedAppServer({
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd, ...((params as any).includeTurns ? { turns: first ? [] : [before] } : {}) } }),
    'thread/turns/list': params => {
      if ((params as any).threadId === 'branch') throw Object.assign(new Error('Method not found'), { code: -32601 });
      return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }, ...(first ? [] : [before])], nextCursor: null };
    },
  });
  await new CodexAppServerProvider({ spawn: () => app.child }).verifyPromptEditBranch(target, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd }) });
  expect(app.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'thread/read', params: { threadId: 'branch', includeTurns: true } })]));
});

it('fails closed when empty-prefix pagination and complete legacy readback are unsupported', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const cwd = realpathSync(process.cwd());
  const app = createScriptedAppServer({
    'thread/read': params => {
      if ((params as any).includeTurns) throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 });
      return { thread: { id: (params as any).threadId, cwd, turns: [] } };
    },
    'thread/turns/list': params => {
      if ((params as any).threadId === 'branch') throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 });
      return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }], nextCursor: null };
    },
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).verifyPromptEditBranch(target, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd }) })).rejects.toThrow(/not supported/i);
  expect(app.requests.every(r => ['initialize', 'thread/read', 'thread/turns/list'].includes(r.method))).toBe(true);
});


it('rejects an incomplete paginated snapshot returned while probing legacy readback', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const cwd = realpathSync(process.cwd());
  const before = { id: 'turn-1', status: 'completed', items: [] };
  let candidateReads = 0;
  const app = createScriptedAppServer({
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd } }),
    'thread/turns/list': params => {
      if ((params as any).threadId === 'source') return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }, before], nextCursor: null };
      if (++candidateReads === 1) throw Object.assign(new Error('Method not found'), { code: -32601 });
      return { data: [before], nextCursor: 'more-native-turns' };
    },
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).verifyPromptEditBranch(target, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd }) })).rejects.toThrow(/complete|unavailable/i);
  expect(app.requests.every(r => ['initialize', 'thread/read', 'thread/turns/list'].includes(r.method))).toBe(true);
});

it('rejects fallback pagination without an explicit completion cursor', async () => {
  const { CodexAppServerProvider } = await import('./provider.js');
  const cwd = realpathSync(process.cwd());
  let candidateReads = 0;
  const app = createScriptedAppServer({
    'thread/read': params => ({ thread: { id: (params as any).threadId, cwd } }),
    'thread/turns/list': params => {
      if ((params as any).threadId === 'source') return { data: [{ id: 'turn-2', status: 'completed', items: [prompt] }], nextCursor: null };
      if (++candidateReads === 1) throw Object.assign(new Error('Method not found'), { code: -32601 });
      return { data: [] };
    },
  });
  await expect(new CodexAppServerProvider({ spawn: () => app.child }).verifyPromptEditBranch(target, { providerId: 'codex', sessionId: 'branch', opaque: JSON.stringify({ cwd }) })).rejects.toThrow(/complete|unavailable/i);
  expect(candidateReads).toBe(1);
  expect(app.requests).toContainEqual(expect.objectContaining({ method: 'thread/read', params: { threadId: 'branch', includeTurns: true } }));
});
