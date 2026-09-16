import { describe, expect, it, vi } from 'vitest';
import { createDshWebInteractionAdapter } from '@agent-remote-controller/agent-provider-dsh';

import { createDshAgentRemoteProvider } from './agent-remote-provider.js';

describe('DSH plugin Agent Remote Provider export', () => {
  it('uses the supplied shared Web interaction adapter without adding owned listeners', async () => {
    const on = vi.fn((_event: string, _listener: unknown, _prepend?: boolean) => () => undefined);
    const nativeAgent = {
      id: 'joint-session', status: 'idle', options: {},
      session: { id: 'joint-session', events: [], snapshotEvents: () => [], header: {} },
      followup: () => undefined, steer: () => undefined, cancel: () => undefined,
    };
    const context = {
      get: (name: string) => {
        if (name === 'userQuestions') return { ask: async () => ({ answers: [] }) };
        if (name === 'approval') return { request: async () => 'rejected' };
        if (name === 'tools') return { get: () => ({}), schemas: () => [{}] };
        return undefined;
      },
      on,
      agents: { create: async () => ({ agent: nativeAgent, dispose: async () => undefined }) },
      sessions: { flush: async () => undefined },
    };
    const interactions = createDshWebInteractionAdapter(context as never);
    const provider = createDshAgentRemoteProvider(context as never, { interactions });
    const session = await provider.createSession({ sessionId: 'joint-session' });

    const interactionListeners = on.mock.calls.filter(([event]) => event === 'user-questions/request' || event === 'approval/request');
    expect(interactionListeners).toEqual([
      ['user-questions/request', expect.any(Function), true],
      ['approval/request', expect.any(Function), true],
    ]);
    expect(session.capabilities.interactions).toEqual({ question: true, planApproval: true, toolApproval: true });

    await session.dispose();
    await provider.dispose();
    await interactions.dispose();
  });

  it('constructs the DSH Provider from a Cordis context', () => {
    const context = { get: () => undefined, on: () => () => undefined };
    const provider = createDshAgentRemoteProvider(context as never);
    expect(provider.descriptor).toEqual({ providerId: 'dsh', displayName: 'DeepSeek Harness' });
  });
});
