import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { expect, test } from 'vitest';
import type { AgentSession, AgentSessionExtensions, AgentMessageOptions, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, type AgentHostDirectory, type AgentHostRuntime } from './host.js';
import { createCodexSessionDirectory } from './directory.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { TpmStore } from './tpm-store.js';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';

for (const providerId of ['codex', 'opencode'] as const) test.each(['leader', 'member', 'tpm'] as const)(`${providerId} first prefix attachment restores %s tools with exact recipient and release fencing`, async role => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-prefix-role-'))), teamDirectory = join(root, 'team'), tpmDirectory = join(root, 'tpm');
  const bound = new Map<string, AgentSessionExtensions>(); let forks = 0, allowPoll = false, polls = 0;
  const deliveries: string[] = []; let acceptance: AgentMessageOptions['onAcceptance'];
  let releaseClaim: (() => void) | undefined, claimEntered = false;
  const seat = { teamId: 'team', source: { hostId: 'relay-host', providerId, nativeSessionId: 'source', title: 'Source' }, member: { id: 'member', hostId: 'relay-host', providerId, nativeSessionId: 'A', role: role === 'member' ? 'member' : 'leader', name: 'Role', responsibility: 'Verify', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 } };
  if (role === 'tpm') {
    const store = new TpmStore(tpmDirectory); await store.ready;
    await store.insert({ version: 1, createKey: 'key', createFingerprint: 'hash', creation: 'accepted', requirement: 'Verify', dirty: false, lastReviewAt: 0, actions: {}, work: { id: 'work', revision: 1, title: 'Work', providerId, mainNativeSessionId: 'source', tpmNativeSessionId: 'A', phase: 'clarifying', waiting: 'user', paused: true, delegated: true, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', nextCheckAt: 0, outbox: [] } });
  } else { await mkdir(teamDirectory); await writeFile(join(teamDirectory, 'seats.json'), JSON.stringify([{ seat, creation: 'ready', receipts: {} }])); }
  class Native implements AgentSession {
    capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
    private stop?: () => void;
    constructor(readonly id: string) {}
    promptEditEvidence = { version: 1 as const, inspectReadiness: async () => ({ cwd: root, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }), captureValidity: () => ({}) as never, isCurrent: () => true };
    async runtimeInfo() { return { providerId, sessionId: this.id, cwd: root, status: 'idle', persistence: { providerId, sessionId: this.id, opaque: 'original' } }; }
    async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await new Promise<void>(resolve => { this.stop = resolve; }); }
    async sendMessage(_text: string, options?: AgentMessageOptions) { deliveries.push(this.id); acceptance = options?.onAcceptance; return { disposition: this.id === 'A' ? 'queued' as const : 'started' as const }; } async respondToInteraction() {} async dispose() { this.stop?.(); }
  }
  const provider = { createdSessionIdMaxLength: 36, validatePromptEdit: async () => {}, verifyPromptEditBranch: async () => {}, forkForPromptEdit: async (_target: unknown, extensions: AgentSessionExtensions = {}) => { forks++; bound.set('B', extensions); return new Native('B'); }, createSession: async () => new Native('unused'), openChildSession: async () => new Native('unused'), resumeSession: async (handle: { sessionId: string }, extensions: AgentSessionExtensions = {}) => { bound.set(handle.sessionId, extensions); return new Native(handle.sessionId); }, readSessionWorkspace: async () => root, readSessionHistory: async () => ({ entries: [] }), getSession: async (id: string) => ({ id, cwd: root, title: id }), renameSession: async () => {}, close: async () => {} };
  const handoffs = new WeakMap<AgentHostRuntime, Parameters<NonNullable<AgentHostDirectory['setSessionHandoffHandler']>>[0]>();
  let now = 1_000_000;
  const make = () => {
    const directory = providerId === 'codex' ? createCodexSessionDirectory({ ...provider, listSessions: async () => ({ sessions: [] }) }, []) : createOpenCodeSessionDirectory({ ...provider, listSessions: async () => [] }, [], undefined, true);
    let handoff: Parameters<NonNullable<AgentHostDirectory['setSessionHandoffHandler']>>[0] | undefined;
    // Model the native ownership callback; no installed provider or real CLI is invoked.
    directory.setSessionHandoffHandler = handler => { handoff = handler; };
    const runtime = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: root, enrollment: true },
      ...(role === 'tpm' ? { tpm: { stateDirectory: tpmDirectory, tickMs: 20, now: () => now, heartbeatMs: 1000, minimumReviewMs: 0 } }
        : { team: { stateDirectory: teamDirectory, tickMs: 20, request: async call => { const result = await post('/team', call); if (result.status !== 200) throw new Error(JSON.stringify(result.data)); return result.data; } } }),
      registrations: [{ directory, adapter: { descriptor: { providerId, displayName: providerId, sessionExtensions: { instructions: true, tools: true } }, createSession: provider.createSession, resumeSession: provider.resumeSession, readSessionHistory: provider.readSessionHistory } }] });
    handoffs.set(runtime, handoff!); return runtime;
  };
  let host = make();
  const peer = { ...seat.member, id: 'peer', role: role === 'member' ? 'leader' as const : 'member' as const, nativeSessionId: 'peer' };
  let teams = [{ id: 'team', operationId: 'create', revision: 1, source: seat.source, title: 'Team', status: 'active', members: role === 'member' ? [peer, seat.member] : [seat.member, peer], messages: [], createdAt: 1, updatedAt: 1 }] as SavedTeam[];
  const mailbox = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {}, async createSeat() { throw new Error('Seats are already created'); },
    resolveSession: (_host, providerId, nativeSessionId) => host.executionRouting!.resolve({ controllerId: 'host', providerId, nativeSessionId }).target,
    async change(update) { const next = structuredClone(teams), result = structuredClone(update(next)); teams = next; return result; },
  });
  const server = createServer((req, res) => { void (async () => { let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/team') {
      const call = JSON.parse(body); if (call.action === 'poll') { polls++; if (!allowPoll) { res.end('[]'); return; } }
      const result = await mailbox.hostCall('relay-host', call);
      if (call.action === 'claim' && call.expectedNativeSessionId === 'A') { claimEntered = true; await new Promise<void>(resolve => { releaseClaim = resolve; }); }
      res.end(JSON.stringify(result)); return;
    }
    const result = req.url === '/enroll' ? await host.enrollFromRelay({ method: 'POST', path: '/remote/succession/enrollment', body }, context) : await host.control({ method: req.method === 'GET' ? 'GET' : 'POST', path: req.url!, body, sessionId: req.headers['x-agent'] as string | undefined }); res.statusCode = result.status; res.end(result.body);
  })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, authority = { version: 1 as const, origin, issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' }, context = { authority, installationId: 'host', successionEnrollmentVersion: 3 as const };
  const post = async (path: string, body: unknown, agent?: string) => { const response = await fetch(origin + path, { method: 'POST', body: JSON.stringify(body), headers: agent ? { 'x-agent': agent } : {}, signal: AbortSignal.timeout(3000) }); return { status: response.status, data: await response.json() }; };
  const tool = () => bound.get('B')!.tools!.find(tool => tool.name === (role === 'tpm' ? 'read_work' : 'read_team'))!;
  const readWork = async () => { const response = await fetch(origin + '/remote/tpm/work?id=work', { signal: AbortSignal.timeout(3000) }); expect(response.status).toBe(200); return response.json(); };
  const exerciseTpmTakeover = async (afterRestart: boolean) => {
    const before = await readWork();
    expect(before).toMatchObject({ paused: true, tpmNativeSessionId: 'B', mainNativeSessionId: 'source' });
    const sentBefore = deliveries.length;
    expect((await post('/remote/tpm/action', { id: 'work', revision: before.revision, operationId: `resume-${afterRestart}`, action: 'resume' })).status).toBe(200);
    await expect.poll(async () => { const work = await readWork(); return { count: work.outbox?.length, last: work.outbox?.at(-1) }; }).toMatchObject({ count: before.outbox.length + 1, last: { status: 'accepted', resolvedTarget: { controllerId: 'host', providerId, nativeSessionId: 'B' } } });
    expect(deliveries.length).toBe(sentBefore + 1); expect(deliveries.at(-1)).toBe('B');
    const receipts = (await readWork()).outbox;
    const callback = handoffs.get(host)!;
    const owner = { kind: 'native_cli' as const, generation: '00000000-0000-4000-8000-000000000099' };
    if (afterRestart) {
      await callback('A', owner);
      expect((await readWork()).paused).toBe(false);
    }
    const attached = await post('/remote/attach', { providerId, nativeSessionId: 'B' }, 'current-B');
    expect(attached.status).toBe(200);
    const wire = createAgentRemoteHttpServer(host.relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'owner' }), authorize: () => true } });
    const address = await wire.listen(0);
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(address.url.replace('http:', 'ws:') + `/v1/sessions/${attached.data.agentId}/events`);
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    try {
      await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      await expect.poll(() => messages.find(message => message.type === 'agent_snapshot')).toMatchObject({ payload: { runtimeInfo: { sessionId: 'B' } } });
      await expect.poll(() => messages.find(message => message.type === 'session_control')).toBeDefined();
      const control = messages.find(message => message.type === 'session_control');
      if (control?.type !== 'session_control') throw new Error('Missing control state');
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId: attached.data.agentId, requestId: 'take-control', action: 'take_over', revision: control.payload.revision } }));
      await expect.poll(() => messages.findLast(message => message.type === 'session_control')).toMatchObject({ payload: { requestId: 'take-control', access: 'control' } });
      await callback('B', owner);
      expect(await readWork()).toMatchObject({ paused: true, tpmNativeSessionId: 'B', mainNativeSessionId: 'source', outbox: receipts });
      await expect.poll(() => messages.findLast(message => message.type === 'session_control')).toMatchObject({ payload: { access: 'read_only', nativeOwner: owner } });
      const saved = new TpmStore(tpmDirectory); await saved.ready;
      expect(saved.get('work').work).toMatchObject({ paused: true, tpmNativeSessionId: 'A', mainNativeSessionId: 'source', outbox: receipts });
      now += 60_000;
    } finally { socket.terminate(); await wire.close(); }
  };
  try {
    expect((await post('/remote/attach', { providerId, nativeSessionId: 'A' }, 'A')).status).toBe(200);
    const old = bound.get('A')!.tools!.find(tool => tool.name === (role === 'tpm' ? 'read_work' : 'read_team'))!;
    const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' }, described = await post('/enroll', { action: 'describe', providerId, nativeSessionId: 'A', preparation });
    expect(described.status).toBe(200);
    const from = { controllerId: 'host', providerId, nativeSessionId: 'A' }, freeze = { version: 3 as const, token: 'freeze', authority, controllerId: 'host', maxProjectionBytes: 2 * 1024 * 1024, associationRevision: 0, lineage: [from], relations: [], request: { roleId: described.data.role.id, operationId: 'prefix', expectedRevision: 1, from, preparation } };
    if (role !== 'tpm') {
      allowPoll = true;
      await post('/team', { action: 'send', teamId: 'team', memberId: 'peer', to: 'member', operationId: 'claim-first', text: 'Isolated A input' });
      await expect.poll(() => claimEntered).toBe(true);
      const blocked = { ...freeze, token: 'blocked', request: { ...freeze.request, operationId: 'blocked' } };
      expect(await post('/enroll', { action: 'prepare', freeze: blocked })).toMatchObject({ status: 200, data: { record: { phase: 'rejected' } } });
      expect(forks).toBe(0); expect(deliveries).toEqual([]);
      expect((await post('/enroll', { action: 'release', freeze: blocked })).status).toBe(200);
      releaseClaim!();
      await expect.poll(() => teams[0]!.messages[0]?.acceptance).toBe('queued');
      expect(deliveries).toEqual(['A']);
      const queued = { ...blocked, token: 'queued', request: { ...blocked.request, operationId: 'queued' } };
      expect(await post('/enroll', { action: 'prepare', freeze: queued })).toMatchObject({ status: 200, data: { record: { phase: 'rejected' } } });
      expect((await post('/enroll', { action: 'release', freeze: queued })).status).toBe(200);
      acceptance!({ disposition: 'started' });
      await expect.poll(() => teams[0]!.messages.length).toBe(0);
      allowPoll = false;
    }
    expect(await post('/enroll', { action: 'prepare', freeze })).toMatchObject({ status: 200, data: { record: { phase: 'ready' } } });
    const first = tool(); await expect(first.execute({})).rejects.toThrow(/current|reserved|admission/);
    const restoredCandidate = make();
    try {
      const attached = await restoredCandidate.control({ method: 'POST', path: '/remote/attach', sessionId: 'candidate', body: JSON.stringify({ providerId, nativeSessionId: 'B' }) });
      expect(attached.status).toBe(200);
      await expect(tool().execute({})).rejects.toThrow(/current|reserved|admission/);
    } finally { await restoredCandidate.close(); }
    if (role !== 'tpm') {
      await post('/team', { action: 'send', teamId: 'team', memberId: 'peer', to: 'member', operationId: 'freeze-first', text: 'Isolated B input' });
      allowPoll = true; const before = polls;
      await expect.poll(() => polls).toBeGreaterThan(before + 1);
      expect(teams[0]!.messages[0]?.status).toBe('queued'); expect(deliveries).toEqual(['A']);
    }
    expect(await post('/enroll', { action: 'commit', freeze })).toMatchObject({ status: 200, data: { record: { phase: 'committed' } } });
    await expect(old.execute({})).rejects.toThrow(/current/); await expect(first.execute({})).rejects.toThrow(/reserved|admission/);
    if (role !== 'tpm') { const before = polls; await expect.poll(() => polls).toBeGreaterThan(before + 1); expect(teams[0]!.messages[0]?.status).toBe('queued'); expect(deliveries).toEqual(['A']); }
    expect((await post('/enroll', { action: 'release', freeze })).status).toBe(200);
    if (role !== 'tpm') { await expect.poll(() => teams[0]!.messages.length).toBe(0); expect(deliveries).toEqual(['A', 'B']); allowPoll = false; }
    expect(JSON.parse(await first.execute({}))).toMatchObject(role === 'tpm' ? { id: 'work', tpmNativeSessionId: 'B' } : { id: 'team' });
    if (role === 'tpm') await exerciseTpmTakeover(false);
    await host.close(); host = make(); expect((await post('/remote/attach', { providerId, nativeSessionId: 'B' }, 'B')).status).toBe(200);
    expect(JSON.parse(await tool().execute({}))).toMatchObject(role === 'tpm' ? { id: 'work', tpmNativeSessionId: 'B' } : { id: 'team' });
    if (role === 'tpm') await exerciseTpmTakeover(true);
    expect(forks).toBe(1);
    if (role === 'tpm') { const store = new TpmStore(tpmDirectory); await store.ready; expect(store.get('work').work.tpmNativeSessionId).toBe('A'); }
    else expect(JSON.parse(await readFile(join(teamDirectory, 'seats.json'), 'utf8'))[0].seat).toEqual(seat);
  } finally { releaseClaim?.(); allowPoll = false; await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 10000);
