import { describe, expect, it } from 'vitest';

import { validateAgentSessionCapabilities } from '../../agent-provider-sdk/src/testing.js';
import { AgentManager } from '../../agent-remote-relay/src/agent-manager.js';
import type { AgentManagerEvent } from '../../agent-remote-relay/src/agent-manager-events.js';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

describe('CodexAppServerProvider contract', () => {
  it('creates a usable session and exposes a resumable runtime handle', async () => {
    const appServer = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace' }),
      'turn/start': () => ({ turn: { id: 'turn-1' } }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => appServer.child });

    expect(provider.descriptor).toEqual({ providerId: 'codex', displayName: 'Codex' });
    const session = await provider.createSession({ sessionId: 'local', cwd: '/workspace' });
    validateAgentSessionCapabilities(session);
    const iterator = session.observe()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'history_boundary' }, done: false,
    });
    await session.sendMessage('Hello');

    expect(appServer.requests.map((request) => request.method)).toEqual([
      'initialize', 'model/list', 'configRequirements/read', 'collaborationMode/list', 'thread/start', 'turn/start',
    ]);
    await expect(session.runtimeInfo()).resolves.toMatchObject({
      providerId: 'codex', sessionId: 'thread-1', status: 'running',
      persistence: { providerId: 'codex', sessionId: 'thread-1' },
    });
    expect(session.capabilities.readResource).toBe(true);
    await expect(session.readResource!('/workspace/arbitrary.png')).resolves.toMatchObject({ status: 'unavailable' });
    await session.dispose();
  });

  it('resumes through thread/resume and thread/read before exposing history', async () => {
    const appServer = createScriptedAppServer({
      'thread/resume': () => ({ thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace', sandbox: { type: 'readOnly', networkAccess: false } }),
      'thread/read': () => ({ thread: { id: 'thread-1', turns: [] } }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => appServer.child });
    const session = await provider.resumeSession({
      providerId: 'codex', sessionId: 'thread-1', opaque: '{"cwd":"/workspace"}',
    });
    expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'sandbox')?.value).toBe('readOnly');

    expect(appServer.requests.map((request) => request.method)).toEqual([
      'initialize', 'model/list', 'configRequirements/read', 'collaborationMode/list', 'thread/resume', 'thread/read',
    ]);
    const iterator = session.observe()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'history_boundary' } });
    await session.dispose();
  });

  it('starts configured plan sessions with the app-server plan collaboration mode', async () => {
    const appServer = createScriptedAppServer({
      'collaborationMode/list': () => ({ data: [{ mode: 'plan' }, { mode: 'default' }] }),
      'thread/start': () => ({ thread: { id: 'thread-plan' }, model: 'gpt-5.4', cwd: '/workspace' }),
      'turn/start': () => ({ turn: { id: 'turn-plan' } }),
    });
    const options = { spawn: () => appServer.child, collaborationMode: 'plan' as const };
    const provider = new CodexAppServerProvider(options);
    const session = await provider.createSession({ sessionId: 'local', cwd: '/workspace' });

    await session.sendMessage('Ask a question');

    expect(appServer.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.4' },
      },
    });
    await session.dispose();
  });

  it('propagates an unexpected app-server exit through manager settlement and failed state', async () => {
    const appServer = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'thread-exit' }, model: 'gpt-5.4', cwd: '/workspace' }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => appServer.child });
    const manager = await AgentManager.create({
      agentId: 'agent-codex-exit',
      adapter: provider,
      config: { sessionId: 'local', cwd: '/workspace' },
      epoch: 'epoch-codex-exit',
      clock: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    try {
      appServer.child.stdout.write(`${JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-exit', turnId: 'turn-before-exit',
          itemId: 'message-before-exit', delta: 'Output before app-server exit.',
        },
      })}\n`);
      appServer.child.emitExit(17);

      expect(await settlesWithin(manager.settled)).toBe(true);
      expect(manager.snapshot()).toMatchObject({
        payload: {
          status: 'failed',
          runtimeInfo: { status: 'failed' },
          lastError: 'Provider observation stream failed.',
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'agent_stream',
        event: expect.objectContaining({
          type: 'turn_failed',
          code: 'provider_observation_failed',
          diagnostic: expect.stringContaining('exited with code 17'),
        }),
      }));
      expect(manager.fetchTimeline({
        requestId: 'tail-before-exit', agentId: 'agent-codex-exit', direction: 'tail', limit: 100,
      }).payload.entries).toContainEqual(expect.objectContaining({
        item: expect.objectContaining({
          type: 'assistant_message', text: 'Output before app-server exit.',
        }),
      }));
    } finally {
      await manager.close();
    }
  });
});

async function settlesWithin(settlement: Promise<void>): Promise<boolean> {
  return Promise.race([
    settlement.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
}
