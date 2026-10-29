import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessageOptions, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { AgentSnapshotPayload, CallForSupportProfileInput, NativeSessionRef, Team, TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { createOperationCache, createOperationExecutor, type AgentManagerEvent, type SessionWireAgent } from '@orchardworks/agent-remote-relay';
import type { AgentUsage } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from '../../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../../agent-remote-hosted/src/team-delivery.js';
import { PortableTeamResourceStore } from '../../../agent-remote-hosted/src/team-resources.js';
import { emptyCallForSupportState, executeProfileCommand, setEnablement } from '../../../agent-remote-hosted/src/call-for-support-profiles.js';
import { TeamRuntime, type TeamRuntimeAccess } from '../team.js';
import type { SessionCreation } from '../role-session-creation.js';

export const reviewProfile: CallForSupportProfileInput = { name: 'Cross review', description: 'Independent reviewers.', coordinator: { model: 'gpt-5.5', reasoningEffort: 'high' },
  enableByDefault: false, mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'within_mandate' } };

/** A Relay Team broker with Call For Support and a Controller Team runtime over fake native sessions. */
export async function supportHarness(options: { callForSupport?: boolean; failCreate?: (creation: SessionCreation) => boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'call-for-support-'))), cache = createOperationCache();
  // The worker works in a git repository with one commit.
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); await writeFile(join(directory, 'a.txt'), 'one\n'); git('add', 'a.txt'); git('commit', '-qm', 'one');
  const commit = git('rev-parse', 'HEAD');
  const ref = (providerId: string, nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId, nativeSessionId });
  const sessions = new Map<string, { payload: AgentSnapshotPayload; deliveries: Array<{ text: string; delivery: AgentMessageOptions['delivery'] }> }>();
  const session = (id: string, providerId = 'codex') => {
    const payload: AgentSnapshotPayload = { id, providerId, status: 'idle', createdAt: '2026-10-29', updatedAt: '2026-10-29', activeTurn: null, pendingInteractions: [],
      capabilities: { history: false, sendMessage: true, steer: true, queueMessage: true, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      runtimeInfo: { providerId, sessionId: id, status: 'idle', cwd: directory, connection: { state: 'connected' } } };
    sessions.set(id, { payload, deliveries: [] });
  };
  session('worker');
  const acquired: string[] = [], released: string[] = [];
  const listeners = new Map<string, Set<(event: AgentManagerEvent) => void>>();
  const agent = (id: string): SessionWireAgent => ({
    agentId: id, snapshot: () => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: structuredClone(sessions.get(id)!.payload) }),
    subscribe: (listener: (event: AgentManagerEvent) => void) => { const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set); return () => { set.delete(listener); }; },
    async fetchTimeline() { return { payload: { entries: [] } } as never; }, async respondToInteraction() {},
    async sendMessage(text: string, messageOptions?: AgentMessageOptions) { sessions.get(id)!.deliveries.push({ text, delivery: messageOptions?.delivery }); return { disposition: 'started' }; },
  } as unknown as SessionWireAgent);
  let teams: SavedTeam[] = [];
  const support = emptyCallForSupportState();
  const resolve = (_host: string, providerId: string, nativeSessionId: string) => ref(providerId, nativeSessionId);
  const rows = new Map<string, Uint8Array>();
  let runtime: TeamRuntime;
  const broker = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {}, resolveSession: resolve,
    async change(update) { const draft = structuredClone(teams), result = structuredClone(update(draft)); teams = draft; return result; },
    async createSeat(_host, seat) { return runtime.create(seat); },
    resources: new PortableTeamResourceStore({ storage: { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); }, async delete(key) { rows.delete(key); },
      async list(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); } } }),
    callForSupport: { state: () => support, capable: () => true, assertHost() {}, readOnly: () => true, supportBundle: (_host, input) => runtime.supportBundle(input),
      supportPatch: (_host, input) => runtime.supportPatch(input) },
  });
  const created: Array<{ id: string; provider: string; creation: SessionCreation; extensions: AgentSessionExtensions }> = [];
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['codex', 'claude', 'copilot'], readOnlyProviders: () => ['codex', 'claude'],
    callForSupport: () => options.callForSupport ?? true, genericSuccession: () => true,
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent: (anchor, target) => { if (anchor.nativeSessionId !== target.nativeSessionId) throw new Error('Wrong recipient'); } },
    async create(provider, creation, extensions) { if (options.failCreate?.(creation)) throw new Error('The native session could not start.'); const id = `native-${created.length}`; created.push({ id, provider, creation, extensions }); session(id, provider); return id; },
    async acquire(_provider, id) { if (!sessions.has(id)) throw new Error('Session is unavailable.'); acquired.push(id); return { agent: agent(id), release() { released.push(id); } }; },
    execute: createOperationExecutor(cache, 'call-for-support-test'),
  };
  const state = await realpath(await mkdtemp(join(tmpdir(), 'call-for-support-state-')));
  runtime = new TeamRuntime(join(state, 'team'), access, call => broker.hostCall('host', call), 1_000_000);
  const profile = (input: CallForSupportProfileInput = reviewProfile) => executeProfileCommand(support, { type: 'create', profile: input }, Date.now())!;
  const enable = (profileIds: string[]) => setEnablement(support, resolve, { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker' }, profileIds, Date.now());
  return {
    directory, commit, git, broker, runtime, sessions, created, acquired, released, ref, profile, enable,
    team: (id: string): Team => structuredClone(teams.find(team => team.id === id)!) as Team,
    host: (call: TeamHostCall) => broker.hostCall('host', call) as Promise<any>,
    call: (input: Record<string, unknown>) => broker.hostCall('host', { action: 'call_for_support', worker: { providerId: 'codex', nativeSessionId: 'worker', title: 'Implement login' },
      task: 'Review the change.', deliverable: 'findings', context: { commit }, ...input } as TeamHostCall) as Promise<any>,
    /** A live usage report from a session, as its provider would stream it. */
    usage(id: string, usage: AgentUsage, turnCompleted = false) {
      const event = turnCompleted ? { type: 'turn_completed' as const, turnId: 'turn', usage } : { type: 'usage_updated' as const, usage };
      for (const listener of listeners.get(id) ?? []) listener({ type: 'agent_stream', agentId: id, event: event as never, delivery: 'live', timestamp: new Date().toISOString() });
    },
    busy(id: string, active: boolean) {
      const payload = sessions.get(id)!.payload;
      payload.status = active ? 'running' : 'idle'; payload.activeTurn = active ? { turnId: 'turn' } : null; payload.runtimeInfo.status = payload.status;
    },
    async close() { await runtime.close(); await cache.close(); for (const path of [directory, state]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}
