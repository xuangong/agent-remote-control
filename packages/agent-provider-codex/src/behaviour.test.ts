import { AgentSessionInUseError, resolveAgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

describe('the behaviour Codex declares', () => {
  it('is one client among others of a thread the shared daemon keeps loaded 70 s after its last client', () => {
    const declared = new CodexAppServerProvider({ connectionMode: 'shared' }).descriptor.behaviour;
    expect(resolveAgentProviderBehaviour({ behaviour: declared })).toBe(declared);
    expect(declared).toMatchObject({
      concurrency: { model: 'shared_clients', probe: 'lock_file', othersVisible: 'live', unloadAfterLastClientMs: 70_000 },
      reread: { order: 'live', paging: 'turns', withoutAttach: false, cost: 'page' },
      resume: { cost: 'subscription', deadlineMs: 90_000 },
      failures: { inUse: ['writer_elsewhere'] },
      liveOnly: ['interaction', 'todo', 'error', 'startup_notice'],
      verifiedVersion: '0.171.0',
    });
  });

  it("is the thread's single writer through a private app-server, which unloads it when it exits", () => {
    const declared = new CodexAppServerProvider({ spawn: () => createScriptedAppServer({}).child }).descriptor.behaviour;
    expect(resolveAgentProviderBehaviour({ behaviour: declared })).toBe(declared);
    expect(declared?.concurrency).toEqual({ model: 'single_writer', probe: 'lock_file', othersVisible: 'never' });
    expect(declared?.resume.cost).toBe('process');
  });

  it("raises Codex's single-writer refusal as a session in use by a writer elsewhere", async () => {
    const appServer = createScriptedAppServer({
      'thread/resume': () => { throw Object.assign(new Error('thread thread-busy already has an active writer'), { code: -32600 }); },
    });
    const provider = new CodexAppServerProvider({ spawn: () => appServer.child });
    const refused = await provider.resumeSession({ providerId: 'codex', sessionId: 'thread-busy', opaque: '{}' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentSessionInUseError);
    expect(refused).toMatchObject({ reason: 'writer_elsewhere', retryAfterMs: undefined });
  });
});
