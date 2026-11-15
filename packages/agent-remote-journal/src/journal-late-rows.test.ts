import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { expectNoChange, openJournal, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { JournalBodyMissingError, JournalItemTypeChangedError, type JournalRowInput } from './types.js';

const DIGEST = 'a'.repeat(64);
const one: ResourceBinding = { locator: 'one.md', resourceId: 'r1', status: 'available' };
const two: ResourceBinding = { locator: 'two.md', resourceId: 'r2', status: 'pending' };
const pending = { id: 'review-1', kind: 'review' as const, status: 'pending' as const };

const tool = (status: 'running' | 'completed', extra: Partial<JournalRowInput> & { background?: typeof pending } = {}): JournalRowInput => {
  const { background, ...rest } = extra;
  return {
    itemKey: 'tool:w1', providerId: 'codex', sourceKey: `tool:w1:${status}`, occurredAt: status === 'running' ? 1_725_000_000_000 : 1_725_000_001_000, turnId: 'turn-1',
    item: status === 'running'
      ? { type: 'tool_call', callId: 'w1', name: 'write', status, error: null, detail: { type: 'other', description: 'Writing' }, ...(background ? { background } : {}) }
      : { type: 'tool_call', callId: 'w1', name: 'write', status, error: null, detail: { type: 'other', description: 'Wrote' }, ...(background ? { background } : {}) },
    ...rest,
  };
};

/** A journal whose tool item, in turn 1, was evicted: complete with a digest, outside the latest turn. */
function withEvictedTool() {
  const { journal, publish } = openJournal();
  journal.append(publish(), { ...tool('running', { background: pending }), resources: [one] });
  journal.complete(publish(), 'tool:w1', DIGEST);
  journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
  journal.complete(publish(), 'later', DIGEST);
  journal.evict(1);
  expect(journal.index().map(entry => [entry.itemKey, entry.resident])).toEqual([['tool:w1', false], ['later', true]]);
  return { journal, publish };
}

const todoRow = (itemKey: string): JournalRowInput => ({ itemKey, providerId: 'codex', sourceKey: `${itemKey}:todo`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'todo', items: [{ text: 'Ship', completed: false }] } });

const tail = (journal: ReturnType<typeof openJournal>['journal']) => {
  const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
  if (page.kind !== 'page') throw new Error('Expected a page.');
  return page.page.payload.entries;
};

describe('a late row of a content-replacing type reaching an evicted item', () => {
  it('brings the item back with the row\'s content, open, keeping its time, its resources and its background merged with the row\'s', () => {
    const { journal, publish } = withEvictedTool();
    const before = journal.index()[0]!;
    const row = journal.append(publish(), { ...tool('completed', { background: { ...pending, status: 'visible' } }), resources: [two] });
    expect(row).toBeDefined();
    const entry = journal.index()[0]!;
    expect(entry).toMatchObject({ itemKey: 'tool:w1', state: 'open', resident: true, seqEnd: row!.seq });
    expect(entry.digest).toBeUndefined();
    expect(entry.revision).toBeGreaterThan(before.revision);
    const [shown] = tail(journal);
    expect(shown).toMatchObject({
      item: { type: 'tool_call', status: 'completed', detail: { description: 'Wrote' }, background: { id: 'review-1', status: 'visible' } },
      resources: [one, two], collapsed: ['tool_lifecycle'], timestamp: '2024-08-30T06:40:00.000Z',
    });
  });

  it('keeps an outcome that is worse than the row\'s background, and an outcome the row does not carry is dropped as it is for a resident item', () => {
    const { journal, publish } = withEvictedTool();
    journal.outcome(publish(), { ...pending, status: 'failed' });
    journal.append(publish(), tool('completed', { background: { ...pending, status: 'visible' } }));
    expect(tail(journal)[0]!.item.background).toMatchObject({ status: 'failed' });
    const other = withEvictedTool();
    other.journal.append(other.publish(), tool('completed'));
    expect(tail(other.journal)[0]!.item.background).toBeUndefined();
  });

  it('refuses a late row of a compaction, whose merge spreads fields the journal no longer holds', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), { itemKey: 'c', providerId: 'codex', sourceKey: 'c:1', occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'compaction', status: 'loading', trigger: 'auto', preTokens: 900 } });
    journal.complete(publish(), 'c', DIGEST);
    journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
    journal.complete(publish(), 'later', DIGEST);
    journal.evict(1);
    expectNoChange(journal, () => journal.append(publish(), { itemKey: 'c', providerId: 'codex', sourceKey: 'c:2', occurredAt: 1_725_000_002_000, turnId: 'turn-1', item: { type: 'compaction', status: 'completed' } }), JournalBodyMissingError);
  });

  it('refuses a row of another type for an evicted item, which remembers its type', () => {
    const { journal, publish } = withEvictedTool();
    expectNoChange(journal, () => journal.append(publish(), { ...text('tool:w1', 'w1:text', 'Text'), turnId: 'turn-1' }), JournalItemTypeChangedError);
    expectNoChange(journal, () => journal.append(publish(), todoRow('tool:w1')), JournalItemTypeChangedError);
  });

  it('still accepts a late row for an item stored without a type', () => {
    const state = withEvictedTool().journal.state();
    delete state.items[0]!.keptBody!.itemType;
    const restored = new SessionJournal(state);
    const { generation } = restored.claim('controller-2');
    restored.append({ publisherId: 'controller-2', generation, sequence: 1 }, tool('completed'));
    expect(restored.index()[0]).toMatchObject({ itemKey: 'tool:w1', resident: true, state: 'open' });
  });

  it('marks an evicted item live-only when the late row says so', () => {
    const { journal, publish } = withEvictedTool();
    journal.append(publish(), { ...tool('completed'), liveOnly: true });
    expect(journal.index()[0]).toMatchObject({ itemKey: 'tool:w1', liveOnly: true, state: 'open' });
    expect(journal.liveOnlyCount).toBe(1);
  });

  it('replaces a todo list', () => {
    const { journal, publish } = openJournal();
    const todo = (done: boolean, source: string): JournalRowInput => ({ itemKey: 'todo:t', providerId: 'codex', sourceKey: source, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'todo', items: [{ text: 'Ship', completed: done }] } });
    journal.append(publish(), todo(false, 't:1'));
    journal.complete(publish(), 'todo:t', DIGEST);
    journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
    journal.complete(publish(), 'later', DIGEST);
    journal.evict(1);
    journal.append(publish(), todo(true, 't:2'));
    expect(tail(journal)[0]!.item).toEqual({ type: 'todo', items: [{ text: 'Ship', completed: true }] });
  });

  it('still refuses a row that would append to content the journal no longer holds', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('a', 'a:1', 'Alpha', 'turn-1'));
    journal.complete(publish(), 'a', DIGEST);
    journal.append(publish(), text('b', 'b:1', 'Beta', 'turn-2'));
    journal.complete(publish(), 'b', DIGEST);
    journal.evict(1);
    expectNoChange(journal, () => journal.append(publish(), text('a', 'a:2', ' more', 'turn-1')), JournalBodyMissingError);
  });
});
