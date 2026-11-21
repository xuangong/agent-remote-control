import { resolveAgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { expect, it } from 'vitest';

import { createLiveDshProvider } from './live-provider.js';
import { createRecordedDshProvider } from './recorded-provider.js';

it('declares that a DeepSeek Harness agent, live or recorded, has no client but the Controller', () => {
  const live = createLiveDshProvider({ runtime: {} as never });
  const recorded = createRecordedDshProvider({ trace: { header: { sessionId: 'trace' } } as never, mode: 'instant' as never });
  for (const provider of [live, recorded]) {
    expect(resolveAgentProviderBehaviour(provider.descriptor)).toBe(provider.descriptor.behaviour);
    expect(provider.descriptor.behaviour?.concurrency).toEqual({ model: 'none', probe: 'none', othersVisible: 'never' });
  }
  expect(recorded.descriptor.behaviour?.resume.cost).toBe('subscription');
});
