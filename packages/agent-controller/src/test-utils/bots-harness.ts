import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessageOptions, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { AgentSnapshotPayload, NativeSessionRef, Team, TeamHostCall, WindowGroup } from '@orchardworks/agent-remote-protocol';
import { createOperationCache, createOperationExecutor, type AgentManagerEvent, type SessionWireAgent } from '@orchardworks/agent-session-runtime';
import { memoryAttachmentStorage, PortableAttachmentStore, TeamBroker } from '@orchardworks/agent-relay-core/testing';
import type { SavedTeam } from '@orchardworks/agent-relay-core/testing';
import { BotTools } from '../bot-tools.js';
import { botFiles } from '../bot-files.js';
import { TeamRuntime, type TeamRuntimeAccess } from '../team.js';
import type { SessionCreation } from '../role-session-creation.js';

/** A Relay Team broker with bots and a Controller Team runtime over fake native sessions. */
export async function botsHarness(options: { groups?: WindowGroup[]; sessions?: string[]; tasks?: boolean; toolNamespaces?: boolean; failCreate?: (creation: SessionCreation) => boolean;
  /** Sees each Relay call from the Controller, which forward completes. */
  intercept?: (call: TeamHostCall, forward: (call: TeamHostCall) => Promise<unknown>) => Promise<unknown> } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bots-'))), cache = createOperationCache();
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
  for (const id of options.sessions ?? []) session(id);
  const acquired: string[] = [], released: string[] = [], cancelled: string[] = [];
  const listeners = new Map<string, Set<(event: AgentManagerEvent) => void>>();
  const agent = (id: string): SessionWireAgent => ({
    agentId: id, snapshot: () => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: structuredClone(sessions.get(id)!.payload) }),
    subscribe: (listener: (event: AgentManagerEvent) => void) => { const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set); return () => { set.delete(listener); }; },
    async fetchTimeline() { return { payload: { entries: [] } } as never; }, async respondToInteraction() {},
    async cancel() { cancelled.push(id); },
    async sendMessage(text: string, messageOptions?: AgentMessageOptions) { sessions.get(id)!.deliveries.push({ text, delivery: messageOptions?.delivery }); return { disposition: 'started' }; },
  } as unknown as SessionWireAgent);
  let teams: SavedTeam[] = [];
  const groups: WindowGroup[] = options.groups ?? [{ window: { id: 'g0', title: 'g0', revision: 1, views: [{ id: 'chief', placement: 'primary',
    binding: { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker', title: 'worker' } }] }, bots: { rank: 'm', members: { chief: { botId: 'b_' + 'c'.repeat(32), name: 'Chief' } } } }] as unknown as WindowGroup[];
  const resolve = (_host: string, providerId: string, nativeSessionId: string) => ref(providerId, nativeSessionId);
  let runtime: TeamRuntime;
  const broker = new TeamBroker({ attachments: new PortableAttachmentStore(memoryAttachmentStorage()), read: () => teams, now: Date.now, assertHost() {}, resolveSession: resolve,
    async change(update) { const draft = structuredClone(teams), result = structuredClone(update(draft)); teams = draft; return result; },
    async createSeat(_host, seat) { return runtime.create(seat); },
    tasks: { capable: () => options.tasks === true, assertHost() { if (options.tasks !== true) throw new Error('Update the Controller to use tasks.'); } },
    // The account's bots: by default one, Chief, whose main session is `worker`, so its tasks have a bot as chief.
    assistants: { groups: () => groups, capable: () => options.tasks === true,
      placeBot: async (groupId, view, details) => {
        const target = groups.find(item => item.window.id === groupId)!;
        (target.window.views as unknown[]).push({ id: view.id, placement: 'primary', binding: view.binding }); target.bots!.members[view.id] = details;
      } },
  });
  const created: Array<{ id: string; provider: string; creation: SessionCreation; extensions: AgentSessionExtensions }> = [];
  // Every bot's tools, as a Host gives them to a temporary bot (a task's worker).
  const bots = new BotTools({ request: call => broker.hostCall('host', call), tasks: () => options.tasks === true,
    title: async () => 'Chief', files: botFiles(async () => directory, join(directory, '.downloads')), readOnly: providerId => ['codex', 'claude'].includes(providerId), patch: ref => runtime.patchFor(ref) });
  const access: TeamRuntimeAccess = {
    botTools: (actual, kind) => bots.namespace(actual, false, kind),
    controllerId: 'controller', available: () => true, supportedProviders: () => ['codex', 'claude', 'copilot'], readOnlyProviders: () => ['codex', 'claude'],
    tasks: () => options.tasks === true, toolNamespaces: () => options.toolNamespaces === true, genericSuccession: () => true,
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent: (anchor, target) => { if (anchor.nativeSessionId !== target.nativeSessionId) throw new Error('Wrong recipient'); } },
    async create(provider, creation, extensions) { if (options.failCreate?.(creation)) throw new Error('The native session could not start.'); const id = `native-${created.length}`; created.push({ id, provider, creation, extensions }); session(id, provider); return id; },
    async acquire(_provider, id) { if (!sessions.has(id)) throw new Error('Session is unavailable.'); acquired.push(id); return { agent: agent(id), release() { released.push(id); } }; },
    execute: createOperationExecutor(cache, 'bots-test'),
  };
  const state = await realpath(await mkdtemp(join(tmpdir(), 'bots-state-')));
  const forward = (call: TeamHostCall) => broker.hostCall('host', call);
  runtime = new TeamRuntime(join(state, 'team'), access, call => options.intercept ? options.intercept(call, forward) : forward(call), 1_000_000);
  return {
    directory, commit, git, broker, runtime, sessions, created, acquired, released, cancelled, ref,
    team: (id: string): Team => structuredClone(teams.find(team => team.id === id)!) as Team,
    teams: (): Team[] => structuredClone(teams) as Team[],
    host: (call: TeamHostCall) => broker.hostCall('host', call) as Promise<any>,
    /** A pending native interaction in a session, or none. */
    interaction(id: string, summary?: string) {
      sessions.get(id)!.payload.pendingInteractions = summary ? [{ kind: 'tool_approval', requestId: 'r', toolCallId: 'c', toolName: 'shell', summary, detail: { type: 'shell', command: 'npm test' }, allowedDecisions: ['allow', 'deny'] } as never] : [];
    },
    /** Input someone typed into a session, as its provider streams it. */
    userMessage(id: string, text: string, messageId: string) {
      for (const listener of listeners.get(id) ?? []) listener({ type: 'agent_stream', agentId: id, event: { type: 'timeline', item: { type: 'user_message', text, messageId } } as never, delivery: 'live', timestamp: new Date().toISOString() });
    },
    busy(id: string, active: boolean) {
      const payload = sessions.get(id)!.payload;
      payload.status = active ? 'running' : 'idle'; payload.activeTurn = active ? { turnId: 'turn' } : null; payload.runtimeInfo.status = payload.status;
    },
    async close() { await runtime.close(); await cache.close(); for (const path of [directory, state]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}
