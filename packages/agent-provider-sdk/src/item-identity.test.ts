import { describe, expect, it } from 'vitest';

import { liveOnlyKeyViolations, supportsJournal, type AgentProviderAdapter, type ProviderObservation } from './index.js';

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

describe('the live-only key rule', () => {
  const observation = (key: string, type: 'todo' | 'reasoning', liveOnly = true): ProviderObservation => ({
    type: 'observation', sourceKey: `source:${key}`, occurredAt: 1, delivery: 'live',
    event: { type: 'timeline', provider: 'fake', item: type === 'todo' ? { type: 'todo', items: [] } : { type: 'reasoning', text: 'x' } },
    itemIdentity: { key, completes: true, ...(liveOnly ? { liveOnly: true as const } : {}) },
  });

  it('accepts one live-only key per item type, however often it is observed', () => {
    expect(liveOnlyKeyViolations([observation('todo', 'todo'), observation('todo', 'todo'), observation('reasoning:r1', 'reasoning')])).toEqual([]);
  });

  it('fails an adapter that names occurrences: two live-only keys of one item type', () => {
    expect(liveOnlyKeyViolations([observation('todo:a', 'todo'), observation('todo:b', 'todo')])).toEqual(['todo: todo:a, todo:b']);
  });

  it('ignores items that are not live-only', () => {
    expect(liveOnlyKeyViolations([observation('reasoning:1', 'reasoning', false), observation('reasoning:2', 'reasoning', false)])).toEqual([]);
  });
});
