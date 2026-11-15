import type { AgentSnapshotPayload, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { openJournal, text } from './journal.test-fixture.js';

const DIGEST = 'a'.repeat(64);
const pending: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
const settled: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' };
const review = { id: 'review-1', kind: 'review' as const, status: 'pending' as const };

const snapshot = (attention: boolean): AgentSnapshotPayload => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
  ...(attention ? { attention: { cursor: { epoch: 'controller-epoch', seq: 99 } } } : {}),
});

function withTwoItems() {
  const fixture = openJournal();
  const { journal, publish } = fixture;
  journal.append(publish(), { ...text('a', 'a:1', 'Alpha'), resources: [pending], item: { type: 'assistant_message', text: 'Alpha', messageId: 'a', background: review } });
  journal.complete(publish(), 'a', DIGEST);
  journal.append(publish(), text('b', 'b:1', 'Beta'));
  journal.complete(publish(), 'b', DIGEST);
  return fixture;
}

describe('a correction without a digest', () => {
  it('replaces the content and leaves the item open', () => {
    const { journal, publish } = withTwoItems();
    const revision = journal.index().find(entry => entry.itemKey === 'b')!.revision;
    journal.correct(publish(), text('b', 'b:full', 'Beta, in full'), undefined, revision);
    const entry = journal.index().find(item => item.itemKey === 'b')!;
    expect(entry).toMatchObject({ state: 'open', revision: revision + 1 });
    expect(entry.digest).toBeUndefined();
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false })).toMatchObject({
      kind: 'page', page: { payload: { entries: [{ item: { text: 'Alpha' } }, { item: { text: 'Beta, in full' } }] } },
    });
  });
});

describe('a resource binding replaced in place', () => {
  it('changes the binding of a resident item and reports the position clients know the item by', () => {
    const { journal, publish } = withTwoItems();
    const revision = journal.index()[0]!.revision;
    expect(journal.rebind(publish(), 'a', pending, settled)).toEqual({ epoch: 'epoch-1', seq: 1 });
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ resources: [settled] }, { resources: [] }] } } });
    expect(journal.index()[0]!.revision).toBe(revision);
  });

  it('changes the binding an evicted item keeps, so it shows after the body is filled again', () => {
    const { journal, publish } = withTwoItems();
    journal.evict(0);
    expect(journal.index().map(entry => entry.resident)).toEqual([false, false]);
    journal.rebind(publish(), 'a', pending, settled);
    journal.fill('a', { item: { type: 'assistant_message', text: 'Alpha', messageId: 'a' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [pending] }, DIGEST);
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 1 }, { olderBeyondJournal: false })).toMatchObject({ kind: 'missing' });
    journal.fill('b', { item: { type: 'assistant_message', text: 'Beta', messageId: 'b' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [] }, DIGEST);
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ resources: [settled] }, {}] } } });
  });

  it('is a no-op for an item it does not know and for a publication it already applied', () => {
    const { journal, publish } = withTwoItems();
    const unknown = publish();
    expect(journal.rebind(unknown, 'missing', pending, settled)).toBeUndefined();
    expect(journal.publisher?.watermark).toBe(unknown.sequence);
    const again = publish();
    expect(journal.rebind(again, 'a', pending, settled)).toBeDefined();
    expect(journal.rebind(again, 'a', settled, pending)).toBeUndefined();
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false })).toMatchObject({ page: { payload: { entries: [{ resources: [settled] }, {}] } } });
  });
});

describe('a background outcome applied in place', () => {
  it('reaches every item of that background, evicted ones included, and never regresses', () => {
    const { journal, publish } = withTwoItems();
    journal.append(publish(), { ...text('c', 'c:1', 'Gamma', 'turn-2'), item: { type: 'assistant_message', text: 'Gamma', messageId: 'c', background: { ...review, id: 'other' } } });
    journal.evict(1);
    expect(journal.index().map(entry => entry.resident)).toEqual([false, false, true]);
    expect(journal.outcome(publish(), { ...review, status: 'visible', summary: 'Found two issues.' })).toBe(true);
    expect(journal.outcome(publish(), { ...review, status: 'silent' })).toBe(true);
    journal.fill('a', { item: { type: 'assistant_message', text: 'Alpha', messageId: 'a' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [pending] }, DIGEST);
    journal.fill('b', { item: { type: 'assistant_message', text: 'Beta', messageId: 'b' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [] }, DIGEST);
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    if (page.kind !== 'page') throw new Error('Expected a page.');
    expect(page.page.payload.entries.map(entry => entry.item.background)).toEqual([{ ...review, status: 'visible', summary: 'Found two issues.' }, undefined, { ...review, id: 'other' }]);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = withTwoItems();
    const publication = publish();
    expect(journal.outcome(publication, { ...review, status: 'visible' })).toBe(true);
    expect(journal.outcome(publication, { ...review, status: 'failed' })).toBe(false);
  });
});

describe('rows of a replacement or a prepend that only the Controller holds', () => {
  it('stay live-only, so a later reread does not count them as missing', () => {
    const { journal, publish } = openJournal();
    journal.replace(publish(), [
      { row: text('a', 'a:1', 'Alpha'), digest: DIGEST },
      { row: { ...text('q', 'q:1', 'Question'), liveOnly: true }, digest: DIGEST },
    ], 1_000);
    expect(journal.index().map(entry => [entry.itemKey, entry.liveOnly])).toEqual([['a', false], ['q', true]]);
    journal.prepend(publish(), [{ row: { ...text('p', 'p:1', 'Older'), liveOnly: true }, digest: DIGEST }]);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'p', liveOnly: true });
  });
});

describe('items of a replacement or a prepend that are still open', () => {
  it('carry no digest, stay open and are never evicted', () => {
    const { journal, publish } = openJournal();
    journal.replace(publish(), [
      { row: text('a', 'a:1', 'Alpha', 'turn-1'), digest: DIGEST },
      { row: text('b', 'b:1', 'Streaming', 'turn-2') },
    ], 1_000);
    expect(journal.index().map(entry => [entry.itemKey, entry.state, entry.digest])).toEqual([['a', 'complete', DIGEST], ['b', 'open', undefined]]);
    journal.prepend(publish(), [{ row: text('p', 'p:1', 'Older', 'turn-0') }]);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'p', state: 'open' });
    journal.evict(0);
    expect(journal.index().map(entry => [entry.itemKey, entry.resident])).toEqual([['p', true], ['a', false], ['b', true]]);
  });
});

describe('the attention cursor of the head', () => {
  it('is the cursor of the named item in the journal\'s own epoch and sequence', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'a' });
    expect(journal.head?.snapshot.attention).toEqual({ cursor: { epoch: 'epoch-1', seq: 1 } });
    expect(journal.head).not.toHaveProperty('attentionItemKey');
    journal.append(publish(), text('a', 'a:2', ' more'));
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch: 'epoch-1', seq: 3 });
  });

  it('is the journal\'s latest cursor when no item is named, and absent when the snapshot has no attention', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5 });
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
    journal.setHead(publish(), { snapshot: snapshot(false), observedAt: 6, attentionItemKey: 'a' });
    expect(journal.head?.snapshot.attention).toBeUndefined();
  });

  it('follows the item into the new epoch of a replacement', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'b' });
    const epoch = journal.replace(publish(), [
      { row: text('b', 'b:r', 'Beta'), digest: DIGEST },
      { row: text('a', 'a:r', 'Alpha'), digest: DIGEST },
    ], 1_000);
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch, seq: 1 });
  });

  it('survives a store round trip with the item it names', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'a' });
    expect(journal.takeChanges()?.meta.head?.attentionItemKey).toBe('a');
  });
});
