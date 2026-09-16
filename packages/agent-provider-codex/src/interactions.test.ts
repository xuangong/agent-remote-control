import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, AgentInteractionResponse, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { CodexAppServerSession } from './session.js';
import { CodexAppServerTransport } from './app-server-transport.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const sessions: CodexAppServerSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.dispose())); });
async function harness(restrictedNative = false) {
  const server = createScriptedAppServer({ 'thread/start': () => ({ thread: { id: 'thread' } }) });
  const replies: Array<{ id: string; result?: unknown; error?: unknown }> = [];
  server.child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line);
      if (!message.method && message.id !== undefined) replies.push(message);
    }
  });
  const session = await CodexAppServerSession.create(new CodexAppServerTransport(server.child), { sessionId: 'local' }, undefined, undefined, restrictedNative);
  sessions.push(session);
  const iterator = session.observe()[Symbol.asyncIterator]();
  await iterator.next();
  const send = (method: string, params: unknown, id?: string) => server.child.stdout.write(`${JSON.stringify({ method, params, ...(id ? { id } : {}) })}\n`);
  const request = async (method: string, params: object, id = 'native') => {
    send(method, { threadId: 'thread', turnId: 'turn', ...params }, id);
    const event = (await iterator.next()).value as ProviderStreamItem;
    if (event.type !== 'observation' || event.event.type !== 'interaction_requested') throw new Error(JSON.stringify(event));
    return event.event.request;
  };
  return { session, iterator, replies, send, request, child: server.child };
}

describe('Codex native interactions', () => {
  it.each(['form', 'openai/form'])('round trips %s typed fields without exposing a secret receipt', async (mode) => {
    const h = await harness();
    const request = await h.request('mcpServer/elicitation/request', {
      serverName: 'account', mode, message: 'Configure account', _meta: null,
      requestedSchema: { type: 'object', properties: {
        token: { type: 'string', title: 'Token', minLength: 3, isSecret: true },
        count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
        tags: { type: 'array', minItems: 1, maxItems: 2, items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] } },
      }, required: ['token'] },
    });
    expect(request).toMatchObject({ kind: 'form', fields: [
      { fieldId: 'token', type: 'text', sensitive: true, required: true, minLength: 3 },
      { fieldId: 'count', type: 'number', integer: true, minimum: 1, maximum: 5, defaultValue: 2 },
      { fieldId: 'tags', type: 'multiselect', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
    ] });
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'form', action: 'submit', values: { token: 'x' } })).rejects.toThrow();
    await h.session.respondToInteraction(request.requestId, { kind: 'form', action: 'submit', values: { token: 'secret-token', count: 3, tags: ['b'] } });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { action: 'accept', content: { token: 'secret-token', count: 3, tags: ['b'] }, _meta: null } }]);
    const receipt = (await h.iterator.next()).value;
    expect(JSON.stringify(receipt)).not.toContain('secret-token');
    expect(receipt).toMatchObject({ event: { response: { redactedFields: ['token'] } } });
  });

  it('declines unsupported nested schemas with a diagnostic and no partial form', async () => {
    const h = await harness();
    h.send('mcpServer/elicitation/request', { threadId: 'thread', serverName: 'mcp', mode: 'openai/form', message: 'Configure', requestedSchema: { type: 'object', properties: { nested: { type: 'object', properties: {} } } } }, 'nested');
    await expect.poll(() => h.replies).toEqual([{ id: 'nested', result: { action: 'decline', content: null, _meta: null } }]);
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'timeline', item: { type: 'error', message: expect.stringContaining('unavailable') } } });
  });

  it('round trips an explicit URL acknowledgment', async () => {
    const h = await harness();
    const request = await h.request('mcpServer/elicitation/request', { serverName: 'account', mode: 'url', message: 'Sign in', url: 'https://example.com/login', elicitationId: 'login' });
    expect(request).toMatchObject({ kind: 'external_action', url: 'https://example.com/login' });
    await h.session.respondToInteraction(request.requestId, { kind: 'external_action', action: 'completed' });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { action: 'accept', content: null, _meta: null } }]);
  });

  it('shows precise permission paths and returns only the private native grant', async () => {
    const h = await harness();
    const permissions = { network: { enabled: true }, fileSystem: { read: ['/read'], write: null, globScanMaxDepth: 2, entries: [
      { path: { type: 'glob_pattern', pattern: '/project/**' }, access: 'write' },
      { path: { type: 'special', value: { kind: 'project_roots', subpath: 'private' } }, access: 'deny' },
    ] } };
    const request = await h.request('item/permissions/requestApproval', { itemId: 'p', cwd: '/project', reason: 'Need access', permissions });
    expect(request).toMatchObject({ kind: 'permission_approval', allowScopes: ['turn', 'session'], permissions: [
      { resource: 'network', access: 'connect', target: '*' },
      { resource: 'filesystem', access: 'read', target: '/read' },
      { resource: 'filesystem', access: 'write', target: 'glob: /project/** (scan depth: 2)' },
      { resource: 'filesystem', access: 'deny', target: 'special: project_roots / private' },
    ] });
    await h.session.respondToInteraction(request.requestId, { kind: 'permission_approval', decision: 'allow', scope: 'turn' });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { permissions, scope: 'turn' } }]);
  });

  it('honors exact native available decisions including policy choices and cancel', async () => {
    const h = await harness();
    const policy = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } };
    const request = await h.request('item/commandExecution/requestApproval', { itemId: 'cmd', command: 'pnpm test', availableDecisions: [policy, 'cancel'], networkApprovalContext: { host: 'example.com', protocol: 'https' } });
    expect(request).toMatchObject({ kind: 'tool_approval', allowedDecisions: ['allow', 'cancel'], allowScopes: ['policy'], context: [{ label: 'Network', value: 'https://example.com' }] });
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'session' })).rejects.toThrow();
    const approval = request as Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
    await h.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: approval.policies![0]!.policyId });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { decision: policy } }]);
  });

  it('preserves secret question input exactly and redacts its receipt', async () => {
    const h = await harness();
    const request = await h.request('item/tool/requestUserInput', { questions: [{ id: 'secret', header: 'Secret', question: 'Value?', isOther: true, isSecret: true, options: [] }] });
    expect(request).toMatchObject({ questions: [{ sensitive: true }] });
    await h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [{ questionId: 'secret', selectedValues: [], customText: '  secret value  ' }] });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { answers: { secret: { answers: ['  secret value  '] } } } }]);
    expect(JSON.stringify((await h.iterator.next()).value)).not.toContain('secret value');
  });

  it('rejects cross-thread native requests before presenting controls', async () => {
    const h = await harness();
    h.send('item/tool/requestUserInput', { threadId: 'wrong', questions: [{ id: 'a', header: 'A', question: 'A?' }] }, 'wrong');
    await expect.poll(() => h.replies).toEqual([{ id: 'wrong', error: { code: -32603, message: expect.stringContaining('thread') } }]);
  });
});

describe('Codex interaction cancellation', () => {
  it('clears all transient requests on turn interruption without replying with fabricated answers', async () => {
    const h = await harness();
    const question = await h.request('item/tool/requestUserInput', { questions: [{ id: 'a', header: 'A', question: 'A?' }] }, 'q');
    const form = await h.request('mcpServer/elicitation/request', { serverName: 'm', mode: 'form', message: 'Fill', requestedSchema: { type: 'object', properties: { text: { type: 'string' } } } }, 'f');
    h.send('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } });
    for (let i = 0; i < 3; i++) await h.iterator.next();
    await expect(h.session.respondToInteraction(question.requestId, { kind: 'question', dismissed: true, answers: [] })).rejects.toThrow('No pending');
    await expect(h.session.respondToInteraction(form.requestId, { kind: 'form', action: 'cancel' })).rejects.toThrow('No pending');
    expect(h.replies).toEqual([]);
  });
  it('clears externally resolved forms without sending a duplicate native reply', async () => {
    const h = await harness();
    const request = await h.request('mcpServer/elicitation/request', { serverName: 'm', mode: 'form', message: 'Fill', requestedSchema: { type: 'object', properties: { text: { type: 'string' } } } });
    h.send('serverRequest/resolved', { threadId: 'thread', requestId: 'native' });
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'interaction_resolved', requestId: request.requestId, response: { kind: 'form', action: 'cancel' } } });
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'form', action: 'cancel' })).rejects.toThrow('No pending');
    expect(h.replies).toEqual([]);
  });
});

describe('Codex native decision boundaries', () => {
  it.each(['decline', 'cancel'] as const)('returns the exact %s form action', async (action) => {
    const h = await harness();
    const request = await h.request('mcpServer/elicitation/request', { serverName: 'm', mode: 'form', message: 'Fill', requestedSchema: { type: 'object', properties: { text: { type: 'string' } } } });
    await h.session.respondToInteraction(request.requestId, { kind: 'form', action });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { action, content: null, _meta: null } }]);
  });
  it('returns exact network policy decisions and never exposes native grants as editable values', async () => {
    const h = await harness();
    const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } };
    const request = await h.request('item/commandExecution/requestApproval', { itemId: 'cmd', availableDecisions: [decision, 'cancel'] });
    if (request.kind !== 'tool_approval') throw new Error('Expected approval');
    expect(request.policies).toEqual([{ policyId: 'policy:0', description: 'Deny network host example.com for future requests' }]);
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'unrequested' })).rejects.toThrow();
    await h.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'policy:0' });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { decision } }]);
  });
  it('declines unknown permission semantics without granting the representable subset', async () => {
    const h = await harness();
    h.send('item/permissions/requestApproval', { threadId: 'thread', permissions: { network: { enabled: true }, fileSystem: { read: ['/read'], write: null, execute: ['/bin'] } } }, 'unsupported');
    await expect.poll(() => h.replies).toEqual([{ id: 'unsupported', result: { permissions: {}, scope: 'turn' } }]);
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'timeline', item: { type: 'error' } } });
  });
  it('rejects injected grant data and returns an empty grant on denial', async () => {
    const h = await harness();
    const request = await h.request('item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } });
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'permission_approval', decision: 'allow', scope: 'session', permissions: { fileSystem: { write: ['/'] } } } as never)).rejects.toThrow();
    await h.session.respondToInteraction(request.requestId, { kind: 'permission_approval', decision: 'deny' });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { permissions: {}, scope: 'turn' } }]);
  });
});

describe('Codex private request data', () => {
  it.each(['isSecret', 'sensitive', 'writeOnly'])('declines a %s default without exposing it in events or native diagnostics', async (marker) => {
    const h = await harness();
    h.send('mcpServer/elicitation/request', { threadId: 'thread', serverName: 'mcp', mode: 'openai/form', message: 'Fill', requestedSchema: { type: 'object', properties: {
      token: { type: 'string', [marker]: true, default: 'PRIVATE_DEFAULT_SENTINEL' },
    } } }, 'private-default');
    await expect.poll(() => h.replies).toEqual([{ id: 'private-default', result: { action: 'decline', content: null, _meta: null } }]);
    const observation = (await h.iterator.next()).value;
    expect(observation).toMatchObject({ event: { type: 'timeline', item: { type: 'error' } } });
    expect(JSON.stringify([observation, h.replies])).not.toContain('PRIVATE_DEFAULT_SENTINEL');
  });
  it('ignores a resolution lacking thread correlation and keeps the pending request answerable', async () => {
    const h = await harness();
    const request = await h.request('item/tool/requestUserInput', { questions: [{ id: 'a', header: 'A', question: 'A?' }] });
    h.send('serverRequest/resolved', { requestId: 'native' });
    await h.session.respondToInteraction(request.requestId, { kind: 'question', dismissed: true, answers: [] });
    await expect.poll(() => h.replies).toEqual([{ id: 'native', result: { answers: {} } }]);
  });
});


describe('Codex terminal interaction lifecycle', () => {
  const cases: Array<{ method: string; params: object; response: AgentInteractionResponse; native: unknown }> = [
    { method: 'item/tool/requestUserInput', params: { itemId: 'question-tool', isBlocking: true, questions: [{ id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'Continue' }] }] },
      response: { kind: 'question', answers: [{ questionId: 'answer', selectedValues: ['Yes'] }] }, native: { answers: { answer: { answers: ['Yes'] } } } },
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'command-tool', command: 'pwd', availableDecisions: ['accept', 'cancel'] },
      response: { kind: 'tool_approval', decision: 'allow', scope: 'once' }, native: { decision: 'accept' } },
    { method: 'item/permissions/requestApproval', params: { itemId: 'permission-tool', cwd: '/workspace', permissions: { network: { enabled: true }, fileSystem: null } },
      response: { kind: 'permission_approval', decision: 'allow', scope: 'turn' }, native: { permissions: { network: { enabled: true } }, scope: 'turn' } },
    { method: 'mcpServer/elicitation/request', params: { serverName: 'mcp', mode: 'form', message: 'Configure', _meta: null, requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } } },
      response: { kind: 'form', action: 'submit', values: { enabled: true } }, native: { action: 'accept', content: { enabled: true }, _meta: null } },
    { method: 'mcpServer/elicitation/request', params: { serverName: 'mcp', mode: 'url', message: 'Authenticate', _meta: null, url: 'https://example.com/auth', elicitationId: 'auth' },
      response: { kind: 'external_action', action: 'completed' }, native: { action: 'accept', content: null, _meta: null } },
  ];
  for (const status of ['interrupted', 'failed'] as const) {
    it.each(cases)(`keeps unrelated $response.kind requests answerable when another turn is ${status}`, async ({ method, params, response, native }) => {
      const h = await harness();
      const owned = await h.request(method, { ...params, turnId: 'owned-turn' }, 'owned');
      const unrelated = await h.request(method, { ...params, turnId: 'other-turn' }, 'other');
      const standalone = method === 'mcpServer/elicitation/request'
        ? await h.request(method, { ...params, turnId: null }, 'standalone') : undefined;
      h.send('turn/completed', { threadId: 'thread', turn: { id: 'owned-turn', status, error: status === 'failed' ? { message: 'Native turn failed' } : null } });
      expect((await h.iterator.next()).value).toMatchObject({ event: { type: status === 'failed' ? 'turn_failed' : 'turn_canceled', turnId: 'owned-turn' } });
      expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'interaction_resolved', requestId: owned.requestId } });
      await expect(h.session.respondToInteraction(owned.requestId, response)).rejects.toThrow('No pending');
      expect(h.replies).toEqual([]);
      await h.session.respondToInteraction(unrelated.requestId, response);
      if (standalone) await h.session.respondToInteraction(standalone.requestId, response);
      await expect.poll(() => h.replies).toEqual([
        { id: 'other', result: native }, ...(standalone ? [{ id: 'standalone', result: native }] : []),
      ]);
    });
  }

  it('emits cancellation before transport failure without writing a native response', async () => {
    const h = await harness();
    const request = await h.request('mcpServer/elicitation/request', { turnId: null, serverName: 'm', mode: 'url', message: 'Continue', url: 'https://example.com', elicitationId: 'external' });
    h.child.emitExit(1);
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'interaction_resolved', requestId: request.requestId, response: { kind: 'external_action', action: 'cancel' } } });
    await expect(h.iterator.next()).rejects.toThrow('exited with code 1');
    expect(h.replies).toEqual([]);
  });
  it('closes externally resolved permission requests with an explicit no-local-grant diagnostic', async () => {
    const h = await harness();
    const request = await h.request('item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } });
    h.send('serverRequest/resolved', { threadId: 'thread', requestId: 'native' });
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'interaction_resolved', requestId: request.requestId, response: { kind: 'permission_approval', decision: 'deny' } } });
    expect((await h.iterator.next()).value).toMatchObject({ event: { type: 'timeline', item: { type: 'error', message: expect.stringContaining('remote client granted no permissions') } } });
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'permission_approval', decision: 'allow', scope: 'session' })).rejects.toThrow('No pending');
    expect(h.replies).toEqual([]);
  });
});


it('denies additional native permission grants in restricted mode while retaining ordinary tool approval', async () => {
  const h = await harness(true);
  h.send('item/permissions/requestApproval', { threadId: 'thread', permissions: { network: { enabled: true }, fileSystem: null } }, 'extra-permissions');
  await expect.poll(() => h.replies).toContainEqual({ id: 'extra-permissions', result: { permissions: {}, scope: 'turn' } });
  const request = await h.request('item/fileChange/requestApproval', { itemId: 'edit', reason: 'Edit the current workspace' }, 'ordinary-tool');
  expect(request.kind).toBe('tool_approval');
  await h.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
  await expect.poll(() => h.replies).toContainEqual({ id: 'ordinary-tool', result: { decision: 'accept' } });
});
