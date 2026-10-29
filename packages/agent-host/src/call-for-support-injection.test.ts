import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession, AgentSessionExtensions, AgentSessionToolNamespace, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';
import { emptyCallForSupportState, executeProfileCommand, setEnablement } from '../../agent-remote-hosted/src/call-for-support-profiles.js';
import { createManagedStdioDirectory } from './stdio-directory.js';
import { reviewProfile } from './test-utils/call-for-support-harness.js';

class Native implements AgentSession {
  capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
  namespaces: Array<readonly AgentSessionToolNamespace[]> = [];
  private stop?: () => void;
  constructor(readonly providerId: string, readonly id: string, readonly cwd: string) {}
  async runtimeInfo() { return { providerId: this.providerId, sessionId: this.id, cwd: this.cwd, status: 'idle' as const, persistence: { providerId: this.providerId, sessionId: this.id, opaque: '{}' } }; }
  async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await new Promise<void>(resolve => { this.stop = resolve; }); }
  async sendMessage() { return { disposition: 'started' as const }; }
  async respondToInteraction() {}
  async updateToolNamespaces(namespaces: readonly AgentSessionToolNamespace[]) { this.namespaces.push(namespaces); }
  async dispose() { this.stop?.(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cfs-injection-'));
  const support = emptyCallForSupportState();
  let teams: SavedTeam[] = [];
  const broker = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {}, async createSeat() { throw new Error('No seats here.'); },
    resolveSession: (_host, providerId, nativeSessionId) => ({ controllerId: 'host', providerId, nativeSessionId }),
    async change(update) { const next = structuredClone(teams), result = structuredClone(update(next)); teams = next; return result; },
    callForSupport: { state: () => support, capable: () => true, assertHost() {}, readOnly: () => true } });
  const created: Array<{ providerId: string; input: Parameters<AgentHostDirectory['create']>[0] }> = [];
  const opened: Array<{ providerId: string; id: string; extensions?: AgentSessionExtensions }> = [];
  const sessions = new Map<string, Native>();
  const directory = (providerId: string): AgentHostDirectory => ({ providerId, list: () => [], workspaces: () => [],
    async create(input) { const id = `${providerId}-${created.length}`; created.push({ providerId, input }); sessions.set(id, new Native(providerId, id, root)); return id; },
    async open(id, options) { opened.push({ providerId, id, ...(options?.extensions ? { extensions: options.extensions } : {}) }); let session = sessions.get(id); if (!session) { session = new Native(providerId, id, root); sessions.set(id, session); } return session; },
    close() {} });
  const adapter = (providerId: string, toolNamespaces: 'creation' | 'live') => ({ descriptor: { providerId, displayName: providerId, sessionExtensions: { instructions: true, tools: true, toolNamespaces } },
    createSession: async () => { throw new Error('Use the directory.'); }, resumeSession: async () => { throw new Error('Use the directory.'); } });
  const runtime = createAgentHostRuntime({ controllerId: 'host', team: { stateDirectory: join(root, 'team'), tickMs: 10, callForSupport: () => true, request: call => broker.hostCall('relay-host', call) },
    registrations: [{ directory: directory('codex'), adapter: adapter('codex', 'creation') }, { directory: directory('claude'), adapter: adapter('claude', 'live') }] });
  const profile = executeProfileCommand(support, { type: 'create', profile: reviewProfile }, 1)!;
  let agents = 0;
  const control = async (path: string, body: Record<string, unknown>) => {
    const result = await runtime.control({ method: 'POST', path, body: JSON.stringify(body), sessionId: `agent-${++agents}` });
    if (result.status !== 200) throw new Error(result.body);
    return JSON.parse(result.body);
  };
  return { root, runtime, support, created, opened, sessions, control,
    enable: (providerId: string, nativeSessionId: string, on: boolean) => setEnablement(support, (_h, p, n) => ({ controllerId: 'host', providerId: p, nativeSessionId: n }), { hostId: 'relay-host', providerId, nativeSessionId }, on ? [profile.id] : [], Date.now()),
    async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
const worker = (extensions: AgentSessionExtensions | undefined) => extensions?.toolNamespaces?.find(namespace => namespace.name === 'agent_remote');

it('declares the worker namespace on every Codex thread it creates, deferred until the session is enabled', async () => {
  const f = await fixture();
  try {
    await f.control('/remote/create', { providerId: 'codex', operationId: randomUUID(), cwd: f.root });
    expect(worker(f.created[0]!.input)).toMatchObject({ deferred: true, tools: [{ name: 'call_for_support' }, { name: 'support_status' }, { name: 'read_support_report' }, { name: 'download_support_resource' }] });
    // Attachments rebind its executors; the thread keeps its declaration.
    expect(worker(f.opened.find(entry => entry.id === 'codex-0')?.extensions)).toBeDefined();
    f.support.profiles[0]!.enableByDefault = true;
    await expect.poll(async () => { await f.control('/remote/create', { providerId: 'codex', operationId: randomUUID(), cwd: f.root }); return worker(f.created.at(-1)!.input)?.deferred; }).toBeUndefined();
  } finally { await f.close(); }
});

it('gives a Claude session the worker namespace only while it is enabled, also while it is open', async () => {
  const f = await fixture();
  try {
    await f.control('/remote/attach', { providerId: 'claude', nativeSessionId: 'claude-worker' });
    expect(worker(f.opened.at(-1)!.extensions)).toBeUndefined();
    f.enable('claude', 'claude-worker', true);
    await expect.poll(() => f.sessions.get('claude-worker')!.namespaces.at(-1)?.map(namespace => namespace.name)).toEqual(['agent_remote']);
    f.enable('claude', 'claude-worker', false);
    await expect.poll(() => f.sessions.get('claude-worker')!.namespaces.at(-1)).toEqual([]);
    expect(f.sessions.get('claude-worker')!.namespaces).toHaveLength(2);
  } finally { await f.close(); }
});

it('keeps access and tool namespaces when it composes stdio extensions', async () => {
  const resumed: AgentSessionExtensions[] = [];
  const namespace: AgentSessionToolNamespace = { name: 'agent_remote', description: 'd', tools: [] };
  const directory = createManagedStdioDirectory('claude', 'Claude', { createSession: async () => { throw new Error('unused'); }, openChildSession: async () => { throw new Error('unused'); },
    resumeSession: async (_handle: unknown, extensions: AgentSessionExtensions = {}) => { resumed.push(extensions); return new Native('claude', 'id', '/'); }, listSessions: async () => [], sessionWorkspace: async () => '/', close: async () => {} } as never, []);
  await directory.open('id', { extensions: { instructions: 'Role.', access: 'read_only', toolNamespaces: [namespace] } });
  expect(resumed[0]).toMatchObject({ instructions: 'Role.', access: 'read_only', toolNamespaces: [namespace] });
});
