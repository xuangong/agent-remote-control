import { realpath } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { AgentCapabilities, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { createHostExecutionPolicy, protectHostDirectory } from './execution-policy.js';

const capabilities: AgentCapabilities = { sessionControl: 'shared', history: true, sendMessage: true, steer: false,
  cancel: true, readResource: false, interactions: { question: true, planApproval: false, toolApproval: true } };
function fixture(cwd = '/work') {
  const summaries = new Map([['native', { id: 'native', title: 'Native title', cwd, updatedAt: '2026-09-25T00:00:00.000Z' }]]);
  let closes = 0; let resumes = 0; let renames = 0; let aborts = 0; let config: AgentSessionConfig | undefined;
  const sessions: AgentSession[] = [];
  const session = (id: string): AgentSession => {
    let disposed = false;
    const value: AgentSession = { capabilities, async *observe() { yield { type: 'history_boundary' }; },
      async runtimeInfo() { return { providerId: 'opencode', sessionId: id, cwd, status: disposed ? 'closed' : 'idle',
        persistence: { providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd }) } }; },
      async sendMessage() {}, async respondToInteraction() {}, async cancel() { aborts++; }, async dispose() { disposed = true; } };
    sessions.push(value); return value;
  };
  const provider = {
    async listSessions() { return []; }, async getSession(id: string) { return summaries.get(id); },
    async createSession(input: AgentSessionConfig) { config = input; return session('created'); },
    async resumeSession(handle: { sessionId: string }, overrides?: unknown) { expect(overrides).toBeUndefined(); resumes++; return session(handle.sessionId); },
    async renameSession(id: string, title: string) { renames++; summaries.get(id)!.title = title; },
    async close() { closes++; },
  };
  return { provider, summaries, sessions, counts: () => ({ closes, resumes, renames, aborts }), config: () => config };
}

it('creates and reuses shared sessions without ownership leases, and closes without aborting', async () => {
  const f = fixture(); const directory = createOpenCodeSessionDirectory(f.provider, [{ id: 'work', name: 'Work', path: '/work' }]);
  const id = await directory.create({ workspaceId: 'work', model: 'provider/model' });
  expect(id).toBe('created'); expect(f.config()).toMatchObject({ cwd: '/work', model: 'provider/model' });
  const session = await directory.open(id);
  expect(session.capabilities.sessionControl).toBe('shared'); expect(directory.setSessionHandoffHandler).toBeUndefined();
  expect(await directory.list()).toContainEqual(expect.objectContaining({ nativeSessionId: id, providerId: 'opencode', workspace: '/work', state: 'idle' }));
  await directory.close(); await directory.close();
  expect(f.counts()).toEqual({ closes: 1, resumes: 0, renames: 0, aborts: 0 });
  expect((await session.runtimeInfo()).status).toBe('closed');
  await expect(directory.open(id)).rejects.toThrow(/closed/i);
}, 10000);

it('validates native workspace by ID even when the native catalog omits the session', async () => {
  const cwd = await realpath(process.cwd()); const f = fixture(cwd);
  const directory = protectHostDirectory(createOpenCodeSessionDirectory(f.provider, []), (await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: cwd }))!);
  try {
    expect((await (await directory.open('native')).runtimeInfo()).cwd).toBe(cwd);
    f.summaries.set('outside', { id: 'outside', title: 'Outside', cwd: '/', updatedAt: new Date().toISOString() });
    await expect(directory.open('outside')).rejects.toThrow(/workspace/i);
    await expect(directory.open('missing')).rejects.toThrow(/workspace/i);
    expect(f.counts().resumes).toBe(1);
  } finally { await directory.close(); }
}, 10000);

it('renames native titles idempotently and rejects unsupported directory operations', async () => {
  const f = fixture(); const directory = createOpenCodeSessionDirectory(f.provider, []);
  try {
    expect(await directory.sessionTitle!('native')).toBe('Native title');
    expect(await directory.renameSession!('native', 'Updated')).toBe('Updated');
    expect(await directory.renameSession!('native', 'Updated')).toBe('Updated');
    expect(f.counts().renames).toBe(1);
    await expect(directory.create({ workspaceId: 'missing' })).rejects.toThrow(/workspace/i);
    await expect(directory.create({ sourceNativeSessionId: 'native' })).rejects.toThrow(/source/i);
    await expect(directory.create({ editNativeSessionId: 'native' })).rejects.toThrow(/edit/i);
    await expect(directory.open('native', { takeOver: 'owner' })).rejects.toThrow(/shared|takeover/i);
  } finally { await directory.close(); }
}, 10000);

it('disposes initialization that completes after directory shutdown', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const create = f.provider.createSession; f.provider.createSession = async input => { await gate; return create(input); };
  const directory = createOpenCodeSessionDirectory(f.provider, []); const pending = directory.create({});
  await directory.close(); release(); await expect(pending).rejects.toThrow(/closed/i);
  expect((await f.sessions[0]!.runtimeInfo()).status).toBe('closed'); expect(f.counts().aborts).toBe(0);
}, 10000);
