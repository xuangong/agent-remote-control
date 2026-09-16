import { expect, it, vi } from 'vitest';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { LiveDshProvider } from '@agent-remote-controller/agent-provider-dsh';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createDshSessionDirectory, type DshDirectoryContext } from './session-directory.js';

function fixture() {
  const header = { id: SessionId('cold-session'), origin: 'user', cwd: '/tmp/workspace', createdAt: 1000 } as SessionHeader;
  const agent = { session: { id: header.id, header, snapshotEvents: () => [] }, status: 'idle' } as unknown as Agent;
  const nativeSessions = new Map<string, Agent>([['cold-session', agent]]);
  const created: string[] = [];
  const context = {
    agents: { roots: () => [] },
    sessionQuery: { listSessions: async () => [...nativeSessions.values()].map((agent) => ({ header: agent.session.header })) },
    workspaceRegistry: { list: () => [{ id: 'workspace', title: 'Workspace', path: '/tmp/workspace' }] },
    sessionController: {
      modelCatalog: async () => ({ models: ['native-model'] }),
      async create({ sessionId }: {sessionId: string}) { created.push(sessionId); return { sessionId }; },
      resolveAgent: vi.fn(async (sessionId: string) => nativeSessions.has(sessionId) ? { agent: nativeSessions.get(sessionId)! } : { error: 'missing' }),
    },
  } as unknown as DshDirectoryContext;
  const borrowed = { dispose: async () => {} };
  const provider = { borrowSession: vi.fn(async () => borrowed) } as unknown as LiveDshProvider;
  return { context, provider, borrowed, created, directory: createDshSessionDirectory(context, provider) };
}

it('discovers cold session metadata without restoring or borrowing an Agent', async () => {
  const f = fixture();
  expect(await f.directory.list()).toMatchObject([{ nativeSessionId: 'cold-session', workspace: '/tmp/workspace' }]);
  expect(f.context.sessionController.resolveAgent).not.toHaveBeenCalled();
  expect(f.provider.borrowSession).not.toHaveBeenCalled();
  expect(await f.directory.open('cold-session')).toBe(f.borrowed);
});

it('creates with a native workspace and rejects invalid overrides before native mutation', async () => {
  const f = fixture();
  expect(f.directory.workspaces()).toEqual([{ id: 'workspace', name: 'Workspace', path: '/tmp/workspace' }]);
  expect(await f.directory.models()).toEqual({ models: ['native-model'] });
  await expect(f.directory.create({ model: 'foreign-model' })).rejects.toThrow('DSH Web');
  await expect(f.directory.create({ workspaceId: 'missing' })).rejects.toThrow('unavailable');
  expect(f.created).toHaveLength(0);
  const nativeSessionId = await f.directory.create({ workspaceId: 'workspace' });
  expect(f.created).toEqual([nativeSessionId]);
});
