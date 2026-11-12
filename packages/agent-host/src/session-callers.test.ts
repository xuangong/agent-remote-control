import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentRuntimeInfo, AgentSession, AgentSessionConfig,
  AgentSessionExtensions, AgentSessionResumeOptions, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import { createAgentHostRuntime, type AgentHostRuntime } from './host.js';
import { createManagedStdioDirectory } from './stdio-directory.js';
import { createCodexSessionDirectory } from './directory.js';
import { handleSessionCall, listenSessionCalls, sessionCallerEndpoint, SessionCallerStore, SESSION_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE } from './session-callers.js';
import { runSessionCommand } from './session-command.js';
import { SessionRefStore } from './session-refs.js';
import { splitSessionReferences } from '@orchardworks/agent-remote-protocol';

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

class FakeSession implements AgentSession {
  readonly capabilities = capabilities;
  private closed = false;
  private wake?: () => void;
  constructor(readonly providerId: string, readonly nativeSessionId: string, readonly cwd?: string) {}
  async *observe(): AsyncIterable<ProviderStreamItem> {
    yield { type: 'history_boundary' };
    while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; });
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return { providerId: this.providerId, sessionId: this.nativeSessionId, status: this.closed ? 'closed' : 'idle', ...(this.cwd ? { cwd: this.cwd } : {}),
      persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } };
  }
  readonly sent: string[] = [];
  async sendMessage(text: string): Promise<void> { this.sent.push(text); }
  async dispose(): Promise<void> { this.closed = true; this.wake?.(); }
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function temporary(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function provider(providerId: string, cwd: string, listed: RemoteSessionSummary[] = [], sessionHostAccess = true) {
  const created: AgentSessionConfig[] = [], resumed: Array<AgentSessionResumeOptions | undefined> = [], histories: Array<[string, AgentHistoryQuery]> = [];
  const sessions = new Map<string, FakeSession>(), titles = new Map<string, string>(), renames: Array<[string, string]> = [];
  const track = (session: FakeSession) => { sessions.set(session.nativeSessionId, session); return session; };
  let next = 0;
  const native = {
    descriptor: { providerId, displayName: providerId, ...(sessionHostAccess ? { sessionHostAccess: true as const } : {}) },
    async createSession(config: AgentSessionConfig) { created.push(config); return track(new FakeSession(providerId, `${providerId}-created-${++next}`, config.cwd ?? cwd)); },
    async resumeSession(handle: AgentPersistenceHandle, _extensions?: AgentSessionExtensions, options?: AgentSessionResumeOptions) {
      resumed.push(options); return track(new FakeSession(providerId, handle.sessionId, cwd));
    },
    async listSessions() { return [...listed, ...[...sessions.keys()].filter(id => id.includes('-created-')).map(id => summary(providerId, id, '2026-11-04T00:00:00.000Z', cwd))]; },
    async renameSession(id: string, title: string) { renames.push([id, title]); titles.set(id, title); return title; },
    async readSessionTitle(id: string) { return titles.get(id); },
    async readSessionHistory(id: string, query: AgentHistoryQuery) {
      histories.push([id, query]);
      return { entries: [{ id: 'entry', turnId: 'turn', role: 'assistant', text: `history of ${id}`, textOffset: 0, totalChars: 11 + id.length }], nextCursor: 'older' };
    },
  };
  const directory = createManagedStdioDirectory(providerId, providerId, native, [{ id: cwd, name: cwd, path: cwd }]);
  return { registration: { adapter: native as AgentProviderAdapter, directory }, created, resumed, histories, sessions, renames };
}

function summary(providerId: string, nativeSessionId: string, updatedAt: string, workspace = '/work'): RemoteSessionSummary {
  return { providerId, nativeSessionId, title: `${nativeSessionId} title`, workspace, createdAt: updatedAt, updatedAt, state: 'idle' };
}

async function host(registrations: ReturnType<typeof provider>[], sessionBin?: string) {
  const state = await temporary('session-callers-');
  const store = new SessionCallerStore(join(state, 'session-callers.json'));
  const endpoint = await sessionCallerEndpoint(state);
  const runtime = createAgentHostRuntime({ registrations: registrations.map(item => item.registration), hostId: async () => 'host-1',
    sessionCallers: { store, endpoint, skills: '/controller/skills/agent-remote', ...(sessionBin ? { sessionBin } : {}) }, sessionRefs: new SessionRefStore(join(state, 'session-refs.json')) });
  cleanup.push(() => runtime.close());
  return { runtime, store, endpoint, state };
}

const create = (runtime: AgentHostRuntime, agentId: string, body: Record<string, unknown>) =>
  runtime.control({ method: 'POST', path: '/remote/create', sessionId: agentId, body: JSON.stringify({ operationId: randomUUID(), ...body }) });
const attach = (runtime: AgentHostRuntime, agentId: string, body: Record<string, unknown>) =>
  runtime.control({ method: 'POST', path: '/remote/attach', sessionId: agentId, body: JSON.stringify(body) });

describe('session credentials', () => {
  it('keeps one credential per session across Controller restarts and identifies only bound credentials', async () => {
    const path = join(await temporary('session-store-'), 'callers.json');
    const store = new SessionCallerStore(path);
    const token = await store.issue({ providerId: 'claude', nativeSessionId: 'one' });
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(await store.issue({ providerId: 'claude', nativeSessionId: 'one' })).toBe(token);
    const pending = store.prepare();
    expect(store.identify(pending.token)).toBeUndefined();
    await pending.bind({ providerId: 'codex', nativeSessionId: 'thread' });
    const restarted = new SessionCallerStore(path);
    await restarted.ready;
    expect(restarted.identify(token)).toEqual({ providerId: 'claude', nativeSessionId: 'one' });
    expect(restarted.identify(pending.token)).toEqual({ providerId: 'codex', nativeSessionId: 'thread' });
    expect(restarted.identify('x'.repeat(43))).toBeUndefined();
    expect(restarted.identify(undefined)).toBeUndefined();
  });

  it('revokes and never again issues a credential for a share recipient\'s session', async () => {
    const path = join(await temporary('session-store-'), 'callers.json');
    const store = new SessionCallerStore(path);
    const token = await store.issue({ providerId: 'claude', nativeSessionId: 'shared' });
    await store.markShared({ providerId: 'claude', nativeSessionId: 'shared' });
    expect(store.identify(token)).toBeUndefined();
    expect(await store.issue({ providerId: 'claude', nativeSessionId: 'shared' })).toBeUndefined();
    const pending = store.prepare();
    await pending.bind({ providerId: 'claude', nativeSessionId: 'shared' });
    expect(store.identify(pending.token)).toBeUndefined();
    const restarted = new SessionCallerStore(path);
    await restarted.ready;
    expect(restarted.isShared({ providerId: 'claude', nativeSessionId: 'shared' })).toBe(true);
    expect(await readFile(path, 'utf8')).not.toContain(token!);
  });
});

describe('Host access for managed sessions', () => {
  it('gives a created session its credential, socket and skills, bound to its native identity', async () => {
    const cwd = await temporary('session-work-');
    const claude = provider('claude', cwd);
    const { runtime, store, endpoint } = await host([claude]);
    expect((await create(runtime, 'agent', { providerId: 'claude' })).status).toBe(200);
    const access = claude.created[0]!.hostAccess!;
    expect(access).toEqual({ environment: { [SESSION_TOKEN_VARIABLE]: expect.any(String), [SESSION_SOCKET_VARIABLE]: endpoint.access },
      unixSockets: [endpoint.access], skills: '/controller/skills/agent-remote' });
    expect(store.identify(access.environment[SESSION_TOKEN_VARIABLE])).toEqual({ providerId: 'claude', nativeSessionId: 'claude-created-1' });
  });

  it('puts the session command directory first on the PATH of its commands', async () => {
    const cwd = await temporary('session-work-');
    const claude = provider('claude', cwd);
    const { runtime } = await host([claude], '/instance/bin');
    expect((await create(runtime, 'agent', { providerId: 'claude' })).status).toBe(200);
    expect(claude.created[0]!.hostAccess!.environment.PATH).toBe(`/instance/bin${delimiter}${process.env.PATH}`);
  });

  it('gives a resumed session the same credential each time', async () => {
    const cwd = await temporary('session-work-');
    const claude = provider('claude', cwd);
    const { runtime, store } = await host([claude]);
    expect((await attach(runtime, 'first', { providerId: 'claude', nativeSessionId: 'existing' })).status).toBe(200);
    const token = claude.resumed[0]?.hostAccess?.environment[SESSION_TOKEN_VARIABLE];
    expect(store.identify(token)).toEqual({ providerId: 'claude', nativeSessionId: 'existing' });
    expect(await store.issue({ providerId: 'claude', nativeSessionId: 'existing' })).toBe(token);
  });

  it('marks a share recipient\'s created and attached sessions, which keep no credential', async () => {
    const cwd = await temporary('session-work-');
    const claude = provider('claude', cwd);
    const { runtime, store } = await host([claude]);
    expect((await create(runtime, 'created', { providerId: 'claude', shared: true })).status).toBe(200);
    expect(store.identify(claude.created[0]!.hostAccess!.environment[SESSION_TOKEN_VARIABLE])).toBeUndefined();
    expect(store.isShared({ providerId: 'claude', nativeSessionId: 'claude-created-1' })).toBe(true);
    expect((await attach(runtime, 'attached', { providerId: 'claude', nativeSessionId: 'recipient', shared: true })).status).toBe(200);
    expect(claude.resumed[0]?.hostAccess).toBeUndefined();
    expect(store.isShared({ providerId: 'claude', nativeSessionId: 'recipient' })).toBe(true);
  });

  it('passes Host access through the Codex directory on creation and resume', async () => {
    const created: AgentSessionConfig[] = [], resumed: Array<AgentSessionResumeOptions | undefined> = [], bound: string[] = [];
    const access = (name: string) => ({ environment: { [SESSION_TOKEN_VARIABLE]: name }, unixSockets: ['/private/tmp/sessions.sock'] });
    const directory = createCodexSessionDirectory({ listSessions: async () => ({ sessions: [] }),
      async createSession(config: AgentSessionConfig) { created.push(config); return new FakeSession('codex', 'thread-new', '/work'); },
      async resumeSession(handle: AgentPersistenceHandle, _extensions?: AgentSessionExtensions, options?: AgentSessionResumeOptions) {
        resumed.push(options); return new FakeSession('codex', handle.sessionId, '/work');
      },
      async openChildSession() { throw new Error('No children.'); } } as never, []);
    cleanup.push(async () => directory.close());
    directory.setSessionHostAccess!({ creation: () => ({ hostAccess: access('created'), bind: async id => { bound.push(id); } }), session: async id => access(id) });
    expect(await directory.create({ cwd: '/work' })).toBe('thread-new');
    expect(created[0]!.hostAccess).toEqual(access('created'));
    expect(bound).toEqual(['thread-new']);
    await directory.open('thread-old');
    expect(resumed).toEqual([{ hostAccess: access('thread-old') }]);
  });

  it('gives nothing to sessions of adapters that do not apply Host access', async () => {
    const cwd = await temporary('session-work-');
    const copilot = provider('copilot', cwd, [], false);
    const { runtime } = await host([copilot]);
    expect((await create(runtime, 'agent', { providerId: 'copilot' })).status).toBe(200);
    expect((await attach(runtime, 'other', { providerId: 'copilot', nativeSessionId: 'existing' })).status).toBe(200);
    expect(copilot.created[0]!.hostAccess).toBeUndefined();
    expect(copilot.resumed[0]?.hostAccess).toBeUndefined();
  });
});

describe('session commands', () => {
  async function commands() {
    const cwd = await temporary('session-work-');
    const claude = provider('claude', cwd, [summary('claude', 'old', '2026-11-01T00:00:00.000Z'), summary('claude', 'hidden', '2026-11-03T00:00:00.000Z')]);
    const codex = provider('codex', cwd, [summary('codex', 'thread', '2026-11-02T00:00:00.000Z')]);
    const context = await host([claude, codex]);
    await context.store.markShared({ providerId: 'claude', nativeSessionId: 'hidden' });
    expect((await attach(context.runtime, 'caller', { providerId: 'claude', nativeSessionId: 'old' })).status).toBe(200);
    const token = claude.resumed[0]!.hostAccess!.environment[SESSION_TOKEN_VARIABLE]!;
    const server = await listenSessionCalls(context.endpoint.listen, input => handleSessionCall(input, context.store, ({ scope: _scope, ...request }, caller) => context.runtime.callSession(request, caller)));
    cleanup.push(() => server.close());
    const run = async (args: string[], env: NodeJS.ProcessEnv = { [SESSION_TOKEN_VARIABLE]: token, [SESSION_SOCKET_VARIABLE]: context.endpoint.access }) => {
      let output = '';
      const code = await runSessionCommand(args, env, text => { output += text; });
      return { code, output: JSON.parse(output) };
    };
    return { ...context, claude, codex, token, run };
  }

  it('renames another session once per operation identity', async () => {
    const { run, codex } = await commands();
    const renamed = await run(['set', 'host-1/codex/thread', '--title', 'Release plan', '--operation-id', 'rename-thread']);
    expect(renamed).toEqual({ code: 0, output: { session: { address: 'host-1/codex/thread', title: 'Release plan' } } });
    expect(await run(['set', 'host-1/codex/thread', '--title', 'Release plan', '--operation-id', 'rename-thread'])).toEqual(renamed);
    expect(codex.renames).toEqual([['thread', 'Release plan']]);
  });

  it('reads its own session and lists the Host\'s sessions newest first, without share recipients\' sessions', async () => {
    const { run, claude } = await commands();
    const self = await run(['read', 'self']);
    expect(self.code).toBe(0);
    expect(self.output.session).toEqual({ address: 'host-1/claude/old', providerId: 'claude', title: 'old title', cwd: expect.any(String), state: 'idle', self: true });
    expect(self.output.entries[0].text).toBe('history of old');
    expect(self.output.nextCursor).toBe('older');
    const listed = await run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.output.sessions.map((session: { address: string }) => session.address)).toEqual(['host-1/codex/thread', 'host-1/claude/old']);
    expect(listed.output.sessions[1]).toMatchObject({ state: 'idle', self: true });
    expect(listed.output.sessions[0]).not.toHaveProperty('self');
    const read = await run(['read', 'host-1/codex/thread', '--limit', '3', '--search', 'plan', '--cursor', 'c1']);
    expect(read.output.session).toMatchObject({ address: 'host-1/codex/thread', title: 'thread title', state: 'idle' });
    expect(claude.histories).toHaveLength(1);
    const hidden = await run(['read', 'host-1/claude/hidden']);
    expect(hidden).toEqual({ code: 1, output: { error: { code: 'session_not_found', message: 'No such session on this Host.' } } });
  });

  it('pages a listing and forwards history queries', async () => {
    const { run, codex } = await commands();
    const first = await run(['list', '--limit', '1']);
    expect(first.output.sessions).toHaveLength(1);
    const second = await run(['list', '--limit', '1', '--cursor', first.output.nextCursor]);
    expect(second.output.sessions[0].address).toBe('host-1/claude/old');
    expect(second.output).not.toHaveProperty('nextCursor');
    expect((await run(['list', '--limit', '2', '--cursor', first.output.nextCursor])).code).toBe(2);
    expect((await run(['list', '--provider', 'codex'])).output.sessions.map((session: { providerId: string }) => session.providerId)).toEqual(['codex']);
    await run(['read', 'local/codex/thread', '--turn', 'turn', '--text-offset', '6000']);
    expect(codex.histories.at(-1)).toEqual(['thread', { turnId: 'turn', textOffset: 6000 }]);
  });

  it('references other sessions of its Host, which reading itself reports and pages also see', async () => {
    const { run, runtime, state } = await commands();
    expect((await run(['ref', 'list'])).output).toEqual({ refs: [], referencedBy: [] });
    const added = await run(['ref', 'add', 'host-1/codex/thread']);
    expect(added.code).toBe(0);
    expect(added.output.refs).toEqual([{ address: 'host-1/codex/thread', providerId: 'codex', title: 'thread title', origin: 'added', addedAt: expect.any(String) }]);
    expect((await run(['ref', 'add', 'local/codex/thread'])).output.refs).toHaveLength(1);
    expect((await run(['read', 'self'])).output.session.refs).toEqual(added.output.refs);
    expect((await run(['read', 'host-1/codex/thread'])).output.session.referencedBy).toEqual([{ address: 'host-1/claude/old', providerId: 'claude', title: 'old title', origin: 'added' }]);
    const listed = (await run(['list'])).output.sessions as Array<{ self?: true; refs?: unknown }>;
    expect(listed.find(session => session.self)?.refs).toEqual(added.output.refs);
    expect(await run(['ref', 'add', 'self'])).toMatchObject({ code: 2, output: { error: { code: 'invalid_request' } } });
    expect(await run(['ref', 'add', 'host-1/claude/hidden'])).toMatchObject({ code: 1, output: { error: { code: 'session_not_found' } } });
    expect(await run(['ref', 'add', 'host-1/codex/missing'])).toMatchObject({ code: 1, output: { error: { code: 'session_not_found' } } });
    expect(await run(['ref', 'add'])).toMatchObject({ code: 2, output: { error: { code: 'invalid_request' } } });
    const page = await runtime.control({ method: 'GET', path: '/remote/session/refs?providerId=claude&nativeSessionId=old' });
    expect(JSON.parse(page.body)).toMatchObject({ revision: 1, refs: [{ providerId: 'codex', nativeSessionId: 'thread', title: 'thread title', origin: 'added', addedAt: expect.any(String) }] });
    const removed = await runtime.control({ method: 'POST', path: '/remote/session/refs', body: JSON.stringify({ providerId: 'claude', nativeSessionId: 'old', action: 'remove', target: { providerId: 'codex', nativeSessionId: 'thread' } }) });
    expect(JSON.parse(removed.body)).toMatchObject({ revision: 2, refs: [] });
    expect((await run(['read', 'self'])).output.session).not.toHaveProperty('refs');
    expect(await new SessionRefStore(join(state, 'session-refs.json')).read({ providerId: 'claude', nativeSessionId: 'old' })).toMatchObject({ revision: 2, refs: [] });
  });

  it('reports why a command cannot be answered', async () => {
    const { run, endpoint } = await commands();
    expect(await run(['read', 'self'], {})).toMatchObject({ code: 1, output: { error: { code: 'no_identity' } } });
    expect(await run(['read', 'self'], { [SESSION_TOKEN_VARIABLE]: 'y'.repeat(43), [SESSION_SOCKET_VARIABLE]: endpoint.access }))
      .toMatchObject({ code: 1, output: { error: { code: 'no_session_identity' } } });
    expect(await run(['read', 'other-host/codex/thread'])).toMatchObject({ code: 1, output: { error: { code: 'host_unreachable' } } });
    expect(await run(['read', 'host-1/codex/missing'])).toMatchObject({ code: 1, output: { error: { code: 'session_not_found' } } });
    expect(await run(['read', 'self', '--search', 'a', '--turn', 'b'])).toMatchObject({ code: 2, output: { error: { code: 'invalid_request' } } });
    expect(await run(['list', '--search', 'a'])).toMatchObject({ code: 2, output: { error: { code: 'invalid_request' } } });
    expect(await run(['read'])).toMatchObject({ code: 2, output: { error: { code: 'invalid_request' } } });
    expect(await run(['read', 'self'], { [SESSION_TOKEN_VARIABLE]: 'z'.repeat(43), [SESSION_SOCKET_VARIABLE]: join(tmpdir(), 'arc-missing.sock') }))
      .toMatchObject({ code: 1, output: { error: { code: 'controller_unreachable' } } });
  });

  it('creates a session opened from another, whose agent hears its source with the first message, and drives it once per operation', async () => {
    const { run, claude, runtime } = await commands();
    const created = await run(['create', '--provider', 'claude', '--from', 'self', '--message', 'Check the plan', '--operation-id', 'new-side']);
    expect(created.code).toBe(0);
    expect(created.output.session).toMatchObject({ address: 'host-1/claude/claude-created-1', refs: [{ address: 'host-1/claude/old', origin: 'source' }] });
    const first = claude.sessions.get('claude-created-1')!;
    expect(splitSessionReferences(first.sent[0]!)).toEqual({ text: 'Check the plan', note: { revision: 1, references: [{ address: 'host-1/claude/old', title: 'old title', origin: 'source' }] } });
    expect((await run(['send', 'host-1/claude/claude-created-1', 'And', 'again', '--operation-id', 'second'])).code).toBe(0);
    expect((await run(['send', 'host-1/claude/claude-created-1', 'And', 'again', '--operation-id', 'second'])).code).toBe(0);
    expect(first.sent).toEqual([expect.any(String), 'And again']);
    expect(await run(['send', 'host-1/claude/claude-created-1', 'Steer', '--steer'])).toMatchObject({ code: 1, output: { error: { code: 'unsupported_command' } } });
    const inspected = await run(['inspect', 'host-1/claude/claude-created-1']);
    expect(inspected.output).toMatchObject({ status: 'idle', pendingInteractions: [] });
    expect(await run(['answer', 'self', 'request', '--response', '{"kind":"tool_approval","decision":"deny"}'])).toMatchObject({ code: 1, output: { error: { code: 'session_forbidden' } } });
    expect(await run(['set', 'self', '--setting', 'approval=never'])).toMatchObject({ code: 1, output: { error: { code: 'session_forbidden' } } });
    // The Host owner reaches the same sessions through the management socket.
    const owner = await runtime.callSession({ command: 'read', target: 'host-1/claude/claude-created-1' }, { kind: 'owner' });
    expect(owner).toMatchObject({ result: { session: { address: 'host-1/claude/claude-created-1' } } });
    expect(await runtime.callSession({ command: 'read', target: 'self' }, { kind: 'owner' })).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('opens a session of this Host in a native CLI and describes another without its history', async () => {
    const { token, endpoint, claude } = await commands();
    const env = { [SESSION_TOKEN_VARIABLE]: token, [SESSION_SOCKET_VARIABLE]: endpoint.access };
    const attached: unknown[] = [];
    const io = { attach: async (...args: unknown[]) => { attached.push(args); return 7; } };
    let output = '';
    expect(await runSessionCommand(['attach', 'host-1/codex/thread', '--take-over'], env, text => { output += text; }, io)).toBe(7);
    // A local address needs no Controller at all.
    expect(await runSessionCommand(['attach', 'local/claude/old'], {}, text => { output += text; }, io)).toBe(7);
    expect(attached).toEqual([['codex', 'thread', true], ['claude', 'old', false]]);
    expect(output).toBe('');
    expect(await runSessionCommand(['attach', 'host-1/codex/missing'], env, text => { output += text; }, io)).toBe(1);
    expect(JSON.parse(output).error.code).toBe('session_not_found');
    output = '';
    expect(await runSessionCommand(['read', 'host-1/codex/thread', '--limit', '0'], env, text => { output += text; })).toBe(0);
    expect(JSON.parse(output)).toEqual({ session: expect.objectContaining({ address: 'host-1/codex/thread', title: 'thread title' }), entries: [] });
    expect(claude.histories).toHaveLength(0);
  });

  it('sends what names another Host there, where the calling session is named by its address', async () => {
    const { runtime } = await commands();
    const forwarded: Array<[string, Record<string, unknown>]> = [];
    const forward = async (hostId: string, request: Record<string, unknown>) => { forwarded.push([hostId, request]); return { result: { forwarded: true } }; };
    const caller = { kind: 'session' as const, ref: { providerId: 'claude', nativeSessionId: 'old' } };
    expect(await runtime.callSession({ command: 'read', target: 'host-2/codex/thread' }, caller, forward)).toEqual({ result: { forwarded: true } });
    expect(await runtime.callSession({ command: 'create', host: 'host-2', providerId: 'codex', from: 'self', refs: ['self', 'host-2/codex/x'], operationId: 'op' }, caller, forward))
      .toEqual({ result: { forwarded: true } });
    expect(forwarded).toEqual([
      ['host-2', { command: 'read', target: 'host-2/codex/thread' }],
      ['host-2', { command: 'create', host: 'host-2', providerId: 'codex', from: 'host-1/claude/old', refs: ['host-1/claude/old', 'host-2/codex/x'], operationId: 'op' }],
    ]);
    const failing = async () => { throw Object.assign(new Error('The command line session ended.'), { code: 'signed_out' }); };
    expect(await runtime.callSession({ command: 'list', host: 'host-2' }, caller, failing)).toEqual({ error: { code: 'signed_out', message: 'The command line session ended.' } });
  });
});
