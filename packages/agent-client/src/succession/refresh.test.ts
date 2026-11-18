import { describe, expect, it } from 'vitest';
import { classifyFailure, initialRefreshState, maxSupersededRetries, supersededCodes, reduceRefresh, staleRetryDelays, type RefreshEvent, type RefreshState } from './refresh.js';

const failed = (over: Partial<Extract<RefreshEvent, { type: 'discovery_failed' }>> = {}): RefreshEvent => ({
  type: 'discovery_failed', failure: { kind: 'unreachable', message: 'offline' }, notified: false, replayRead: false,
  hasConfirmedEvidence: true, hasDesired: true, hasRoles: true, invalidView: false, ...over,
});
const run = (events: RefreshEvent[], from: RefreshState = initialRefreshState) => events.reduce((state, event) => reduceRefresh(state, event).state, from);
const effectsOf = (event: RefreshEvent, from: RefreshState = initialRefreshState) => reduceRefresh(from, event).effects;

describe('classifyFailure', () => {
  it.each([
    ['a network error', Object.assign(new Error('x'), { code: 'network_error' }), true, 'unreachable'],
    ['an offline browser', new Error('x'), false, 'unreachable'],
    ['a timeout while offline', new DOMException('slow', 'TimeoutError'), false, 'timeout'],
    ['a timeout while online', new DOMException('slow', 'TimeoutError'), true, 'timeout'],
    ['a Relay answer', Object.assign(new Error('x'), { code: 'http_500' }), true, 'other'],
    ['an offline answer with no browser information', new Error('x'), undefined, 'other'],
    ['a value that is not an error', 'text', true, 'other'],
  ])('reads %s', (_name, error, online, kind) => {
    expect(classifyFailure(error, online).kind).toBe(kind);
  });
  it('keeps the code and the message', () => {
    expect(classifyFailure(Object.assign(new Error('gone'), { code: 'http_404' }), true)).toEqual({ kind: 'other', code: 'http_404', message: 'gone' });
  });
});

describe('reduceRefresh', () => {
  it('confirms evidence on success, resets the backoff and cancels a waiting retry', () => {
    const stale = { ...initialRefreshState, evidenceStale: true, staleAttempts: 3 };
    const result = reduceRefresh(stale, { type: 'discovery_succeeded' });
    expect(result.state).toEqual({ discovered: true, evidenceStale: false, staleAttempts: 0, unsupported: false, supersededAttempts: 0 });
    expect(result.effects).toEqual([{ type: 'cancel_stale_retry' }]);
  });
  it('restores the confirmed evidence as stale when the Relay is unreachable after a success, and retries with growing delays', () => {
    const delays: number[] = [];
    let state = run([{ type: 'discovery_succeeded' }]);
    for (let attempt = 0; attempt < 7; attempt++) {
      const result = reduceRefresh(state, failed());
      state = result.state;
      expect(result.effects.slice(0, 2)).toEqual([{ type: 'restore_confirmed_evidence' }, { type: 'cancel_stale_retry' }]);
      delays.push((result.effects[2] as { delayMs: number }).delayMs);
      expect(state).toMatchObject({ discovered: true, evidenceStale: true });
    }
    expect(delays).toEqual([1000, 2000, 5000, 10000, 30000, 30000, 30000]);
    expect(staleRetryDelays).toEqual(delays.slice(0, 5));
  });
  it('retries with the delays it is given, repeating the last one, instead of the defaults', () => {
    let state = run([{ type: 'discovery_succeeded' }]);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = reduceRefresh(state, failed(), [10, 20]);
      state = result.state;
      delays.push((result.effects[2] as { delayMs: number }).delayMs);
    }
    expect(delays).toEqual([10, 20, 20, 20]);
  });
  it.each([
    ['a timeout', { failure: { kind: 'timeout' as const, message: 'slow' } }],
    ['a Relay answer', { failure: { kind: 'other' as const, code: 'http_500', message: 'broken' } }],
    ['a notification that locators changed', { notified: true }],
    ['a failure after the replays were read', { replayRead: true }],
    ['no earlier confirmed evidence', { hasConfirmedEvidence: false }],
  ])('does not fall back to old locators after %s', (_name, over) => {
    const result = reduceRefresh(initialRefreshState, failed(over));
    expect(result.state.evidenceStale).toBe(false);
    expect(result.effects).toEqual([{ type: 'report_failure', message: (over as { failure?: { message: string } }).failure?.message ?? 'offline', keepResult: false }]);
  });
  it.each(['http_404', 'route_not_found'])('treats %s with nothing desired and no role as a Relay without succession, and asks once more', code => {
    const result = reduceRefresh(initialRefreshState, failed({ failure: { kind: 'other', code, message: 'no route' }, hasDesired: false, hasRoles: false }));
    expect(result.state.unsupported).toBe(true);
    expect(result.effects).toEqual([{ type: 'rediscover' }]);
  });
  it.each([
    ['something is desired', { hasDesired: true, hasRoles: false }],
    ['a role exists', { hasDesired: false, hasRoles: true }],
  ])('keeps a missing route an error when %s', (_name, over) => {
    const result = reduceRefresh(initialRefreshState, failed({ failure: { kind: 'other', code: 'route_not_found', message: 'no route' }, ...over }));
    expect(result.state.unsupported).toBe(false);
    expect(result.effects[0]).toMatchObject({ type: 'report_failure' });
  });
  it('does not mistake a hidden succession for a missing route', () => {
    expect(reduceRefresh(initialRefreshState, failed({ failure: { kind: 'other', code: 'http_403', message: 'hidden' }, hasDesired: false, hasRoles: false })).state.unsupported).toBe(false);
  });
  it('words an error without a message, and keeps an invalid view discovered with its own result', () => {
    const result = reduceRefresh(initialRefreshState, failed({ failure: { kind: 'other' }, invalidView: true }));
    expect(result.state.discovered).toBe(true);
    expect(result.effects).toEqual([{ type: 'report_failure', message: 'Session succession could not be recovered.', keepResult: true }]);
  });
  it('retries only while the evidence is still stale when the timer fires', () => {
    expect(effectsOf({ type: 'stale_retry_due', evidenceStale: true })).toEqual([{ type: 'rediscover' }]);
    expect(effectsOf({ type: 'stale_retry_due', evidenceStale: false })).toEqual([]);
  });
  it('discards what another authority confirmed', () => {
    const state = run([{ type: 'discovery_succeeded' }, failed(), failed()]);
    const result = reduceRefresh(state, { type: 'authority_changed' });
    expect(result.state).toEqual({ discovered: false, evidenceStale: false, staleAttempts: 0, unsupported: false, supersededAttempts: 0 });
    expect(result.effects).toEqual([{ type: 'cancel_stale_retry' }]);
  });
  it('starts the backoff over after a success', () => {
    const state = run([failed(), failed(), { type: 'discovery_succeeded' }, failed()]);
    expect(state.staleAttempts).toBe(1);
  });

  describe('a composition that an edit overtook', () => {
    const pending = (code: string): RefreshEvent => ({ type: 'composition_pending', code });
    it.each(supersededCodes)('discovers again after %s', code => {
      expect(effectsOf(pending(code))).toEqual([{ type: 'rediscover' }]);
      expect(run([pending(code)]).supersededAttempts).toBe(1);
    });
    it.each(['authorization', 'replay_gap', 'older_revision', 'track_write', 'invalid_view'])('leaves %s to the explicit Retry', code => {
      expect(effectsOf(pending(code))).toEqual([]);
      expect(run([pending(code)]).supersededAttempts).toBe(0);
    });
    it('stops after the bound and starts over when a composition is applied', () => {
      const bounded = run(Array.from({ length: maxSupersededRetries }, () => pending('retired')));
      expect(bounded.supersededAttempts).toBe(maxSupersededRetries);
      expect(effectsOf(pending('retired'), bounded)).toEqual([]);
      expect(run([{ type: 'composition_applied' }], bounded).supersededAttempts).toBe(0);
      expect(effectsOf(pending('retired'), run([{ type: 'composition_applied' }], bounded))).toEqual([{ type: 'rediscover' }]);
    });
  });
});
