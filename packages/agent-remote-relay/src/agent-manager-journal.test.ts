import type { AgentCapabilities, AgentProviderAdapter, AgentResourceReadResult, AgentRuntimeInfo, AgentSession, AgentSessionConfig, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { AgentManager, type AgentJournalTap } from './agent-manager.js';
import { rowItemKey } from './timeline-projector.js';

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true },
};

class Stream implements AsyncIterable<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private waiter: ((result: IteratorResult<ProviderStreamItem>) => void) | undefined;
  private finished = false;
  push(value: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter({ done: false, value }); } else this.values.push(value);
  }
  finish(): void { this.finished = true; this.waiter?.({ done: true, value: undefined }); }
  [Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false as const, value });
      if (this.finished) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise<IteratorResult<ProviderStreamItem>>(resolve => { this.waiter = resolve; });
    } };
  }
}

interface Options { journalContract?: boolean; hold?: Promise<void>; onHistoryRead?: () => void; older?: Array<{ observations: ProviderObservation[]; nextCursor?: string }>; readResource?: () => Promise<AgentResourceReadResult> }

function session(stream: Stream, options: Options = {}): AgentSession {
  const runtime: AgentRuntimeInfo = { providerId: 'fake', sessionId: 'session-1', status: 'idle', persistence: { providerId: 'fake', sessionId: 'session-1', opaque: 'resume-1' } };
  const pages = [...(options.older ?? [])];
  return {
    capabilities: { ...capabilities, ...(options.readResource ? { readResource: true } : {}) },
    observe: () => stream,
    async sendMessage() {}, async respondToInteraction() {},
    async runtimeInfo() { return runtime; },
    async dispose() { stream.finish(); },
    ...(options.older ? { async readTimelineHistory() { options.onHistoryRead?.(); await options.hold; return pages.shift() ?? { observations: [] }; } } : {}),
    ...(options.readResource ? { readResource: options.readResource } : {}),
  };
}

const observation = (sourceKey: string, text: string, key: string, extra: Partial<ProviderObservation> = {}): ProviderObservation => ({
  type: 'observation', sourceKey, occurredAt: 1_725_000_000_000, delivery: 'live',
  event: { type: 'timeline', provider: 'fake', turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key } },
  itemIdentity: { key }, ...extra,
});

async function attach(stream: Stream, options: Options = {}) {
  const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'fake', displayName: 'Fake' }, epoch: 'epoch-1', session: session(stream, options), ...(options.journalContract ? { journalContract: true } : {}) });
  return manager;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('the journal tap of an agent manager', () => {
  it('hands over the timeline as it stands, with the identity each row came with, and then every event', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:1', 'Hello', 'm1', { delivery: 'history' }), itemIdentity: { key: 'm1', completes: true } });
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    const subscription = manager.subscribeJournal({ event: event => events.push(event), closed: () => undefined });
    expect(subscription.rows.map(row => [row.seq, row.sourceKey, row.identity])).toEqual([[1, 'history:1', { key: 'm1', completes: true }]]);
    expect(subscription.snapshot.payload.id).toBe('agent-1');
    stream.push(observation('stream:2', 'Wor', 'm2'));
    stream.push(observation('stream:3', 'ld', 'm2', { itemIdentity: { key: 'm2', completes: true } }));
    await flush();
    const rows = events.flatMap(event => event.type === 'agent_stream' && event.row ? [event.row] : []);
    expect(rows.map(row => [row.seq, row.identity])).toEqual([[2, { key: 'm2' }], [3, { key: 'm2', completes: true }]]);
    expect(manager.itemRows('m2').map(row => row.sourceKey)).toEqual(['stream:2', 'stream:3']);
    expect(manager.itemRows('unknown')).toEqual([]);
    await manager.close();
  });

  it('does not count as a viewer, so an idle session can still be released', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    expect(manager.canReleaseIdle()).toBe(true);
    const subscription = manager.subscribeJournal({ event: () => undefined, closed: () => undefined });
    expect(manager.canReleaseIdle()).toBe(true);
    manager.subscribe(() => undefined);
    expect(manager.canReleaseIdle()).toBe(false);
    subscription.release();
    await manager.close();
  });

  it('stops delivering after release, and tells a tap that the session closed', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    const released: AgentManagerEvent[] = [], kept: AgentManagerEvent[] = [];
    let closed = 0;
    manager.subscribeJournal({ event: event => released.push(event), closed: () => undefined }).release();
    const tap: AgentJournalTap = { event: event => kept.push(event), closed: () => { closed += 1; } };
    manager.subscribeJournal(tap);
    stream.push(observation('stream:1', 'Hi', 'm1'));
    await flush();
    expect(released).toEqual([]);
    expect(kept.length).toBeGreaterThan(0);
    await manager.close();
    expect(closed).toBe(1);
  });

  it('tells a tap that subscribes after the manager closed, and gives it nothing', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    await manager.close();
    let closed = 0;
    const subscription = manager.subscribeJournal({ event: () => { throw new Error('No event can follow.'); }, closed: () => { closed += 1; } });
    expect(closed).toBe(1);
    expect(subscription.rows).toEqual([]);
    subscription.release();
  });

  it('gives a row without identity the key of its source, and finds the item of the row an attention cursor points at', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    stream.push({ ...observation('stream:1', 'Hi', 'm1'), itemIdentity: undefined });
    stream.push(observation('stream:2', 'There', 'm2'));
    await flush();
    const [first] = manager.itemRows('controller:stream:1');
    expect(first && rowItemKey(first)).toBe('controller:stream:1');
    expect(manager.attentionItemKey()).toBe('m2');
    await manager.close();
  });

  it('tells the tap once when a journal-capable provider emits an observation without identity, or a key of the Controller\'s own prefix', async () => {
    for (const breach of [{ itemIdentity: undefined }, { itemIdentity: { key: 'controller:m1' } }]) {
      const stream = new Stream();
      stream.push({ type: 'history_boundary' });
      const manager = await attach(stream, { journalContract: true });
      await manager.ready;
      let told = 0;
      manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
      stream.push(observation('stream:1', 'Hi', 'm1', breach));
      stream.push(observation('stream:2', 'Again', 'm2', { itemIdentity: undefined }));
      await flush();
      expect(told).toBe(1);
      await manager.close();
    }
  });

  it('tells a tap that subscribes later about a breach in history', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:1', 'Old', 'm1', { delivery: 'history' }), itemIdentity: undefined });
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream, { journalContract: true });
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    await flush();
    expect(told).toBe(1);
    await manager.close();
  });

  it('tells a tap that an interaction was resolved without identity, and accepts one that carries it', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream, { journalContract: true });
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    const resolved = { type: 'observation' as const, sourceKey: 'stream:1', occurredAt: 1, delivery: 'live' as const,
      event: { type: 'interaction_resolved' as const, provider: 'fake', requestId: 'q1', response: { kind: 'question' as const, answers: [] } } };
    stream.push({ ...resolved, itemIdentity: { key: 'question:q1', completes: true } });
    await flush();
    expect(told).toBe(0);
    stream.push({ ...resolved, sourceKey: 'stream:2' });
    await flush();
    expect(told).toBe(1);
    await manager.close();
  });

  it('does not tell a tap about a provider that does not declare journal support', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    stream.push({ ...observation('stream:1', 'Hi', 'm1'), itemIdentity: undefined });
    await flush();
    expect(told).toBe(0);
    await manager.close();
  });

  it('takes the journal contract from the adapter that creates the session', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const adapter = {
      descriptor: { providerId: 'fake', displayName: 'Fake' }, journal: { itemIdentity: 1 as const },
      createSession: async () => session(stream), resumeSession: async () => session(stream),
    } as unknown as AgentProviderAdapter;
    const manager = await AgentManager.create({ agentId: 'agent-1', adapter, config: { cwd: '/tmp' } as AgentSessionConfig, epoch: 'epoch-1' });
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    stream.push({ ...observation('stream:1', 'Hi', 'm1'), itemIdentity: undefined });
    await flush();
    expect(told).toBe(1);
    await manager.close();
  });

  it('reads one older page of native history into the timeline for the journal, and says whether more remains', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:5', 'Newest', 'm5', { delivery: 'history' }), itemIdentity: { key: 'm5', completes: true } });
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    const manager = await attach(stream, { older: [
      { observations: [
        { ...observation('history:3', 'Third', 'm3', { delivery: 'history' }), itemIdentity: { key: 'm3', completes: true } },
        { ...observation('history:4', 'Fourth', 'm4', { delivery: 'history' }), itemIdentity: { key: 'm4', completes: true } },
      ], nextCursor: 'page-3' },
      { observations: [{ ...observation('history:1', 'First', 'm1', { delivery: 'history' }), itemIdentity: { key: 'm1', completes: true } }] },
    ] });
    await manager.ready;
    expect(manager.hasOlderHistory()).toBe(true);
    expect(await manager.loadOlderHistory()).toEqual({ added: 2, more: true });
    expect(manager.timelineRows().map(row => row.identity?.key)).toEqual(['m3', 'm4', 'm5']);
    expect(await manager.loadOlderHistory()).toEqual({ added: 1, more: false });
    expect(manager.hasOlderHistory()).toBe(false);
    expect(await manager.loadOlderHistory()).toEqual({ added: 0, more: false });
    await manager.close();
  });

  it('tells a tap which item a replaced resource binding belongs to', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    let release!: (result: AgentResourceReadResult) => void;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let reads = 0;
    const manager = await attach(stream, { readResource: () => {
      reads += 1;
      return reads === 1 ? Promise.resolve({ status: 'available', mediaType: 'image/png', bytes: png } as const) : new Promise<AgentResourceReadResult>(resolve => { release = resolve; });
    } });
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    manager.subscribeJournal({ event: event => events.push(event), closed: () => undefined });
    stream.push(observation('stream:1', 'First [output](output.png).', 'm1'));
    await flush();
    stream.push({ type: 'observation', sourceKey: 'stream:2', occurredAt: 2, delivery: 'live', itemIdentity: { key: 'tool:write-1', completes: true },
      event: { type: 'timeline', provider: 'fake', item: { type: 'tool_call', callId: 'write-1', name: 'write', status: 'completed', error: null, detail: { type: 'other', description: 'Reuse [output](output.png).' } } } });
    await flush();
    release({ status: 'available', mediaType: 'image/png', bytes: png });
    await flush();
    expect(events.find(event => event.type === 'timeline_resource_binding_replaced')).toMatchObject({ itemKey: 'tool:write-1', seq: 2 });
    await manager.close();
  });
  it('shares one older-history read between a viewer and the journal tap', async () => {
    const stream = new Stream();
    const history = (n: number) => ({ ...observation(`history:${n}`, `Row ${n}`, `m${n}`, { delivery: 'history' }), itemIdentity: { key: `m${n}`, completes: true } });
    stream.push(history(5));
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    const manager = await attach(stream, { older: [
      { observations: [history(4)], nextCursor: 'page-3' }, { observations: [history(3)], nextCursor: 'page-4' }, { observations: [history(2)] },
    ] });
    await manager.ready;
    const viewer = manager.loadTimeline({ requestId: 'v', agentId: 'agent-1', direction: 'before', cursor: { epoch: 'epoch-1', seq: 1 }, limit: 100 });
    const tap = manager.loadOlderHistory();
    expect(await tap).toEqual({ added: 1, more: true });
    await viewer;
    expect(manager.timelineRows().map(row => row.identity?.key)).toEqual(['m4', 'm5']);
    await manager.close();
  });

  it('reads no history once the manager closed', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    let reads = 0;
    const manager = await attach(stream, { older: [{ observations: [] }], onHistoryRead: () => { reads += 1; } });
    await manager.ready;
    const original = manager.hasOlderHistory();
    expect(original).toBe(true);
    await manager.close();
    expect(await manager.loadOlderHistory()).toEqual({ added: 0, more: false });
    expect(reads).toBe(0);
  });

  it('never reports a negative count when the timeline was replaced while a page was read', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:5', 'Newest', 'm5', { delivery: 'history' }), itemIdentity: { key: 'm5', completes: true } });
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    let release!: () => void;
    const manager = await attach(stream, { older: [{ observations: [] }], hold: new Promise<void>(resolve => { release = resolve; }) });
    await manager.ready;
    const loading = manager.loadOlderHistory();
    manager.replaceTimeline('epoch-2');
    release();
    const result = await loading;
    expect(result.added).toBe(0);
    await manager.close();
  });

  it('does not point the attention cursor at a row prepended before the timeline began', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    const manager = await attach(stream, { older: [{ observations: [{ ...observation('history:1', 'Older', 'm1', { delivery: 'history' }), itemIdentity: { key: 'm1', completes: true } }] }] });
    await manager.ready;
    await manager.loadOlderHistory();
    expect(manager.timelineRows().map(row => row.seq)).toEqual([0]);
    expect(manager.attentionItemKey()).toBeUndefined();
    await manager.close();
  });

  it('tells a tap that throws on an event that it was removed, and keeps serving the others', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    let closed = 0;
    const seen: AgentManagerEvent[] = [];
    manager.subscribeJournal({ event: () => { throw new Error('The tap failed.'); }, closed: () => { closed += 1; } });
    manager.subscribeJournal({ event: event => seen.push(event), closed: () => undefined });
    stream.push(observation('stream:1', 'Hi', 'm1'));
    stream.push(observation('stream:2', 'There', 'm2'));
    await flush();
    expect(closed).toBe(1);
    expect(seen.length).toBeGreaterThan(1);
    await manager.close();
    expect(closed).toBe(1);
  });

  it('does not tell a tap that released, or the manager closed, about an identity breach it would have heard', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:1', 'Old', 'm1', { delivery: 'history' }), itemIdentity: undefined });
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream, { journalContract: true });
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } }).release();
    await flush();
    expect(told).toBe(0);
    await manager.close();
  });
});
