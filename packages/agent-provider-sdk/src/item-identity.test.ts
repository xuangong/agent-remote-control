import { describe, expect, it } from 'vitest';

import { supportsJournal, type AgentProviderAdapter, type ProviderObservation } from './index.js';

const adapter = (journal?: AgentProviderAdapter['journal']): Pick<AgentProviderAdapter, 'journal'> => ({ ...(journal ? { journal } : {}) });

describe('the journal capability', () => {
  it('is declared only by an adapter that says so', () => {
    expect(supportsJournal(adapter())).toBe(false);
    expect(supportsJournal(adapter({ itemIdentity: 1 }))).toBe(true);
    expect(supportsJournal(adapter({ itemIdentity: 2 } as unknown as AgentProviderAdapter['journal']))).toBe(false);
    expect(supportsJournal(adapter({} as unknown as AgentProviderAdapter['journal']))).toBe(false);
  });

  it('lets an observation carry the native identity of its item, its completion and whether history can rebuild it', () => {
    const observation: ProviderObservation = {
      type: 'observation', sourceKey: 'stream:1', occurredAt: 1, delivery: 'live',
      event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' } },
      itemIdentity: { key: 'assistant:m1', completes: true },
    };
    expect(observation.itemIdentity).toEqual({ key: 'assistant:m1', completes: true });
  });
});
