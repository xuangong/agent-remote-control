import { describe, expect, it } from 'vitest';

import {
  identityFindings, inputIdentityFindings, liveOnlyFindings, recordedItems, rereadOrderFindings, unknownEventFindings, usageLimitFindings, writerElsewhereFindings,
  type ProviderNativeLimit, type ProviderNativeTurn,
} from './conformance-checks.js';
import { AgentSessionInUseError, UNDECLARED_PROVIDER_BEHAVIOUR, unknownNativeEventLine, type AgentProviderBehaviour, type ProviderObservation } from './index.js';

/** A timeline row of item `key` in turn `turnId`, as an adapter emits it. */
const row = (key: string, turnId?: string, options: { liveOnly?: true; type?: 'assistant_message' | 'todo' | 'error'; delivery?: 'live' | 'history'; clientId?: string } = {}): ProviderObservation => ({
  type: 'observation', sourceKey: `source:${key}`, occurredAt: 1, delivery: options.delivery ?? 'live',
  event: { type: 'timeline', provider: 'test', ...(turnId ? { turnId } : {}),
    item: options.clientId ? { type: 'user_message', text: key, clientMessageId: options.clientId } : options.type === 'todo' ? { type: 'todo', items: [] }
      : options.type === 'error' ? { type: 'error', message: key } : { type: 'assistant_message', text: key } },
  itemIdentity: { key, completes: true, ...(options.liveOnly ? { liveOnly: true as const } : {}) },
});
const recording = (live: ProviderObservation[], reread: ProviderObservation[]) => ({ live, reread: reread.map(value => ({ ...value, delivery: 'history' as const })) });
const declared = (changes: Partial<AgentProviderBehaviour>): AgentProviderBehaviour => ({ ...UNDECLARED_PROVIDER_BEHAVIOUR, ...changes });

describe('the checks of the provider conformance kit', () => {
  it('group rows into items in the order each first appears, with the turn of its first row and any live-only mark (recordedItems)', () => {
    expect(recordedItems([row('a', 't1'), row('b', 't1', { liveOnly: true }), row('a', 't2')])).toEqual([
      { key: 'a', type: 'assistant_message', turnId: 't1', liveOnly: false }, { key: 'b', type: 'assistant_message', turnId: 't1', liveOnly: true }]);
  });

  it('hold a reread to the live order, or let it permute only the siblings of one live turn (K1)', () => {
    const live = [row('a', 't1'), row('b', 't2'), row('c', 't2'), row('d', 't3')];
    const swapped = recording(live, [row('a', 't1'), row('c', 't2'), row('b', 't2'), row('d', 't3')]);
    expect(rereadOrderFindings('swapped', swapped, 'live')).toHaveLength(1);
    expect(rereadOrderFindings('swapped', swapped, 'siblings_unordered')).toEqual([]);
    // A reread that names another turn for an item still keeps the live turn's siblings together.
    expect(rereadOrderFindings('renamed', recording(live, [row('a', 'x'), row('c', 'y'), row('b', 'z'), row('d', 'w')]), 'siblings_unordered')).toEqual([]);
    const acrossTurns = recording(live, [row('a', 't1'), row('d', 't3'), row('b', 't2'), row('c', 't2')]);
    expect(rereadOrderFindings('across', acrossTurns, 'siblings_unordered')).toHaveLength(1);
    // Live-only items and items one side lacks take no part.
    expect(rereadOrderFindings('partial', recording([row('x', 't1', { liveOnly: true }), ...live], [row('b', 't2'), row('d', 't3')]), 'live')).toEqual([]);
  });

  it('find a row without identity, a key a journal cannot hold, a reread item the live run lacked, and one a reread leaves open (K2)', () => {
    const bare = { ...row('a'), itemIdentity: undefined } as ProviderObservation;
    expect(identityFindings('fine', recording([row('a'), row('b')], [row('a')]))).toEqual([]);
    expect(identityFindings('bare', recording([bare], []))).toHaveLength(1);
    expect(identityFindings('reserved', recording([row('controller:x')], []))).toHaveLength(1);
    expect(identityFindings('empty', recording([row('')], []))).toHaveLength(1);
    expect(identityFindings('long', recording([row('k'.repeat(4097))], []))).toHaveLength(1);
    expect(identityFindings('added', recording([row('a')], [row('a'), row('z')]))).toEqual(['identity: a reread of added names items the live run did not show: z']);
    const open = { ...row('a'), itemIdentity: { key: 'a' } };
    expect(identityFindings('open', recording([row('a')], [open]))).toEqual(['identity: a reread of open leaves items open, which native history holds finished: a']);
  });

  it('find a live-only mark on a type no declared kind names (K3)', () => {
    const marked = recording([row('todo', 't1', { liveOnly: true, type: 'todo' }), row('partial', 't1', { liveOnly: true })], []);
    expect(liveOnlyFindings([['run', marked]], ['todo', 'partial_output'])).toEqual([]);
    expect(liveOnlyFindings([['run', marked]], ['todo', 'synthetic_output'])).toEqual([]);
    expect(liveOnlyFindings([['run', marked]], ['todo'])).toEqual(['liveOnly [todo]: run (partial) marks an item of type assistant_message live-only, and no declared kind names that type']);
    expect(liveOnlyFindings([['run', recording([row('e', 't1', { liveOnly: true, type: 'error' })], [])]], ['startup_notice'])).toEqual([]);
  });

  it("find an input id the CLI should keep and does not, live or on a reread (K4)", () => {
    const turn = (live: string | undefined, reread: string | undefined): ProviderNativeTurn => ({
      live: [row('user', 't', { clientId: live })], reread: [row('user', 't', { clientId: reread })], diagnostics: [], unknownSent: 0 });
    expect(inputIdentityFindings(turn('id-1', 'id-1'), 'id-1', 'echoes_client_id')).toEqual([]);
    expect(inputIdentityFindings(turn('id-1', 'other'), 'id-1', 'echoes_client_id')).toHaveLength(1);
    expect(inputIdentityFindings(turn('other', 'id-1'), 'id-1', 'echoes_client_id')).toHaveLength(1);
    expect(inputIdentityFindings(turn(undefined, undefined), 'id-1', 'none')).toEqual([]);
  });

  it('find a limit signal that does not fail its turn as declared, or a runtime that does not say when it resets (K5)', () => {
    const typed = declared({ limits: { signal: 'event' }, failures: { runtime: ['native_usage_limited'], inUse: [] } });
    const limit = (code: string | undefined, usageLimit: { resetsAt?: number } | undefined, resetsAt?: number): ProviderNativeLimit => ({
      events: [{ type: 'turn_failed', provider: 'test', error: 'Limited', ...(code ? { code } : {}) }],
      runtime: { providerId: 'test', sessionId: 's', status: 'idle', ...(usageLimit ? { usageLimit } : {}) }, ...(resetsAt === undefined ? {} : { resetsAt }) });
    expect(usageLimitFindings(limit('native_usage_limited', { resetsAt: 5 }, 5), typed)).toEqual([]);
    expect(usageLimitFindings(limit(undefined, { resetsAt: 5 }, 5), typed)).toHaveLength(1);
    expect(usageLimitFindings(limit('native_usage_limited', undefined, 5), typed)).toHaveLength(1);
    expect(usageLimitFindings(limit('native_usage_limited', { resetsAt: 6 }, 5), typed)).toHaveLength(1);
    expect(usageLimitFindings(undefined, typed)).toHaveLength(1);
    expect(usageLimitFindings(limit('native_usage_limited', {}), declared({ limits: { signal: 'event' } }))).toEqual(['failures.runtime: the adapter types native_usage_limited without declaring it']);
    expect(usageLimitFindings(undefined, declared({ limits: { signal: 'none' } }))).toEqual([]);
  });

  it('find a refusal of a second writer that is not typed with its declared reason (K6)', () => {
    const declaring = declared({ failures: { runtime: [], inUse: ['writer_elsewhere'] } });
    expect(writerElsewhereFindings(new AgentSessionInUseError('Busy.', { reason: 'writer_elsewhere' }), declaring)).toEqual([]);
    expect(writerElsewhereFindings(new AgentSessionInUseError('Busy.'), declaring)).toHaveLength(1);
    expect(writerElsewhereFindings(new Error('thread already has an active writer'), declaring)).toHaveLength(1);
    expect(writerElsewhereFindings(undefined, declared({}))).toEqual([]);
  });

  it('find an unknown event that became a row, one dropped silently, and one reported where the CLI sent none (K7)', () => {
    const turn = (rows: ProviderObservation[], diagnostics: string[], unknownSent: number): ProviderNativeTurn => ({ live: rows, reread: [], diagnostics, unknownSent });
    const known = [row('a', 't1')];
    const reported = unknownNativeEventLine('test', 'hologram', 'live');
    expect(unknownEventFindings('test', turn(known, [reported, 'another line'], 1), turn(known, [], 0))).toEqual([]);
    expect(unknownEventFindings('test', turn([...known, row('hologram', 't1', { type: 'error' })], [reported], 1), turn(known, [], 0))).toHaveLength(1);
    expect(unknownEventFindings('test', turn(known, [], 1), turn(known, [], 0))).toEqual(['unknown events: test reported 0 diagnostics for 1 events of a kind it does not know, so some were dropped silently']);
    expect(unknownEventFindings('test', turn(known, [reported], 1), turn(known, [reported], 0))).toHaveLength(1);
    expect(unknownEventFindings('test', turn(known, [], 0), turn(known, [], 0))).toEqual(['unknown events: the native fake sent no event of a kind the adapter does not know']);
  });
});
