import type { AgentCapabilities, AgentSession, AgentSessionConfig } from '@borgee/agent-provider-sdk';
import { describe, expect, it } from 'vitest';
import { createCopilotSessionDirectory } from './copilot-directory.js';

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

function nativeSession(id: string, cwd = '/work') {
  let disposed = false;
  const session: AgentSession = { capabilities, async *observe() { yield { type: 'history_boundary' }; },
    async runtimeInfo() { return { providerId: 'copilot', sessionId: id, cwd, status: disposed ? 'closed' : 'idle',
      persistence: { providerId: 'copilot', sessionId: id, opaque: '{}' } }; },
    async sendMessage() {}, async respondToInteraction() {}, async dispose() { disposed = true; } };
  return { session, disposed: () => disposed };
}

describe('Copilot Host directory', () => {
  it('closes the shared provider once even when no sessions were loaded', async () => {
    let stops = 0;
    const directory = createCopilotSessionDirectory({ listSessions: async () => [],
      createSession: async () => nativeSession('root').session, resumeSession: async () => nativeSession('root').session,
      async dispose() { stops++; } }, []);
    await directory.close(); await directory.close();
    expect(stops).toBe(1);
  });
  it('delegates child attachment to the loaded parent owner and rejects attachment after close', async () => {
    const child = nativeSession('child');
    const directory = createCopilotSessionDirectory({ listSessions: async () => [], createSession: async () => nativeSession('root').session,
      resumeSession: async () => { throw new Error('Do not resume native children'); },
      async openChildSession(parent, id) { if (parent !== 'root' || id !== 'child') throw new Error('Not a direct child'); return child.session; } }, []);
    expect(await directory.openChild!('root', 'child')).toBe(child.session);
    await expect(directory.openChild!('other', 'child')).rejects.toThrow(/direct child/);
    await directory.close();
    await expect(directory.openChild!('root', 'child')).rejects.toThrow(/closed/);
  });
  it('keeps created sessions available before native persistence and disposes them at Host shutdown', async () => {
    let config: AgentSessionConfig | undefined;
    let created: ReturnType<typeof nativeSession> | undefined;
    const directory = createCopilotSessionDirectory({ async listSessions() { return []; },
      async createSession(input) { config = input; created = nativeSession(input.sessionId, input.cwd); return created.session; },
      async resumeSession() { throw new Error('Created session must remain owned by the Host'); } },
    [{ id: 'workspace', name: 'Workspace', path: '/selected' }]);
    const id = await directory.create({ workspaceId: 'workspace', model: 'copilot-model' });
    expect(config).toMatchObject({ cwd: '/selected', model: 'copilot-model' });
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(await directory.open(id)).toBe(created!.session);
    expect(await directory.list()).toEqual([expect.objectContaining({ providerId: 'copilot', nativeSessionId: id, workspace: '/selected', state: 'idle' })]);
    expect(directory.openChild).toBeUndefined();
    expect(created!.disposed()).toBe(false);
    await directory.close();
    expect(created!.disposed()).toBe(true);
    await expect(directory.open(id)).rejects.toThrow(/closed/i);
  });

  it('resumes cold native sessions and rejects unknown workspaces before creating', async () => {
    const native = nativeSession('persisted');
    let resumes = 0;
    const directory = createCopilotSessionDirectory({ async listSessions() { return []; },
      async createSession() { throw new Error('must validate workspace'); },
      async resumeSession(handle) { expect(handle).toMatchObject({ providerId: 'copilot', sessionId: 'persisted' }); resumes++; return native.session; } }, []);
    await expect(directory.create({ workspaceId: 'unknown' })).rejects.toThrow(/workspace/i);
    expect(await directory.open('persisted')).toBe(native.session);
    expect(await directory.open('persisted')).toBe(native.session);
    expect(resumes).toBe(1);
    await directory.close();
  });

  it('disposes a native session completing initialization after the directory closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const native = nativeSession('late');
    const directory = createCopilotSessionDirectory({ async listSessions() { return []; },
      async createSession() { await gate; return native.session; }, async resumeSession() { throw new Error('unused'); } }, []);
    const creating = directory.create({});
    await directory.close(); release();
    await expect(creating).rejects.toThrow(/closed/i);
    expect(native.disposed()).toBe(true);
  });
});
