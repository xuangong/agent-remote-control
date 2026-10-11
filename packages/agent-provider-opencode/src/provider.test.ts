import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { SessionInfo, SessionMessageInfo, PermissionRequest, FormInfo } from '@opencode/client';
import type { ProviderStreamItem, AgentSession } from '@orchardworks/agent-provider-sdk';
import { OpenCodeAgentProvider } from './provider.js';
import { OpenCodeImages } from './images.js';
import { vi } from 'vitest';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 0 } };
const native = (id: string): SessionInfo => ({ id, title: 'Native session', projectID: 'project', location: { directory: process.cwd() },
  model: { providerID: 'test', id: 'model' }, agent: 'build', cost: 0, tokens, time: { created: 1, updated: 1 }, permissions: [] });
async function fixture() {
  const sessions = new Map<string, SessionInfo>([['ses_existing', native('ses_existing')]]);
  const messages = new Map<string, SessionMessageInfo[]>([['ses_existing', [{ type: 'user', id: 'msg_old', text: 'Existing prompt', time: { created: 1 } },
    { type: 'assistant', id: 'msg_reply', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [{ type: 'text', text: 'Existing answer' }], time: { created: 2, completed: 3 } },
    { type: 'idle', id: 'msg_idle', time: { created: 4 }, outcome: 'succeeded' }]]]);
  const streams = new Set<ServerResponse>(), requests: Array<{ path: string; method: string; query: URLSearchParams; body: any }> = [];
  const permissions = new Map<string, PermissionRequest[]>(), forms = new Map<string, FormInfo[]>();
  const instructions = new Map<string, Array<{key: string; value: unknown}>>();
  const state = { prompt: 'normal', historyFailures: 0, nativeFailures: 0, replyFailures: 0, version: '2.0.25', modelEnabled: true };
  const intercept = new Map<string, () => Promise<void>>();
  const block = (path: string) => {
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    intercept.set(path, async () => { arrive(); await gate; }); return { arrived, release };
  };
  let eventId = 0;
  const active: Record<string, { type: 'running' }> = {};
  const event = (type: string, data: unknown, id = `event_${++eventId}`) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ id, type, created: Date.now(), data })}\n\n`); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://test'); let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: url.pathname, method: request.method!, query: url.searchParams, body });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"server.connected","data":{}}\n\n');
      streams.add(response); response.on('close', () => streams.delete(response)); return;
    }
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname === '/api/info') return json({ version: state.version, pid: 1, urls: [], paths: {} });
    if (url.pathname === '/api/session/active') return json({ data: active });
    if (url.pathname === '/api/form') return json({ location: { directory: process.cwd() }, data: [...forms.values()].flat() });
    if (url.pathname === '/api/permission/request') return json({ location: { directory: process.cwd() }, data: [...permissions.values()].flat() });
    if (url.pathname === '/api/model') return json({ location: { directory: process.cwd() }, data: [{ providerID: 'test', id: 'model', modelID: 'model', name: 'Model', enabled: state.modelEnabled, status: 'active', capabilities: {}, variants: [], limit: { context: 1000, output: 100 } }] });
    if (url.pathname === '/api/agent') return json({ location: { directory: process.cwd() }, data: ['build', 'plan'].map(name => ({ id: name, name, mode: 'primary', hidden: false, permissions: [], request: {} })) });
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const value = native('ses_created'); value.location = body.location; sessions.set(value.id, value); messages.set(value.id, []); return json({ data: value });
    }
    if (url.pathname === '/api/session') {
      const available = [...sessions.values()].filter(item => !url.searchParams.has('parentID') || item.parentID === url.searchParams.get('parentID'));
      const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 200);
      return json({ data: available.slice(offset, offset + limit), cursor: { next: String(offset + limit) } });
    }
    const match = /^\/api\/(?:experimental\/)?session\/([^/]+)(.*)$/.exec(url.pathname);
    if (match) {
      const id = match[1]!, suffix = match[2], session = sessions.get(id);
      if (!session) return json({ _tag: 'SessionNotFoundError', sessionID: id, message: 'Missing native session' }, 404);
      if (!suffix) {
        if (request.method === 'PATCH') { Object.assign(session, body); response.writeHead(204).end(); event('session.renamed', { sessionID: id, title: session.title }); return; }
        if (state.nativeFailures-- > 0) return json({ _tag: 'UnknownError', message: 'retry native session' }, 503);
        const snapshot = structuredClone(session);
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        return json({ data: snapshot });
      }
      if (suffix === '/message') {
        if (state.historyFailures-- > 0) return json({ _tag: 'UnknownError', message: 'retry history' }, 503);
        if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ _tag: 'InvalidRequestError', message: 'Cannot combine cursor and order' }, 400);
        const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 200);
        const data = structuredClone([...(messages.get(id) ?? [])].reverse().slice(offset, offset + limit));
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        return json({ data, cursor: data.length ? { previous: String(Math.max(offset-limit,0)), next: String(offset + limit) } : {} });
      }
      if (suffix === '/instructions/entries') return json({ data: instructions.get(id) ?? [] });
      if (suffix.startsWith('/instructions/entries/')) {
        const key = decodeURIComponent(suffix.split('/').at(-1)!);
        instructions.set(id, [...(instructions.get(id) ?? []).filter(item => item.key !== key), {key, value:body.value}]); response.writeHead(204).end(); return;
      }
      if (suffix === '/model' || suffix === '/agent') { Object.assign(session, body); response.writeHead(204).end(); return; }
      if (/^\/permission\/[^/]+\/reply$/.test(suffix)) { permissions.set(id, []); response.writeHead(204).end(); return; }
      if (/^\/form\/[^/]+(?:\/reply)?$/.test(suffix)) {
        forms.set(id, []);
        if (state.replyFailures-- > 0) return json({ _tag: 'UnknownError', message: 'reply result unavailable' }, 503);
        response.writeHead(204).end(); return;
      }
      if (suffix === '/permission') return json({ data: permissions.get(id) ?? [] });
      if (suffix === '/form') return json({ data: forms.get(id) ?? [] });
      if (suffix === '/inbox') return json({ data: [] });
      if (suffix === '/prompt') {
        if (state.prompt === 'drop') { request.socket.destroy(); return; }
        const message: SessionMessageInfo = { type: 'user', id: body.id, text: body.text, time: { created: Date.now() } };
        if (state.prompt === 'ack-only') return json({ data: { id: body.id, sessionID: id, type: 'user', payload: { text: body.text }, time: message.time, delivery: body.delivery } });
        messages.set(id, [...(messages.get(id) ?? []), message]); active[id] = { type: 'running' };
        if (state.prompt === 'accept-drop') { request.socket.destroy(); return; }
        json({ data: { id: body.id, sessionID: id, type: 'user', payload: { text: body.text }, time: message.time, delivery: body.delivery } });
        event('session.inbox.delivered', { sessionID: id, inboxID: body.id }); event('session.execution.started', { sessionID: id }); return;
      }
      if (suffix === '/interrupt') { delete active[id]; session.outcome = 'interrupted';
        const barrier = intercept.get(url.pathname); intercept.delete(url.pathname); if (barrier) await barrier();
        json({ interrupted: true }); event('session.execution.interrupted', { sessionID: id, reason: 'user' }); return; }
    }
    json({ _tag: 'UnknownError', message: `Unexpected ${request.method} ${url.pathname}` }, 500);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const provider = new OpenCodeAgentProvider({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requestTimeoutMs: 2000 });
  cleanup.push(() => provider.close());
  return { provider, messages, active, requests, streams, event, sessions, permissions, forms, state, block, instructions, disconnect() { for (const stream of streams) stream.destroy(); } };
}

it('opens ordinary sessions without handoff profile or unrelated ancestry requests', async () => {
  const f = await fixture();
  f.active.ses_unrelated = { type: 'running' };
  const session = await open(f);
  expect((await session.runtimeInfo()).connection?.state).toBe('connected');
  expect(f.requests.filter(row => ['/api/info', '/api/config', '/api/plugin', '/api/session/ses_unrelated', '/api/session/ses_existing/inbox'].includes(row.path))).toEqual([]);
  expect(f.requests.filter(row => row.path === '/api/model')).toHaveLength(1);
  expect(f.requests.filter(row => row.path === '/api/agent')).toHaveLength(1);
}, 10000);

it('gates every unsupported handoff operation without native requests', async () => {
  const f = await fixture(), session = await open(f);
  const before = f.requests.length, evidence = session.nativeEvidence;
  const unsupported = { code: 'native_evidence_unsupported' };
  expect(f.provider.nativeEvidence.availability()).toMatchObject({ status: 'unavailable', ...unsupported });
  expect(evidence.availability()).toMatchObject({ status: 'unavailable', ...unsupported });
  await expect(f.provider.nativeEvidence.createEmpty({ sessionId: 'session_new', cwd: process.cwd() })).rejects.toMatchObject(unsupported);
  await expect(evidence.inspectReadiness()).rejects.toMatchObject(unsupported);
  await expect(evidence.prepareInput([{ type: 'text', text: 'Do not send' }])).rejects.toMatchObject(unsupported);
  await expect(evidence.dispatchInput({} as any)).rejects.toMatchObject(unsupported);
  expect(await evidence.inspectInput({} as any)).toMatchObject({ status: 'unknown', ...unsupported });
  expect(() => evidence.captureValidity()).toThrow(expect.objectContaining(unsupported));
  expect(evidence.isCurrent({} as any)).toBe(false);
  expect(f.requests.slice(before)).toEqual([]);
}, 10000);

it.each(['opencode.empty', 'opencode.empty-recovery'])('rejects unsupported %s handles before native requests', async kind => {
  const f = await fixture();
  await expect(f.provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_existing', opaque: JSON.stringify({ kind, cwd: process.cwd() }) })).rejects.toMatchObject({ code: 'native_evidence_unsupported' });
  expect(f.requests).toEqual([]);
}, 10000);

it('opens v2 history and shares native observation across sessions', async () => {
  const f = await fixture(); await f.provider.checkAvailability();
  expect(await f.provider.listSessions()).toContainEqual(expect.objectContaining({ id: 'ses_existing', cwd: process.cwd() }));
  const handle = { providerId: 'opencode', sessionId: 'ses_existing', opaque: JSON.stringify({ cwd: process.cwd() }) };
  const first = await f.provider.resumeSession(handle), second = await f.provider.resumeSession(handle);
  const output: ProviderStreamItem[] = []; const read = (async () => { for await (const item of first.observe()) output.push(item); })();
  await expect.poll(() => output.some(item => item.type === 'history_boundary')).toBe(true);
  expect(output).toContainEqual(expect.objectContaining({ type: 'observation', event: expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'Existing answer' }) }) }));
  expect((await first.runtimeInfo())).toMatchObject({ status: 'idle', model: 'test/model', connection: { state: 'connected' } });
  expect(f.requests.filter(request => request.path === '/api/event')).toHaveLength(1);
  await first.dispose(); await second.dispose(); await read;
}, 10000);

it('preserves native message sequence and turn identity when timestamps run backwards', async () => {
  const f = await fixture();
  f.messages.set('ses_existing', [
    { type: 'user', id: 'msg_user', text: 'Original input', time: { created: 100 } },
    { type: 'agent-switched', id: 'msg_control', agent: 'plan', time: { created: 200 } },
    { type: 'assistant', id: 'msg_answer', agent: 'plan', model: { providerID: 'test', id: 'model' }, content: [{ type: 'text', text: 'Answer after agent switch' }], time: { created: 50, completed: 60 } },
    { type: 'idle', id: 'msg_terminal', outcome: 'succeeded', time: { created: 40 } },
  ]);
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'history_boundary'));
  const content = output.flatMap(item => item.type === 'observation' && item.event.type === 'timeline' && ['user_message', 'assistant_message'].includes(item.event.item.type) ? [item.event] : []);
  expect(content.map(event => event.item.type)).toEqual(['user_message', 'assistant_message']);
  expect(content.map(event => event.turnId)).toEqual(['msg_user', 'msg_user']);
  expect(await session.runtimeInfo()).toMatchObject({ status: 'idle' });
}, 10000);

it('creates, sends once, observes authoritative activity, and renames through the v2 API', async () => {
  const f = await fixture(); const session = await f.provider.createSession({ cwd: process.cwd() });
  const accepted: unknown[] = [];
  await session.sendMessage('Native input', { onAcceptance: value => accepted.push(value) });
  await expect.poll(async () => (await session.runtimeInfo()).status).toBe('running');
  expect(accepted).toHaveLength(1);
  expect(f.requests.filter(request => request.path.endsWith('/prompt'))).toHaveLength(1);
  await session.cancel(); await expect.poll(async () => (await session.runtimeInfo()).status).toBe('idle');
  await f.provider.renameSession(session.nativeId, 'Updated title');
  expect(await f.provider.getSession(session.nativeId)).toMatchObject({ title: 'Updated title' });
  await session.dispose();
}, 10000);

it('admits busy steer after exact native delivery without waiting for history refresh', async () => {
  const f = await fixture(); const session = await f.provider.createSession({ cwd: process.cwd() });
  f.state.prompt = 'ack-only';
  const history = f.block(`/api/session/${session.nativeId}/message`);
  try {
    await session.sendMessage('First admitted input');
    const first = f.requests.find(request => request.path.endsWith('/prompt'))!.body.id;
    f.event('session.inbox.delivered', { sessionID: 'ses_other', inboxID: first });
    f.event('session.inbox.delivered', { sessionID: session.nativeId, inboxID: 'msg_other' });
    await expect(session.sendMessage('Must remain fenced')).rejects.toThrow(/pending interactions/);
    f.active[session.nativeId] = { type: 'running' };
    f.event('session.inbox.delivered', { sessionID: session.nativeId, inboxID: first });
    f.event('session.execution.started', { sessionID: session.nativeId });
    await expect.poll(async () => (await session.runtimeInfo()).status).toBe('running');
    await history.arrived;
    await expect(session.steer('Follow-up while history is still pending')).resolves.toEqual({ disposition: 'queued' });
    expect(f.requests.filter(request => request.path.endsWith('/prompt')).map(request => request.body.text)).toEqual(['First admitted input', 'Follow-up while history is still pending']);
  } finally { history.release(); }
}, 10000);

it('refreshes session settings when the native model catalog becomes available', async () => {
  const f = await fixture(); f.state.modelEnabled = false;
  const session = await open(f);
  expect((await session.runtimeInfo()).settings?.find(item => item.id === 'model')?.options).toEqual([]);
  f.state.modelEnabled = true;
  f.event('model.updated', { providerID: 'test', id: 'model' });
  await expect.poll(async () => (await session.runtimeInfo()).settings?.find(item => item.id === 'model')?.options).toContainEqual(expect.objectContaining({ value: 'test/model' }));
  await session.dispose();
}, 10000);

async function open(f: Awaited<ReturnType<typeof fixture>>) {
  return f.provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_existing', opaque: JSON.stringify({ cwd: process.cwd() }) });
}
function observe(session: AgentSession) {
  const items: ProviderStreamItem[] = [];
  const task = (async () => { for await (const item of session.observe()) items.push(structuredClone(item)); })();
  cleanup.push(async () => { await session.dispose(); await task; });
  return items;
}
function text(items: ProviderStreamItem[]) {
  const messages = new Map<string, string>();
  for (const item of items) {
    if (item.type === 'timeline_replacement') {
      messages.clear(); for (const observation of item.observations) {
        const event = observation.event;
        if (event.type === 'timeline' && event.item.type === 'assistant_message') messages.set(event.item.messageId ?? observation.sourceKey, event.item.text);
      }
    } else if (item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'assistant_message') {
      const key = item.event.item.messageId ?? item.sourceKey;
      messages.set(key, (messages.get(key) ?? '') + item.event.item.text);
    }
  }
  return [...messages.values()].join('\n');
}
const settled = async (predicate: () => unknown) => expect.poll(predicate, { timeout: 4000, interval: 15 }).toBeTruthy();

it('skips duplicate renames, returns missing sessions, and verifies the native workspace', async () => {
  const f = await fixture();
  await f.provider.renameSession('ses_existing', 'Native session');
  expect(f.requests.some(row => row.method === 'PATCH')).toBe(false);
  expect(await f.provider.getSession('ses_missing')).toBeUndefined();
  await expect(f.provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_existing', opaque: JSON.stringify({ cwd: '/tmp' }) })).rejects.toThrow('workspace');
  for (let index = 0; index < 401; index++) f.sessions.set(`ses_${index}`, native(`ses_${index}`));
  expect(await f.provider.listSessions()).toHaveLength(402);
  expect(f.requests.filter(row => row.path === '/api/session')).toHaveLength(3);
});

it('bounds the live tail and reads opaque older pages without changing runtime state', async () => {
  const f = await fixture();
  f.messages.set('ses_existing', Array.from({length: 405}, (_, index) => ({id: `msg_${index}`, type: 'user', text: `Input ${index}`, time: {created: index}})));
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'history_boundary'));
  const boundary = output.find(item => item.type === 'history_boundary');
  expect(boundary).toMatchObject({olderCursor: '200'});
  const before = await session.runtimeInfo();
  const older = await session.readTimelineHistory('200');
  expect(older.nextCursor).toBe('400'); expect(older.observations).toHaveLength(200);
  expect((await session.readTimelineHistory('400')).observations).toHaveLength(5);
  expect(await session.runtimeInfo()).toEqual(before);
  expect(f.requests.filter(row => row.query.has('cursor')).every(row => !row.query.has('order'))).toBe(true);
});

it('streams keyed deltas without per-token history reads and ignores duplicate event IDs', async () => {
  const f = await fixture(), session = await open(f), output = observe(session);
  await settled(() => text(output).includes('Existing answer'));
  const reads = f.requests.filter(row => row.path.endsWith('/message')).length;
  f.event('session.text.delta', {sessionID: 'ses_existing', assistantMessageID: 'msg_reply', ordinal: 0, delta: '!'}, 'one');
  f.event('session.text.delta', {sessionID: 'ses_existing', assistantMessageID: 'msg_reply', ordinal: 0, delta: '!'}, 'one');
  await settled(() => text(output) === 'Existing answer!');
  expect(f.requests.filter(row => row.path.endsWith('/message'))).toHaveLength(reads);
});

it('repairs missed native text on reconnect without reporting execution failure', async () => {
  const f = await fixture(), session = await open(f), output = observe(session);
  const reply = f.messages.get('ses_existing')![1]!;
  if (reply.type === 'assistant') reply.content = [{type: 'text', text: 'Corrected after reconnect'}];
  f.disconnect();
  await settled(() => text(output).includes('Corrected after reconnect'));
  expect(output.some(item => item.type === 'observation' && item.event.type === 'turn_failed')).toBe(false);
  expect(await session.runtimeInfo()).toMatchObject({connection: {state: 'connected'}});
});

it('reconciles changes that arrive inside a history snapshot without duplicating text', async () => {
  const f = await fixture(), session = await open(f), output = observe(session);
  const barrier = f.block('/api/session/ses_existing/message');
  f.event('session.renamed', {sessionID: 'ses_existing', title: 'Native session'}); await barrier.arrived;
  const reply = f.messages.get('ses_existing')![1]!;
  if (reply.type === 'assistant') reply.content = [{type: 'text', text: 'Existing answer!'}];
  f.event('session.text.delta', {sessionID: 'ses_existing', assistantMessageID: 'msg_reply', ordinal: 0, delta: '!'});
  barrier.release();
  await settled(() => text(output) === 'Existing answer!');
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(text(output)).toBe('Existing answer!');
});

it('retries a failed reconciliation and then continues processing live events', async () => {
  const f = await fixture(), session = await open(f), output = observe(session);
  f.state.historyFailures = 1; f.event('session.renamed', {sessionID: 'ses_existing'});
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'runtime_updated' && item.event.runtimeInfo.connection?.state === 'restoring'));
  await settled(async () => (await session.runtimeInfo()).connection?.state === 'connected');
  f.event('session.text.delta', {sessionID: 'ses_existing', assistantMessageID: 'msg_reply', ordinal: 0, delta: '!'});
  await settled(() => text(output) === 'Existing answer!');
});

it('keeps uncertain input fenced across unrelated activity and never retries it', async () => {
  const f = await fixture(), session = await open(f); f.state.prompt = 'drop';
  await expect(session.sendMessage('uncertain')).rejects.toThrow();
  f.active.ses_existing = {type:'running'}; f.event('session.execution.started', {sessionID: 'ses_existing'});
  await settled(async () => (await session.runtimeInfo()).status === 'running');
  await expect(session.sendMessage('must not dispatch')).rejects.toThrow();
  f.event('session.execution.failed', {sessionID: 'ses_existing', error: {type:'provider', message:'Unrelated failure'}});
  await expect(session.sendMessage('still fenced')).rejects.toThrow();
  expect(f.requests.filter(row => row.path.endsWith('/prompt'))).toHaveLength(1);
  await session.cancel(); f.state.prompt = 'normal';
  await session.sendMessage('allowed after explicit cancellation');
  expect(f.requests.filter(row => row.path.endsWith('/prompt'))).toHaveLength(2);
});

it('reports native inbox acceptance as queued and never aborts on disposal', async () => {
  const f = await fixture(), session = await open(f), acceptances: unknown[] = [];
  expect(await session.sendMessage('queued by native', {onAcceptance:value => acceptances.push(value)})).toEqual({disposition:'queued'});
  expect(acceptances).toEqual([{disposition:'queued'}]);
  await session.dispose();
  expect(f.requests.some(row => row.path.endsWith('/interrupt'))).toBe(false);
});

it('settles a lost prompt acknowledgement from exact native history without replay', async () => {
  const f = await fixture(), session = await open(f), accepted: unknown[] = [];
  f.state.prompt = 'accept-drop';
  await expect(session.sendMessage('Input with lost acknowledgement', { onAcceptance: value => accepted.push(value) })).rejects.toThrow();
  const invocation = f.requests.find(row => row.path.endsWith('/prompt'))!.body;
  f.messages.get('ses_existing')!.push({ type: 'assistant', id: 'msg_lost_ack_reply', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [], time: { created: 0 } });
  f.event('session.step.started', { sessionID: 'ses_existing', assistantMessageID: 'msg_lost_ack_reply', agent: 'build', model: { providerID: 'test', id: 'model' } });
  await settled(() => accepted.length === 1);
  expect(accepted).toEqual([{ disposition: 'started' }]);
  expect(f.requests.filter(row => row.path.endsWith('/prompt'))).toHaveLength(1);
  expect(f.messages.get('ses_existing')!.filter(message => message.id === invocation.id)).toHaveLength(1);
  expect(f.requests.some(row => row.path.endsWith('/log'))).toBe(false);
}, 10000);

it('restores native forms, answers through v2, and invalidates externally settled requests', async () => {
  const f = await fixture();
  const form: FormInfo = {id:'form_one', sessionID:'ses_existing', title:'Choose', fields:[{key:'answer', type:'string', title:'Answer', required:true}]};
  f.forms.set('ses_existing', [form]);
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_requested'));
  expect((await session.runtimeInfo()).status).toBe('waiting');
  await session.respondToInteraction('form_one', {kind:'form', action:'submit', values:{answer:'yes'}});
  expect(f.requests.find(row => row.path.endsWith('/form/form_one/reply'))?.body).toEqual({answer:{answer:'yes'}});
  const next = {...form, id:'form_two'}; f.forms.set('ses_existing', [next]); f.event('form.created', {form:next});
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_requested' && item.event.request.requestId === 'form_two'));
  f.forms.set('ses_existing', []); f.event('form.cancelled', {sessionID:'ses_existing', id:'form_two'});
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_invalidated' && item.event.requestId === 'form_two'));
  expect(output.some(item => item.type === 'observation' && item.event.type === 'interaction_resolved' && item.event.requestId === 'form_two')).toBe(false);
});

it.each([false, true])('refreshes native state after a form reply without a completion event (response lost: %s)', async responseLost => {
  const f = await fixture();
  f.forms.set('ses_existing', [{ id: 'form_reply', sessionID: 'ses_existing', title: 'Answer', fields: [{ key: 'answer', type: 'string', required: true }] }]);
  const session = await open(f), output = observe(session);
  expect((await session.runtimeInfo()).status).toBe('waiting');
  f.state.replyFailures = responseLost ? 1 : 0;
  const reply = session.respondToInteraction('form_reply', { kind: 'form', action: 'submit', values: { answer: 'yes' } });
  if (responseLost) await expect(reply).rejects.toThrow();
  else await reply;
  await settled(async () => (await session.runtimeInfo()).status === 'idle');
  if (responseLost) {
    expect(output.some(item => item.type === 'observation' && item.event.type === 'interaction_resolved')).toBe(false);
    expect(output.some(item => item.type === 'observation' && item.event.type === 'interaction_invalidated' && item.event.requestId === 'form_reply')).toBe(true);
  }
}, 10000);

it('recovers current selections after a runtime settings read fails without another native event', async () => {
  const f = await fixture(), session = await open(f);
  f.sessions.get('ses_existing')!.agent = 'plan';
  f.state.nativeFailures = 1;
  await expect(session.runtimeInfo({ refreshSettings: true })).rejects.toThrow();
  await settled(async () => (await session.runtimeInfo()).mode === 'plan');
}, 10000);

it('keeps unsupported native forms visibly waiting instead of silently losing required fields', async () => {
  const f = await fixture();
  f.forms.set('ses_existing', [{id:'conditional', sessionID:'ses_existing', title:'Native conditional form', fields:[{key:'answer', type:'string', pattern:'^[a-z]+$'}]}]);
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'error' && item.event.item.message.includes('pattern')));
  expect((await session.runtimeInfo()).status).toBe('waiting');
  await expect(session.respondToInteraction('conditional', {kind:'form', action:'submit', values:{answer:'x'}})).rejects.toThrow('no longer pending');
  expect(f.requests.some(row => row.path.endsWith('/conditional/reply'))).toBe(false);
});

it('maps project-persistent native approval explicitly and disallows session-only claims', async () => {
  const f = await fixture();
  f.permissions.set('ses_existing', [{id:'allow', sessionID:'ses_existing', action:'shell', resources:['pwd'], save:['pwd']}]);
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_requested'));
  await expect(session.respondToInteraction('allow', {kind:'tool_approval', decision:'allow', scope:'session'})).rejects.toThrow();
  await session.respondToInteraction('allow', {kind:'tool_approval', decision:'allow', scope:'policy', policyId:'opencode:save'});
  expect(f.requests.find(row => row.path.endsWith('/permission/allow/reply'))?.body).toEqual({decision:'always'});
});

it('stores Host instructions once in the native session and confirms their readback', async () => {
  const f = await fixture(), session = await f.provider.createSession({cwd:process.cwd(), systemPrompt:'Stay within this task.'});
  const runtime = await session.runtimeInfo();
  expect(f.instructions.get(session.nativeId)).toEqual([{key:'arc.host.system', value:'Stay within this task.'}]);
  const other = await f.provider.resumeSession(runtime.persistence!, {systemPrompt:'Stay within this task.'});
  expect(f.requests.filter(row => row.path.includes('/instructions/entries/') && row.method === 'PUT')).toHaveLength(1);
  await other.dispose();
});

it('uses native execution truth instead of old errors and updates session token snapshots', async () => {
  const f = await fixture(); const history = f.messages.get('ses_existing')!;
  const reply = history[1]!; if (reply.type === 'assistant') reply.error = {type:'provider', message:'Historical error'};
  const session = await open(f), output = observe(session);
  expect((await session.runtimeInfo()).status).toBe('idle');
  expect(output.some(item => item.type === 'observation' && item.event.type === 'turn_failed')).toBe(false);
  f.sessions.get('ses_existing')!.tokens = {...tokens, output:99}; f.event('session.usage.updated', {sessionID:'ses_existing', tokens:{...tokens, output:99},cost:0});
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'usage_updated' && item.event.usage.outputTokens === 99));
  f.active.ses_existing = {type:'running'}; f.event('session.execution.started', {sessionID:'ses_existing'});
  await settled(async () => (await session.runtimeInfo()).status === 'running');
  delete f.active.ses_existing; f.sessions.get('ses_existing')!.outcome = 'interrupted'; f.event('session.execution.interrupted', {sessionID:'ses_existing',reason:'user'});
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'turn_canceled'));
  expect(output.some(item => item.type === 'observation' && item.event.type === 'turn_failed')).toBe(false);
});

it('fences stale native selections while a setting is confirmed during active work', async () => {
  const f = await fixture(); f.active.ses_existing = {type:'running'};
  const session = await open(f), gate = f.block('/api/session/ses_existing');
  const stale = session.runtimeInfo({refreshSettings:true}); await gate.arrived;
  await session.setPlanning(true); gate.release(); await stale;
  expect(await session.runtimeInfo()).toMatchObject({status:'running', mode:'plan', planning:{active:true}});
  expect(f.requests.some(row => row.path.endsWith('/interrupt'))).toBe(false);
});

it('discovers native children and preserves the shared parent identity', async () => {
  const f = await fixture(), session = await open(f);
  f.sessions.set('ses_child', {...native('ses_child'), parentID:'ses_existing'}); f.messages.set('ses_child', []);
  f.event('session.created', {sessionID:'ses_child',parentID:'ses_existing'});
  await settled(async () => (await session.runtimeInfo()).childSessions?.some(child => child.nativeSessionId === 'ses_child'));
  const child = await f.provider.openChildSession('ses_existing','ses_child');
  expect((await child.runtimeInfo()).sessionId).toBe('ses_child');
  await expect(f.provider.openChildSession('ses_child','ses_existing')).rejects.toThrow('direct native child');
  await child.dispose();
});

it('validates images before admission and leaves the session usable after local failure', async () => {
  const f = await fixture(), session = await open(f);
  const transform = vi.spyOn(OpenCodeImages.prototype,'input').mockRejectedValueOnce(new Error('Invalid image input'));
  await expect(session.sendMessage('local transform failure')).rejects.toThrow('Invalid image input'); transform.mockRestore();
  expect(f.requests.some(row => row.path.endsWith('/prompt'))).toBe(false);
  await session.sendMessage('valid input');
  expect(f.requests.filter(row => row.path.endsWith('/prompt'))).toHaveLength(1);
});

it('supports only the reviewed current native API major', async () => {
  const f = await fixture(); f.state.version = '1.18.31';
  await expect(f.provider.checkAvailability()).rejects.toThrow('requires OpenCode 2.x');
  f.state.version = '2.1.0'; await expect(f.provider.checkAvailability()).resolves.toBeUndefined();
  f.state.version = '3.0.0'; await expect(f.provider.checkAvailability()).rejects.toThrow('different server API');
});

it('rebinds a running turn from the new native prompt without reusing the prior idle turn', async () => {
  const f = await fixture(), session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'history_boundary'));
  f.messages.get('ses_existing')!.push({ type: 'user', id: 'msg_next', text: 'New turn', time: { created: 10 } });
  f.active.ses_existing = { type: 'running' };
  f.event('session.execution.started', { sessionID: 'ses_existing' });
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'runtime_updated' && item.event.activeTurnId === 'msg_next'));
  expect(output.some(item => item.type === 'observation' && item.event.type === 'turn_started' && item.event.turnId === 'msg_old')).toBe(false);
  delete f.active.ses_existing;
  f.sessions.get('ses_existing')!.outcome = 'succeeded';
  f.messages.get('ses_existing')!.push({ type: 'idle', id: 'idle_next', outcome: 'succeeded', time: { created: 11 } });
  f.event('session.execution.succeeded', { sessionID: 'ses_existing' });
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'turn_completed' && item.event.turnId === 'msg_next'));
  expect(output.filter(item => item.type === 'observation' && item.event.type === 'turn_completed')).toHaveLength(1);
}, 10000);

it('does not reuse an earlier turn failure when the latest failed turn has no assistant error', async () => {
  const f = await fixture();
  f.sessions.get('ses_existing')!.outcome = 'failed';
  f.messages.set('ses_existing', [
    { type: 'user', id: 'first', text: 'Earlier turn', time: { created: 1 } },
    { type: 'assistant', id: 'first_error', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [], error: { type: 'provider', message: 'Earlier credential failure' }, time: { created: 2, completed: 2 } },
    { type: 'idle', id: 'first_idle', outcome: 'failed', time: { created: 3 } },
    { type: 'user', id: 'latest', text: 'Latest turn', time: { created: 4 } },
    { type: 'idle', id: 'latest_idle', outcome: 'failed', time: { created: 5 } },
  ]);
  const session = await open(f), info = await session.runtimeInfo();
  expect(info.status).toBe('failed');
  expect(JSON.stringify(info.failure ?? null)).not.toContain('Earlier credential failure');
}, 10000);

it('settles a native turn once when its terminal event arrives after recovery already read its idle record', async () => {
  const f = await fixture();
  f.messages.get('ses_existing')!.pop();
  f.active.ses_existing = { type: 'running' };
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'runtime_updated' && item.event.activeTurnId === 'msg_old'));
  f.messages.get('ses_existing')!.push({ type: 'idle', id: 'final_idle', time: { created: 10 }, outcome: 'succeeded' });
  f.sessions.get('ses_existing')!.outcome = 'succeeded';
  delete f.active.ses_existing;
  f.event('session.renamed', { sessionID: 'ses_existing' });
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'turn_completed' && item.event.turnId === 'msg_old'));
  f.event('session.execution.succeeded', { sessionID: 'ses_existing' });
  await new Promise(resolve => setTimeout(resolve, 180));
  expect(output.filter(item => item.type === 'observation' && item.event.type === 'turn_completed')).toHaveLength(1);
}, 10000);

it('waits for current terminal evidence when inactive and session outcome refer to different snapshots', async () => {
  const f = await fixture();
  f.sessions.get('ses_existing')!.outcome = 'failed';
  f.messages.get('ses_existing')!.push({ type: 'user', id: 'current', text: 'Current turn', time: { created: 10 } });
  f.active.ses_existing = { type: 'running' };
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'runtime_updated' && item.event.activeTurnId === 'current'));
  delete f.active.ses_existing;
  f.event('session.renamed', { sessionID: 'ses_existing' });
  await settled(async () => (await session.runtimeInfo()).status !== 'running');
  expect(output.some(item => item.type === 'observation' && ['turn_failed', 'turn_completed', 'turn_canceled'].includes(item.event.type))).toBe(false);
  f.messages.get('ses_existing')!.push({ type: 'idle', id: 'current_idle', time: { created: 11 }, outcome: 'succeeded' });
  f.sessions.get('ses_existing')!.outcome = 'succeeded';
  f.event('session.execution.succeeded', { sessionID: 'ses_existing' });
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'turn_completed' && item.event.turnId === 'current'));
  expect(output.filter(item => item.type === 'observation' && item.event.type === 'turn_completed')).toHaveLength(1);
}, 10000);

it('invalidates an externally answered custom form when its receipt cannot fit the public question shape', async () => {
  const f = await fixture();
  f.forms.set('ses_existing', [{ id: 'custom', sessionID: 'ses_existing', title: 'Choose custom values', fields: [{ key: 'values', type: 'multiselect', custom: true, options: [{ value: 'fixed', label: 'Fixed' }] }] }]);
  const session = await open(f), output = observe(session);
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_requested' && item.event.request.requestId === 'custom'));
  const offset = output.length;
  f.forms.set('ses_existing', []);
  f.event('form.replied', { sessionID: 'ses_existing', id: 'custom', answer: { values: ['first custom', 'second custom'] } });
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'interaction_invalidated' && item.event.requestId === 'custom'));
  await settled(async () => (await session.runtimeInfo()).status === 'idle');
  expect(output.slice(offset).some(item => item.type === 'observation' && item.event.type === 'runtime_updated' && item.event.runtimeInfo.connection?.state === 'restoring')).toBe(false);
  expect(output.some(item => item.type === 'observation' && item.event.type === 'interaction_resolved' && item.event.requestId === 'custom')).toBe(false);
}, 10000);

it('reports a child waiting on native forms or approvals even when execution is inactive', async () => {
  const f = await fixture();
  f.sessions.set('ses_child', { ...native('ses_child'), parentID: 'ses_existing' });
  f.messages.set('ses_child', []);
  f.forms.set('ses_child', [{ id: 'child_form', sessionID: 'ses_child', title: 'Answer required', fields: [{ key: 'answer', type: 'string', required: true }] }]);
  const session = await open(f);
  expect((await session.runtimeInfo()).childSessions).toContainEqual(expect.objectContaining({ nativeSessionId: 'ses_child', status: 'waiting' }));
  expect((await session.runtimeInfo()).status).toBe('idle');
  f.forms.set('ses_child', []);
  f.permissions.set('ses_child', [{ id: 'child_permission', sessionID: 'ses_child', action: 'shell', resources: ['pwd'] }]);
  f.event('permission.asked', { sessionID: 'ses_child', id: 'child_permission', action: 'shell', resources: ['pwd'] });
  await settled(() => f.requests.filter(row => row.path === '/api/permission/request').length >= 2);
  expect((await session.runtimeInfo()).childSessions).toContainEqual(expect.objectContaining({ nativeSessionId: 'ses_child', status: 'waiting' }));
  expect(f.requests.filter(row => row.path === '/api/form' || row.path === '/api/permission/request').every(row => row.query.get('location[directory]') === process.cwd())).toBe(true);
}, 10000);

it('clears an old failure reason when reconnect discovers a different failed turn without one', async () => {
  const f = await fixture();
  f.sessions.get('ses_existing')!.outcome = 'failed';
  f.messages.set('ses_existing', [
    { type: 'user', id: 'first_failed', text: 'Earlier turn', time: { created: 1 } },
    { type: 'assistant', id: 'first_error', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [], error: { type: 'provider', message: 'Earlier credential failure' }, time: { created: 2, completed: 2 } },
    { type: 'idle', id: 'first_idle', outcome: 'failed', time: { created: 3 } },
  ]);
  const session = await open(f), output = observe(session);
  expect((await session.runtimeInfo()).failure?.message).toBe('Earlier credential failure');
  f.messages.get('ses_existing')!.push(
    { type: 'user', id: 'latest_failed', text: 'Latest turn', time: { created: 4 } },
    { type: 'idle', id: 'latest_idle', outcome: 'failed', time: { created: 5 } },
  );
  f.disconnect();
  await settled(() => output.some(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'user_message' && item.event.item.text === 'Latest turn'));
  const info = await session.runtimeInfo();
  expect(info.status).toBe('failed');
  expect(JSON.stringify(info.failure ?? null)).not.toContain('Earlier credential failure');
}, 10000);
