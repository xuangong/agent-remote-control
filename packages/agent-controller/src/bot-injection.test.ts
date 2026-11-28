import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession, AgentSessionExtensions, AgentSessionToolNamespace, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { TeamBroker } from '@orchardworks/agent-relay-core/testing';
import type { SavedTeam } from '@orchardworks/agent-relay-core/testing';
import { createManagedStdioDirectory } from './stdio-directory.js';

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

async function fixture(options: { tickMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bot-injection-'));
  let teams: SavedTeam[] = [];
  // The account's bots: one per session, in the mode the person chose.
  const bots = new Set<string>(), missions = new Map<string, string>();
  const groups = () => [{ window: { id: 'g', title: 'g', revision: 1, views: [...bots.keys()].map((key, index) => { const [providerId, nativeSessionId] = key.split('/');
    return { id: `v${index}`, placement: 'primary', binding: { hostId: 'relay-host', providerId, nativeSessionId, title: nativeSessionId } }; }) },
    bots: { rank: 'm', members: Object.fromEntries([...bots].map((key, index) => [`v${index}`,
      { botId: 'b_' + index.toString(16).padStart(32, '0'), ...(missions.has(key) ? { mission: missions.get(key) } : {}) }])) } }] as never;
  const broker = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {}, async createSeat() { throw new Error('No seats here.'); },
    resolveSession: (_host, providerId, nativeSessionId) => ({ controllerId: 'host', providerId, nativeSessionId }),
    async change(update) { const next = structuredClone(teams), result = structuredClone(update(next)); teams = next; return result; },
    tasks: { capable: () => true, assertHost() {} }, assistants: { groups, capable: () => true } });
  const created: Array<{ providerId: string; input: Parameters<AgentHostDirectory['create']>[0] }> = [];
  const opened: Array<{ providerId: string; id: string; extensions?: AgentSessionExtensions }> = [];
  const sessions = new Map<string, Native>();
  const directory = (providerId: string): AgentHostDirectory => ({ providerId, list: () => [], workspaces: () => [],
    async create(input) { const id = `${providerId}-${created.length}`; created.push({ providerId, input }); sessions.set(id, new Native(providerId, id, root)); return id; },
    async open(id, options) { opened.push({ providerId, id, ...(options?.extensions ? { extensions: options.extensions } : {}) }); let session = sessions.get(id); if (!session) { session = new Native(providerId, id, root); sessions.set(id, session); } return session; },
    close() {} });
  const adapter = (providerId: string, toolNamespaces: 'creation' | 'attachment' | 'live') => ({ descriptor: { providerId, displayName: providerId, sessionExtensions: { instructions: true, tools: true, toolNamespaces } },
    createSession: async () => { throw new Error('Use the directory.'); }, resumeSession: async () => { throw new Error('Use the directory.'); } });
  const runtime = createAgentHostRuntime({ controllerId: 'host', team: { stateDirectory: join(root, 'team'), tickMs: options.tickMs ?? 10, tasks: () => true, request: call => broker.hostCall('relay-host', call) },
    registrations: [{ directory: directory('codex'), adapter: adapter('codex', 'creation') }, { directory: directory('claude'), adapter: adapter('claude', 'live') },
      { directory: directory('copilot'), adapter: adapter('copilot', 'attachment') }] });
  let agents = 0;
  const control = async (path: string, body: Record<string, unknown>) => {
    const result = await runtime.control({ method: 'POST', path, body: JSON.stringify(body), sessionId: `agent-${++agents}` });
    if (result.status !== 200) throw new Error(result.body);
    return JSON.parse(result.body);
  };
  return { root, runtime, created, opened, sessions, control, bot: (providerId: string, nativeSessionId: string, mission?: string) => { bots.add(`${providerId}/${nativeSessionId}`); if (mission) missions.set(`${providerId}/${nativeSessionId}`, mission); },
    unbot: (providerId: string, nativeSessionId: string) => { bots.delete(`${providerId}/${nativeSessionId}`); },
    async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
const worker = (extensions: AgentSessionExtensions | undefined) => extensions?.toolNamespaces?.find(namespace => namespace.name === 'agent_remote');

const BOT_TOOLS = ['create_bot', 'create_sub_session', 'send_to_sub_session', 'get_sub_session_status', 'read_sub_session', 'stop_sub_session', 'message', 'download_attachment', 'list_bots', 'list_hosts', 'read_bot', 'update_mission', 'remember', 'forget', 'set_chief', 'board', 'update_board', 'write_page', 'read_page', 'set_timer', 'open_room'];
it('declares the bots namespace, deferred, on every Codex thread it creates, so a thread that becomes a bot finds it', async () => {
  const f = await fixture();
  try {
    await f.control('/remote/create', { providerId: 'codex', operationId: randomUUID(), cwd: f.root });
    expect(worker(f.created[0]!.input)).toMatchObject({ deferred: true });
    expect(worker(f.created[0]!.input)!.tools.map(tool => tool.name)).toEqual(BOT_TOOLS);
    // Tools fixed at creation carry the bots' tools, so a thread that becomes a bot later finds them; attachments rebind their executors.
    expect(worker(f.opened.find(entry => entry.id === 'codex-0')?.extensions)).toBeDefined();
  } finally { await f.close(); }
});

it('gives a bot\'s session its standing instructions with its mission when it opens, and a session that is no bot none', async () => {
  const f = await fixture();
  try {
    // The Controller learns the bots at its enablement poll; a runtime already open keeps what it opened with, so each round opens
    // another bot, all registered at once.
    for (let index = 1; index <= 40; index++) f.bot('claude', `claude-bot-${index}`, 'Review every change before release.');
    let round = 0, opened = '';
    await expect.poll(async () => {
      opened = `claude-bot-${++round}`;
      await f.control('/remote/attach', { providerId: 'claude', nativeSessionId: opened });
      return f.opened.find(entry => entry.id === opened)?.extensions?.instructions ?? '';
    }).toContain('Your mission:\nReview every change before release.');
    expect(f.opened.find(entry => entry.id === opened)!.extensions!.instructions).toContain('You are an assistant of Agent Remote Control.');
    await f.control('/remote/attach', { providerId: 'claude', nativeSessionId: 'claude-other' });
    expect(f.opened.find(entry => entry.id === 'claude-other')?.extensions?.instructions).toBeUndefined();
  } finally { await f.close(); }
});

it('reads which sessions are bots before the first session opens after a start, so it opens with its instructions', async () => {
  // The enablement poll never comes round during this test: the first attachment reads enablement itself.
  const f = await fixture({ tickMs: 60_000 });
  try {
    f.bot('claude', 'claude-first', 'Keep the release notes.');
    await f.control('/remote/attach', { providerId: 'claude', nativeSessionId: 'claude-first' });
    expect(f.opened.find(entry => entry.id === 'claude-first')?.extensions?.instructions).toContain('Your mission:\nKeep the release notes.');
  } finally { await f.close(); }
});

it('gives a live Claude session the bots\' tools while it is a bot, and takes them back when it stops being one', async () => {
  const f = await fixture();
  try {
    const names = () => f.sessions.get('claude-main')!.namespaces.at(-1)?.flatMap(namespace => namespace.tools.map(tool => tool.name));
    await f.control('/remote/attach', { providerId: 'claude', nativeSessionId: 'claude-main' });
    expect(worker(f.opened.at(-1)!.extensions)).toBeUndefined();
    f.bot('claude', 'claude-main');
    await expect.poll(names).toContain('create_bot');
    f.unbot('claude', 'claude-main');
    await expect.poll(() => f.sessions.get('claude-main')!.namespaces.at(-1)).toEqual([]);
  } finally { await f.close(); }
});
it('gives a Copilot session the bots\' tools when it is attached as a bot, including a session started elsewhere', async () => {
  const f = await fixture();
  try {
    await f.control('/remote/attach', { providerId: 'copilot', nativeSessionId: 'copilot-0' });
    expect(worker(f.opened.at(-1)!.extensions)).toBeUndefined();
    // Without tool search, the namespace comes undeferred, and only to bots' sessions when they are attached.
    for (let index = 1; index <= 40; index++) f.bot('copilot', `copilot-${index}`);
    let attached = 0;
    await expect.poll(async () => {
      const id = `copilot-${++attached}`;
      await f.control('/remote/attach', { providerId: 'copilot', nativeSessionId: id });
      return worker(f.opened.find(entry => entry.id === id)?.extensions)?.tools.map(tool => tool.name);
    }).toEqual(BOT_TOOLS);
    expect(worker(f.opened.at(-1)!.extensions)).not.toHaveProperty('deferred');
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
