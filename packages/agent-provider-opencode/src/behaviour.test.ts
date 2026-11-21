import { resolveAgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { expect, it } from 'vitest';

import { OpenCodeAgentProvider } from './provider.js';

it('declares that the OpenCode server shares a session among its clients and serves its history without an attachment', () => {
  const provider = new OpenCodeAgentProvider({ serverUrl: 'http://127.0.0.1:1' });
  const declared = provider.descriptor.behaviour;
  expect(resolveAgentProviderBehaviour(provider.descriptor)).toBe(declared);
  expect(declared).toMatchObject({
    concurrency: { model: 'shared_clients', probe: 'none', othersVisible: 'live' },
    reread: { withoutAttach: true },
    resume: { cost: 'subscription' },
    input: { whileBusy: 'steer' },
    limits: { signal: 'event' },
    failures: { runtime: ['native_runtime_unavailable', 'native_usage_limited'] },
    liveOnly: [],
  });
});
