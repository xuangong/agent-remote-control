import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { OpenCodeAgentProvider } from './provider.js';
import { OpenCodeProviderNativeEvidence } from './native-evidence.js';
import { OpenCodeTransport } from './transport.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { const failures: unknown[] = []; for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } } if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed.'); });
async function fixture(configured: boolean | 'supplier' = true) {
  const temporary = await mkdtemp(join(tmpdir(), 'arc-native-evidence-'));
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const cwd = await realpath(temporary);
  const native: any = { id: 'ses_B', directory: cwd, title: 'Fixture', model: { providerID: 'test', id: 'model' }, agent: 'build', time: { created: 1, updated: 1 } };
  const natives = new Map<string, any>([['ses_B', native]]);
  const config: any = { default_agent: 'build', model: 'test/model' };
  const capabilities = { backgroundSubagents: false };
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const streams = new Set<ServerResponse>(); const messages: any[] = []; const statuses: Record<string, {type: string}> = {}; const permissions: any[] = []; const questions: any[] = [];
  let createReply: any = native; let createHook: (() => void | Promise<void>) | undefined; let promptStatus = 204; let sessionStatus = 200; let status = 'idle'; let readsBlocked: Promise<void> | undefined; let blockedReadPath: string | undefined;
  let lease = Object.freeze({}); let current = true; let profile = true;
  const listeners = new Set<() => void>(); let bound: object | undefined;
  const verifier = {
    async refresh() {},
    async targetSelections() { return { model: 'test/model', agent: 'build' }; },
    observeSession() {},
    validateSelections() {},
    relation() { return 'unknown' as const; },
    captureAuthority(transport: object, directory: string) { if (bound && bound !== transport || directory !== cwd || !current) return { status: 'unavailable' as const }; bound = transport; return { status: 'verified' as const, authority: { kind: 'trusted-service' as const, authorityId: 'fixture', namespaceId: 'owned-namespace' }, lease }; },
    isCurrent(token: object) { return current && token === lease; },
    isObservationCurrent(token: object) { return current && profile && token === lease; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    const json = (value: unknown, code = 200) => response.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/global/event') { streams.add(response); response.on('close', () => streams.delete(response)); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(`data: ${JSON.stringify({ directory: cwd, payload: { type: 'server.connected', properties: {} } })}\n\n`); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}'); requests.push({ method: request.method!, path, body });
    if (request.method === 'GET' && readsBlocked && (blockedReadPath === undefined || path === blockedReadPath)) await readsBlocked;
    if (path === '/global/health') return json({ healthy: true, version: '1.18.18' });
    if (path === '/config') return json(config);
    if (path === '/experimental/capabilities') return json(capabilities);
    if (path === '/experimental/tool/ids') return json(['read', 'write', 'edit', 'bash', 'task']);
    if (path === '/session' && request.method === 'POST') { await createHook?.(); return json(createReply); }
    if (path === '/session/ses_B/prompt_async') { if (promptStatus === 204) response.writeHead(204).end(); else json({ error: 'private native secret' }, promptStatus); return; }
    if (path === '/session/ses_B/abort') return json(true);
    if (/^\/session\/[^/]+$/.test(path) && natives.has(path.split('/')[2]!)) return json(sessionStatus === 200 ? natives.get(path.split('/')[2]!) : { error: 'Session read failed' }, sessionStatus);
    if (path === '/provider') return json({ connected: ['test'], default: {}, all: [{ id: 'test', name: 'Test', models: { model: { id: 'model', name: 'Model', limit: { context: 10000, output: 1000 } } } }] });
    if (path === '/agent') return json(['plan', 'build'].map(name => ({ name, mode: 'primary', permission: [] })));
    if (path === '/session/status') return json({ ses_B: { type: status }, ...statuses });
    if (path === '/session/ses_B/message') return json(messages);
    if (path.startsWith('/session/ses_B/message/')) return json(messages.find(m => m.info.id === path.split('/').at(-1)) ?? {}, messages.some(m => m.info.id === path.split('/').at(-1)) ? 200 : 404);
    if (path === '/permission') return json(permissions);
    if (path === '/question') return json(questions);
    if (path === '/session/ses_B/children') return json([...natives.values()].filter(item => item.parentID === 'ses_B'));
    if (path === '/session/ses_B/todo') return json([]);
    return json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const options = { serverUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, requestTimeoutMs: 1000 };
  const provider = new OpenCodeAgentProvider(options, configured === 'supplier' ? undefined : configured ? verifier : null);
  cleanups.push(() => provider.close());
  const emitRaw = (payload: unknown) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory: cwd, payload })}\n\n`); };
  const emit = (type: string, properties: any, id?: string) => emitRaw({ type, properties, ...(id ? { id } : {}) });
  return { provider, native, requests, messages, cwd, emit, emitRaw, verifier, options, config, capabilities, statuses, permissions, questions,
    addSession(id: string, parentID?: string) { const session = { ...native, id, ...(parentID ? { parentID } : {}) }; natives.set(id, session); return session; },
    create(reply: any, hook?: () => void | Promise<void>) { createReply = reply; createHook = hook; },
    revoke() { current = false; for (const listener of listeners) listener(); },
    renew() { current = true; lease = Object.freeze({}); for (const listener of listeners) listener(); },
    loseProfile() { profile = false; for (const listener of listeners) listener(); },
    prompt(code: number) { promptStatus = code; }, sessionRead(code: number) { sessionStatus = code; }, setStatus(value: string) { status = value; },
    blockReads(path?: string) { let release!: () => void; blockedReadPath = path; readsBlocked = new Promise<void>(r => { release = r; }); return () => { readsBlocked = undefined; blockedReadPath = undefined; release(); }; },
    async open(extensions = {}) { return provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_B', opaque: JSON.stringify({ cwd }) }, extensions); },
    materialize(w: any, change: (message: any) => void = () => {}) { const [providerID, modelID] = w.selections.model.split('/'); const message = { info: { id: w.inputId, sessionID: w.nativeSessionId, role: 'user', time: { created: 10 }, agent: w.selections.agent, model: { providerID, modelID, ...(w.selections.variant !== undefined ? { variant: w.selections.variant } : {}) }, ...(w.selections.system !== undefined ? { system: w.selections.system } : {}) }, parts: [{ id: 'prt_P', sessionID: w.nativeSessionId, messageID: w.inputId, type: 'text', text: w.parts[0].text }] }; change(message); messages.push(message); return message; },
  };
}
const evidence = (owner: any) => owner.nativeEvidence;
async function waitFor(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture condition timed out.'); }

test('default evidence is unavailable while ordinary sessions remain usable', async () => {
  const f = await fixture(false); expect(evidence(f.provider).availability().status).toBe('unavailable');
  await expect(evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd })).rejects.toMatchObject({ code: 'native_evidence_unavailable' });
  expect(f.requests).toHaveLength(0); const session = await f.open();
  await session.sendMessage('ordinary'); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(1);
  expect(evidence(session).availability().status).toBe('unavailable');
});
test('empty creation sends only one create and resumes its verified identity separately', async () => {
  const f = await fixture(); const result = await evidence(f.provider).createEmpty({ sessionId: 'not-native', cwd: f.cwd });
  expect(result).toMatchObject({ status: 'created', handle: { sessionId: 'ses_B' } }); expect(f.requests).toEqual([{ method: 'POST', path: '/session', body: { agent: 'build', model: { providerID: 'test', id: 'model' } } }, { method: 'GET', path: '/session/ses_B', body: {} }]);
  expect(JSON.parse(result.handle.opaque)).toEqual({ version: 2, kind: 'opencode.empty', cwd: f.cwd, authority: { kind: 'trusted-service' as const, authorityId: 'fixture', namespaceId: 'owned-namespace' }, selections: { model: 'test/model', agent: 'build' } });
  await f.provider.resumeSession(result.handle); expect(f.requests.some(r => r.path === '/session/ses_B')).toBe(true);
});
test.each(['directory', 'authority'])('retains usable B after post-create %s failure and recovery cannot attach', async kind => {
  const f = await fixture(); f.create({ ...f.native, directory: kind === 'directory' ? join(f.cwd, 'missing') : f.cwd }, kind === 'authority' ? () => f.revoke() : undefined);
  const result = await evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd }); expect(result).toMatchObject({ status: 'known_rejected', handle: { sessionId: 'ses_B' } });
  expect(JSON.parse(result.handle.opaque)).toMatchObject({ kind: 'opencode.empty-recovery', expectedCwd: f.cwd });
  const before = f.requests.length; await expect(f.provider.resumeSession(result.handle)).rejects.toThrow();
  await expect(f.provider.resumeSession({ ...result.handle, opaque: JSON.stringify({ ...JSON.parse(result.handle.opaque), cwd: f.cwd }) })).rejects.toThrow(); expect(f.requests).toHaveLength(before);
});
test('rejects unsupported empty config before effect and never substitutes unusable native identity', async () => {
  const f = await fixture(); await expect(evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd, model: 'test/model' })).rejects.toBeInstanceOf(AgentOperationRejectedError); expect(f.requests).toHaveLength(0);
  f.create({ ...f.native, id: 'x'.repeat(257) }); expect(await evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd })).toMatchObject({ status: 'unknown', code: 'native_evidence_identity_unusable' }); expect(f.requests).toHaveLength(1);
});
test('prepares exact immutable local text and dispatches its preallocated U once', async () => {
  const f = await fixture(); const session = await f.open({ systemPrompt: '' }); const e = evidence(session); const before = f.requests.length;
  const parts = [{ type: 'text', text: '精确\n"text"' }]; const token = e.captureValidity(); const w = await e.prepareInput(parts, { delivery: 'immediate' }); parts[0]!.text = 'changed';
  expect(f.requests).toHaveLength(before); expect(e.isCurrent(token)).toBe(true); expect(Object.isFrozen(w.parts[0])).toBe(true);
  await expect(e.dispatchInput(w)).resolves.toBeUndefined(); const sends = f.requests.filter(r => r.path.endsWith('prompt_async'));
  expect(sends).toHaveLength(1); expect(sends[0]!.body).toMatchObject({ messageID: w.inputId, parts: [{ type: 'text', text: '精确\n"text"' }], model: { providerID: 'test', modelID: 'model' }, agent: 'build', system: '' });
  await expect(e.dispatchInput(w)).rejects.toBeInstanceOf(AgentOperationRejectedError); expect(e.isCurrent(token)).toBe(false);
});
test('exact materialization is inspectable during unresolved admission and never releases it', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'body' }]); await e.dispatchInput(w);
  const m = f.materialize(w); f.setStatus('busy'); f.emit('message.updated', { info: m.info }); f.emit('session.status', { sessionID: 'ses_B', status: { type: 'busy' } });
  await waitFor(async () => (await session.runtimeInfo()).status === 'running');
  await expect(e.inspectInput(w)).resolves.toMatchObject({ status: 'materialized', proof: { inputId: w.inputId, nativePartIds: ['prt_P'] } });
  await session.cancel(); f.setStatus('idle'); f.emit('session.idle', { sessionID: 'ses_B' }); await new Promise(r => setTimeout(r, 150));
  await expect(session.sendMessage('must stay fenced')).rejects.toBeInstanceOf(AgentOperationRejectedError); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(1);
});
test.each(['missing', 'text', 'owner', 'variant', 'system', 'extra', 'synthetic', 'metadata', 'tools'])('inspection yields unknown for %s readback without resend', async kind => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'body' }]);
  if (kind !== 'missing') f.materialize(w, m => { if (kind === 'text') m.parts[0].text += ' '; if (kind === 'owner') m.parts[0].messageID = 'other'; if (kind === 'variant') m.info.model.variant = 'inherited'; if (kind === 'system') m.info.system = ''; if (kind === 'extra') m.parts.push({ ...m.parts[0] }); if (kind === 'synthetic') m.parts[0].synthetic = true; if (kind === 'metadata') m.parts[0].metadata = { unknown: true }; if (kind === 'tools') m.info.tools = {}; });
  expect((await e.inspectInput(w)).status).toBe('unknown'); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(0);
});
test('post-invocation HTTP failure is unknown and cannot be retried automatically', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'body' }]); f.prompt(400);
  await expect(e.dispatchInput(w)).rejects.toMatchObject({ name: 'AgentNativeEvidenceOutcomeUnknownError', code: 'native_evidence_outcome_unknown' });
  await expect(e.dispatchInput(w)).rejects.toBeInstanceOf(AgentOperationRejectedError); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(1);
});
test('raw duplicate and unsupported events invalidate before queued recovery and cannot be cleared by HTTP alone', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const initial = e.captureValidity();
  const release = f.blockReads(); f.emit('message.part.updated', { part: { id: 'prt_old', sessionID: 'ses_B', messageID: 'old', type: 'text', text: '' } }, 'same');
  await waitFor(() => !e.isCurrent(initial)); expect(() => e.captureValidity()).toThrow(); release(); await new Promise(r => setTimeout(r, 150));
  const renewed = e.captureValidity(); f.emit('message.part.updated', { part: { id: 'prt_old', sessionID: 'ses_B', messageID: 'old', type: 'text', text: '' } }, 'same'); await waitFor(() => !e.isCurrent(renewed));
  f.emit('session.next.prompted', { sessionID: 'ses_B' }); await new Promise(r => setTimeout(r, 200)); expect(() => e.captureValidity()).toThrow();
});
test('narrow harmless session metadata preserves token but unknown metadata and authority loss do not', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  f.emit('session.updated', { info: { ...f.native, title: 'new title', time: { ...f.native.time, updated: 2 } } }); await new Promise(r => setTimeout(r, 20)); expect(e.isCurrent(token)).toBe(true);
  f.emit('session.updated', { info: { ...f.native, metadata: { unknown: true } } }); await waitFor(() => !e.isCurrent(token));
  f.loseProfile(); expect(() => e.captureValidity()).toThrow(); expect(e.isCurrent({ ...token })).toBe(false);
});

test.each(['share', 'summary', 'tokens', 'cache'])('unknown %s metadata cannot hide inside the harmless metadata exception', async field => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  const changed = { ...f.native, ...(field === 'cache' ? { tokens: { cache: { unknown: 1 } } } : { [field]: { unknown: 1 } }) };
  f.emit('session.updated', { info: changed }); await waitFor(() => !e.isCurrent(token));
});
test('a settings read blocks capture and discovers relevant changes without an SSE event', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  const release = f.blockReads(); const before = f.requests.length; const reading = session.runtimeInfo({ refreshSettings: true });
  await waitFor(() => f.requests.length > before); expect(e.isCurrent(token)).toBe(false); expect(() => e.captureValidity()).toThrow();
  f.native.model = { providerID: 'test', id: 'different' }; release(); await reading;
  expect(e.isCurrent(token)).toBe(false); await waitFor(() => { try { e.captureValidity(); return true; } catch { return false; } });
});
test('an unchanged settings read preserves the token after its in-flight fence closes', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  await session.runtimeInfo({ refreshSettings: true }); expect(e.isCurrent(token)).toBe(true);
});
test.each(['session', 'message'])('inspection blocks capture until its unchanged %s read completes', async kind => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session);
  const witness = await e.prepareInput([{ type: 'text', text: 'exact' }]); f.materialize(witness);
  const token = e.captureValidity();
  const path = kind === 'session' ? '/session/ses_B' : `/session/ses_B/message/${witness.inputId}`;
  const release = f.blockReads(path); const before = f.requests.length; const reading = e.inspectInput(witness);
  let result;
  try {
    await waitFor(() => f.requests.slice(before).some(request => request.path === path));
    expect(() => e.captureValidity()).toThrow();
    expect(e.isCurrent(token)).toBe(false);
  } finally { release(); result = await reading; }
  expect(result).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId } });
  expect(e.isCurrent(token)).toBe(true);
  expect(e.isCurrent(e.captureValidity())).toBe(true);
});
test.each(['agent', 'unknown summary'])('inspection retires prior validity when GET discovers changed %s metadata', async kind => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session);
  const witness = await e.prepareInput([{ type: 'text', text: 'exact' }]); f.materialize(witness);
  const token = e.captureValidity();
  if (kind === 'agent') f.native.agent = 'plan'; else f.native.summary = { unclassified: true };
  const before = f.requests.length;
  expect(await e.inspectInput(witness)).toMatchObject({ status: 'unknown', code: 'native_evidence_stale' });
  expect(e.isCurrent(token)).toBe(false);
  expect(f.requests.slice(before).some(request => request.path.startsWith('/session/ses_B/message/'))).toBe(false);
  await waitFor(() => { try { e.captureValidity(); return true; } catch { return false; } });
  expect(e.isCurrent(token)).toBe(false);
});
test('inspection preserves prior validity for only narrowly harmless Session metadata changes', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session);
  const witness = await e.prepareInput([{ type: 'text', text: 'exact' }]); f.materialize(witness);
  const token = e.captureValidity(); f.native.title = 'Changed title'; f.native.time.updated = 2;
  expect((await e.inspectInput(witness)).status).toBe('materialized');
  expect(e.isCurrent(token)).toBe(true);
});
test.each([
  ['request', 'native_evidence_readback_failed'],
  ['missing', 'native_evidence_readback_missing'],
  ['mismatch', 'native_evidence_readback_mismatch'],
  ['store', 'native_evidence_readback_mismatch'],
])('inspection releases read accounting after %s failure', async (kind, code) => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session);
  const witness = await e.prepareInput([{ type: 'text', text: 'exact' }]);
  if (kind !== 'missing') f.materialize(witness, message => { if (kind === 'mismatch') message.parts[0].text = 'different'; });
  if (kind === 'request') f.sessionRead(503);
  const token = e.captureValidity(); const before = f.requests.length;
  const input = kind === 'store' ? { ...witness, authority: { ...witness.authority, namespaceId: 'other' } } : witness;
  const result = await e.inspectInput(input);
  f.sessionRead(200);
  expect(result).toMatchObject({ status: 'unknown', code });
  expect(e.isCurrent(token)).toBe(false);
  if (kind === 'store') expect(f.requests).toHaveLength(before);
  await waitFor(() => { try { e.captureValidity(); return true; } catch { return false; } });
  expect(e.isCurrent(token)).toBe(false);
  expect(e.isCurrent(e.captureValidity())).toBe(true);
});
test('a relevant event received during held inspection prevents positive stale proof', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'exact' }]); f.materialize(w);
  const release = f.blockReads(); const before = f.requests.length; const reading = e.inspectInput(w);
  let result;
  try {
    await waitFor(() => f.requests.length > before); f.emit('session.next.context.updated', { sessionID: 'ses_B' });
    await new Promise(r => setTimeout(r, 20));
  } finally { release(); result = await reading; }
  expect(result).toMatchObject({ status: 'unknown', code: 'native_evidence_stale' });
});
test('authority loss during a held read cannot be refreshed by its successful HTTP response', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'exact' }]); f.materialize(w);
  const release = f.blockReads(); const before = f.requests.length; const reading = e.inspectInput(w);
  let result;
  try { await waitFor(() => f.requests.length > before); f.revoke(); } finally { release(); result = await reading; }
  expect(result).toMatchObject({ status: 'unknown' }); expect(() => e.captureValidity()).toThrow();
});
test('a fresh attachment may inspect a persisted exact witness but never accepts the old validity token', async () => {
  const f = await fixture(); const first = await f.open(); const e = evidence(first); const token = e.captureValidity();
  const w = JSON.parse(JSON.stringify(await e.prepareInput([{ type: 'text', text: 'persistent' }]))); f.materialize(w); await first.dispose();
  const second = await f.open(); expect(evidence(second).isCurrent(token)).toBe(false); expect((await evidence(second).inspectInput(w)).status).toBe('materialized');
});
test.each(['server.instance.disposed', 'global.disposed', 'unknown.profile.changed'])('unscoped %s leaves coverage dirty despite ordinary recovery', async type => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  f.emit(type, {}); await waitFor(() => !e.isCurrent(token)); await session.runtimeInfo({ refreshSettings: true }); expect(() => e.captureValidity()).toThrow();
});
test('preparation rejects unsupported parts/options and unresolved defaults without effects', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const before = f.requests.length;
  for (const parts of [[], [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], [{ type: 'text', text: 'x', id: 'caller' }], [{ type: 'text', text: '\ud800' }]]) await expect(e.prepareInput(parts)).rejects.toBeInstanceOf(AgentOperationRejectedError);
  for (const options of [{ delivery: 'next_turn' }, { delivery: null }, { extra: true }]) await expect(e.prepareInput([{ type: 'text', text: 'x' }], options)).rejects.toBeInstanceOf(AgentOperationRejectedError);
  expect(f.requests).toHaveLength(before);
  delete f.native.model; delete f.native.agent; await session.dispose(); const unresolved = await f.open();
  await expect(evidence(unresolved).prepareInput([{ type: 'text', text: 'x' }])).rejects.toMatchObject({ code: 'native_evidence_unsupported' });
});
test('a changed actual dispatch selection rejects the previously prepared witness before send', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'old setting' }]);
  f.native.agent = 'plan'; await session.runtimeInfo({ refreshSettings: true }); await waitFor(() => { try { e.captureValidity(); return true; } catch { return false; } });
  await expect(e.dispatchInput(w)).rejects.toMatchObject({ code: 'native_evidence_stale' }); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(0);
});

test('escaped recovery envelope capacity is checked before the sole create request', async () => {
  const f = await fixture(); const transport = new OpenCodeTransport(f.options); cleanups.push(() => transport.close());
  const verifier = {
    async refresh() {},
    async targetSelections() { return { model: 'test/model', agent: 'build' }; },
    observeSession() {},
    validateSelections() {},
    relation() { return 'unknown' as const; }, ...f.verifier, captureAuthority(t: OpenCodeTransport, _cwd: string) { return f.verifier.captureAuthority(t, f.cwd); } };
  // An injected canonicalizer isolates encoding arithmetic; this path is never accessed.
  const e = new OpenCodeProviderNativeEvidence(transport, verifier, async () => '/' + '\u0001'.repeat(3000), () => true);
  await expect(e.createEmpty({ sessionId: 'local', cwd: f.cwd })).rejects.toMatchObject({ code: 'native_evidence_limit' }); expect(f.requests).toHaveLength(0);
});

test('unknown ancestry cannot be classified as unrelated merely from its session ID', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  f.emit('message.updated', { info: { id: 'unknown-message', sessionID: 'unclassified-session', role: 'user', time: { created: 1 } } });
  await waitFor(() => !e.isCurrent(token)); await session.runtimeInfo({ refreshSettings: true }); expect(() => e.captureValidity()).toThrow();
});
test('unavailable optional operations do not trigger inspection requests or background recovery', async () => {
  const source = await fixture(); const sourceSession = await source.open(); const w = await evidence(sourceSession).prepareInput([{ type: 'text', text: 'witness' }]);
  const f = await fixture(false); const session = await f.open(); const e = evidence(session); const before = f.requests.length;
  expect((await e.inspectInput(w)).status).toBe('unknown'); await expect(e.dispatchInput(w)).rejects.toMatchObject({ code: 'native_evidence_unavailable' });
  await expect(e.prepareInput([{ type: 'text', text: 'x' }])).rejects.toMatchObject({ code: 'native_evidence_unavailable' }); expect(() => e.captureValidity()).toThrow(); expect(e.isCurrent({})).toBe(false);
  await new Promise(r => setTimeout(r, 150)); expect(f.requests).toHaveLength(before);
  expect(Object.keys(e).sort()).toEqual(['availability', 'captureValidity', 'dispatchInput', 'inspectInput', 'inspectReadiness', 'isCurrent', 'prepareInput']);
});
test('unclassified fields inside a summary diff invalidate the old token', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  f.emit('session.updated', { info: { ...f.native, summary: { additions: 0, deletions: 0, files: 1, diffs: [{ file: 'x', additions: 0, deletions: 0, unclassified: true }] } } });
  await waitFor(() => !e.isCurrent(token));
});

test('actual native sentinel-like variant and explicitly empty system remain exact selections', async () => {
  const f = await fixture(); f.native.model.variant = 'opencode:default'; const session = await f.open({ systemPrompt: '' }); const e = evidence(session);
  const w = await e.prepareInput([{ type: 'text', text: '' }]); expect(w.selections).toEqual({ model: 'test/model', agent: 'build', variant: 'opencode:default', system: '' });
  f.materialize(w); expect((await e.inspectInput(w)).status).toBe('materialized');
});
test('assistant completion or failure and later idle never settle prepared-origin admission', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const w = await e.prepareInput([{ type: 'text', text: 'work' }]); await e.dispatchInput(w);
  const user = f.materialize(w); f.emit('message.updated', { info: user.info });
  const assistant = { id: 'assistant', sessionID: 'ses_B', role: 'assistant', parentID: w.inputId, time: { created: 11, completed: 12 }, finish: 'stop', error: { name: 'MessageAbortedError' }, modelID: 'model', providerID: 'test', agent: 'build', mode: 'build', path: { cwd: f.cwd, root: f.cwd }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
  f.messages.push({ info: assistant, parts: [] }); f.emit('message.updated', { info: assistant }); f.emit('session.idle', { sessionID: 'ses_B' });
  await new Promise(r => setTimeout(r, 150)); await expect(session.sendMessage('second')).rejects.toBeInstanceOf(AgentOperationRejectedError); await expect(session.executeCommand('compact', '')).rejects.toBeInstanceOf(AgentOperationRejectedError);
  expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(1);
});

test('an older native history read invalidates scoped observation and blocks capture until recovery', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session); const token = e.captureValidity();
  const release = f.blockReads(); const before = f.requests.length; const reading = session.readTimelineHistory('older');
  await waitFor(() => f.requests.length > before); expect(e.isCurrent(token)).toBe(false); expect(() => e.captureValidity()).toThrow(); release(); await reading;
  await waitFor(() => { try { e.captureValidity(); return true; } catch { return false; } }); expect(e.isCurrent(token)).toBe(false);
});


test('exact non-summary assistant readback settles only the prepared input that it started', async () => {
  const f = await fixture(); const session = await f.open(); const e = evidence(session);
  const w = await e.prepareInput([{ type: 'text', text: 'prepared task' }]); await e.dispatchInput(w);
  f.materialize(w);
  const assistant = { info: { id: 'msg_R', sessionID: 'ses_B', role: 'assistant', parentID: 'msg_other', summary: false, agent: 'build', mode: 'build', modelID: 'model', providerID: 'test', path: { cwd: f.cwd, root: f.cwd }, time: { created: 20 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] };
  f.messages.push(assistant);
  expect((await e.inspectInput(w)).execution).toBeUndefined();
  await expect(session.sendMessage('blocked')).rejects.toBeInstanceOf(AgentOperationRejectedError);
  assistant.info.parentID = w.inputId; assistant.info.summary = true;
  expect((await e.inspectInput(w)).execution).toBeUndefined();
  assistant.info.summary = false;
  await expect(e.inspectInput(w)).resolves.toMatchObject({ status: 'materialized', execution: { disposition: 'started', nativeExecutionId: 'msg_R' } });
  await session.sendMessage('next ordinary input');
  expect(f.requests.filter(request => request.path.endsWith('prompt_async'))).toHaveLength(2);
});

test('installed supplier creates a fixed empty native session and confirms it without input', async () => {
  const f = await fixture('supplier');
  const result = await f.provider.nativeEvidence.createEmpty({ sessionId: 'arc-local', cwd: f.cwd });
  expect(result.status).toBe('created'); if (result.status !== 'created') return;
  expect(f.requests.filter(r => r.method === 'POST')).toEqual([{ method: 'POST', path: '/session', body: { agent: 'build', model: { providerID: 'test', id: 'model' } } }]);
  expect(f.requests.some(r => r.path === '/session/ses_B')).toBe(true);
  expect(JSON.parse(result.handle.opaque)).toMatchObject({ version: 2, selections: { model: 'test/model', agent: 'build' }, authority: { kind: 'trusted-service', authorityId: 'opencode' } });
  const session = await f.provider.resumeSession(result.handle);
  expect(await session.nativeEvidence!.inspectReadiness()).toMatchObject({ cwd: f.cwd, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
  expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(0);
});
test('installed supplier refuses unknown defaults and uncovered background work before create', async () => {
  for (const missing of ['default_agent', 'model', 'background']) {
    const f = await fixture('supplier');
    if (missing === 'background') f.capabilities.backgroundSubagents = true; else delete f.config[missing];
    await expect(f.provider.nativeEvidence.createEmpty({ sessionId: 'arc-local', cwd: f.cwd })).rejects.toMatchObject({ code: 'native_evidence_unsupported' });
    expect(f.requests.some(r => r.method === 'POST')).toBe(false);
  }
});


test.each([204, 500])('ordinary input %s receipt settles only its exact native response and not idle or user presence', async status => {
  const f = await fixture(); const session = await f.open(); const accepted: unknown[] = [];
  f.prompt(status);
  const send = session.sendMessage('ordinary input', { onAcceptance: value => accepted.push(value) });
  if (status === 204) await expect(send).resolves.toBeUndefined(); else await expect(send).rejects.toThrow();
  const request = f.requests.find(r => r.path.endsWith('prompt_async'))!;
  const user = { info: { id: request.body.messageID, sessionID: 'ses_B', role: 'user', time: { created: 20 }, agent: 'build', model: { providerID: 'test', modelID: 'model' } }, parts: [] };
  f.messages.push(user); f.setStatus('busy'); f.emit('message.updated', { info: user.info });
  f.emit('session.status', { sessionID: 'ses_B', status: { type: 'busy' } });
  await new Promise(r => setTimeout(r, 150)); expect(accepted).toEqual([]);
  const response = { info: { id: 'msg_R', sessionID: 'ses_B', role: 'assistant', parentID: 'other', time: { created: 21 } }, parts: [] };
  f.messages.push(response); f.setStatus('idle'); f.emit('message.updated', { info: response.info }); f.emit('session.idle', { sessionID: 'ses_B' });
  await new Promise(r => setTimeout(r, 150)); expect(accepted).toEqual([]);
  response.info.parentID = user.info.id; Object.assign(response.info, { summary: true });
  f.emit('message.updated', { info: response.info }); await new Promise(r => setTimeout(r, 150)); expect(accepted).toEqual([]);
  Object.assign(response.info, { summary: false }); f.emit('message.updated', { info: response.info });
  await waitFor(() => accepted.length === 1); expect(accepted).toEqual([{ disposition: 'started' }]);
  f.emit('message.updated', { info: response.info }); await new Promise(r => setTimeout(r, 150));
  expect(accepted).toHaveLength(1); expect(f.requests.filter(r => r.path.endsWith('prompt_async'))).toHaveLength(1);
  expect(f.requests.some(r => r.path === `/session/ses_B/message/${user.info.id}`)).toBe(true);
  expect(f.requests.some(r => r.path === '/session/ses_B/message/msg_R')).toBe(true);
});


test('installed supplier inherits exact source selections without guessing absent defaults and tolerates independent B creation', async () => {
  const f = await fixture('supplier'); delete f.config.default_agent; delete f.config.model;
  f.addSession('ses_A');
  f.create(f.native, async () => { f.emit('session.created', { info: f.native }); await new Promise(r => setTimeout(r, 20)); });
  expect(await evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd, selectionSourceSessionId: 'ses_A' })).toMatchObject({ status: 'created' });
  expect(f.requests.filter(r => r.method === 'POST' && r.path === '/session')).toHaveLength(1);
  expect(f.requests.some(r => r.path.endsWith('prompt_async'))).toBe(false);
});
test.each(['valid', 'wrong-version', 'wrong-aggregate'] as const)('installed supplier classifies native sync creation envelope %s', async variant => {
  const f=await fixture('supplier');f.addSession('ses_A');
  f.create(f.native, async()=>{
    f.emit('session.created',{sessionID:'ses_B',info:f.native});
    f.emitRaw({type:'sync',id:'evt_native',syncEvent:{id:'evt_native',type:variant==='wrong-version'?'session.created.2':'session.created.1',seq:0,aggregateID:variant==='wrong-aggregate'?'ses_other':'ses_B',data:{sessionID:'ses_B',info:f.native}}});
    await new Promise(r=>setTimeout(r,20));
  });
  const result=await evidence(f.provider).createEmpty({sessionId:'local',cwd:f.cwd,selectionSourceSessionId:'ses_A'});
  expect(result).toMatchObject({status:variant==='valid'?'created':'known_rejected',handle:{sessionId:'ses_B'}});
  expect(f.requests.filter(r=>r.method==='POST'&&r.path==='/session')).toHaveLength(1);
});
test('native diff updates revoke a fence and allow a fresh authoritative baseline', async () => {
  const f=await fixture('supplier'),session=await f.open(),e=evidence(session),token=e.captureValidity();
  const release=f.blockReads();f.emit('session.diff',{sessionID:'ses_B',diff:[]});
  await waitFor(()=>!e.isCurrent(token));release();
  await waitFor(async()=>{try{return (await e.inspectReadiness()).idle;}catch{return false;}});
  expect(e.isCurrent(e.captureValidity())).toBe(true);
});
test.each(['session.next.model.switched', 'session.next.agent.switched', 'catalog.updated', 'models-dev.refreshed', 'integration.connection.updated', 'reference.updated'])('installed supplier rejects a changed %s lease while retaining the one created B', async type => {
  const f = await fixture('supplier'); f.addSession('ses_A');
  f.create(f.native, async () => { f.emit(type, { sessionID: 'ses_A' }); await new Promise(r => setTimeout(r, 20)); });
  expect(await evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd, selectionSourceSessionId: 'ses_A' })).toMatchObject({ status: 'known_rejected', handle: { sessionId: 'ses_B' } });
  expect(f.requests.filter(r => r.method === 'POST' && r.path === '/session')).toHaveLength(1);
  expect(f.requests.some(r => r.path.endsWith('prompt_async'))).toBe(false);
});
test('installed supplier follows Session parentage rather than message parentID and recovers independent activity', async () => {
  const f = await fixture('supplier'), session = await f.open(); const e = evidence(session);
  f.addSession('ses_foreign');
  f.emit('message.updated', { info: { id: 'msg_foreign', role: 'assistant', sessionID: 'ses_foreign', parentID: 'ses_B', time: { created: 1 } } });
  await waitFor(async () => { try { await e.inspectReadiness(); return true; } catch { return false; } });
  expect(e.isCurrent(e.captureValidity())).toBe(true);
  expect(f.requests.some(r => r.path === '/session/ses_foreign')).toBe(true);
});
test('installed supplier includes active grandchild work and pending interactions in readiness', async () => {
  const f = await fixture('supplier'), session = await f.open(); const e = evidence(session);
  f.addSession('ses_child', 'ses_B'); f.addSession('ses_grandchild', 'ses_child'); f.statuses.ses_grandchild = { type: 'busy' };
  let facts: any; await waitFor(async () => { try { facts = await e.inspectReadiness(); return true; } catch { return false; } });
  expect(facts.activeChildren).toBe(1); expect(facts.idle).toBe(true);
  delete f.statuses.ses_grandchild;
  f.permissions.push({ id: 'permission_grand', sessionID: 'ses_grandchild', permission: 'bash', patterns: [], metadata: {}, always: [] });
  await waitFor(async () => { try { facts = await e.inspectReadiness(); return facts.activeChildren === 1; } catch { return false; } });
  f.permissions.splice(0); await waitFor(async () => { try { facts = await e.inspectReadiness(); return facts.activeChildren === 0; } catch { return false; } });
});


test('a creation handle restores current native selections after later model or agent changes', async () => {
  const f = await fixture();
  const result = await evidence(f.provider).createEmpty({ sessionId: 'local', cwd: f.cwd });
  if (result.status !== 'created') throw new Error('Expected empty creation');
  f.native.agent = 'plan';
  const session = await f.provider.resumeSession(result.handle);
  expect((await session.runtimeInfo()).mode).toBe('plan');
  expect(f.requests.filter(request => request.method === 'POST' && request.path === '/session')).toHaveLength(1);
});
