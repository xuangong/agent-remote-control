import { describe, expect, it } from 'vitest';

import { createBrokerState } from './broker-state.js';
import { BrokerError, type Host, type RemoteHostBrokerState } from './broker-types.js';

const NOW = 1_000;
const host = (id: string): Host => ({ id, installationId: `installation-${id}`, name: id, providers: [], legacyDsh: false, generation: 1, pending: new Map(), streams: new Map() });
const saved = (extra: Partial<RemoteHostBrokerState> = {}): RemoteHostBrokerState => ({ keys: [], hosts: [], bindings: [], creations: [], ...extra });

function stateWith(options: { initialState?: RemoteHostBrokerState; onStateChange?: (state: RemoteHostBrokerState) => void | Promise<void> } = {}) {
  return createBrokerState({ initialState: options.initialState, now: () => NOW, ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}), keepsAssociations: false, keepsSharing: false });
}

describe('BrokerState loading', () => {
  it('drops a device key that expired and keeps one that has not', () => {
    const state = stateWith({ initialState: saved({ keys: [['old', { expires: NOW }], ['live', { expires: NOW + 1 }]] }) });
    expect([...state.keys.keys()]).toEqual(['live']);
  });

  it('loads a binding without its runtime generation as unattached, and keeps only creations whose binding exists', () => {
    const binding = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', agentId: 'a' };
    const state = stateWith({ initialState: saved({ bindings: [binding], creations: [['k1', { fingerprint: 'f', agentId: 'a' }], ['k2', { fingerprint: 'f', agentId: 'gone' }]] }) });
    expect(state.bindings.get('a')?.generation).toBe(-1);
    expect(state.nativeBindings.get(JSON.stringify(['h', 'codex', 'n']))).toBe(state.bindings.get('a'));
    expect([...state.completedCreations.keys()]).toEqual(['k1']);
  });

  it('drops the quiet timers an earlier Relay saved on a bot\'s inbox, and reads the chains they began as routines\'', () => {
    const bot = 'b_' + '1'.repeat(32), seat = { id: 'seat', hostId: 'h', providerId: 'claude', nativeSessionId: 'n', role: 'requester', name: 'Bot', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 };
    const team = { id: 'inbox', operationId: 'inbox', revision: 1, title: 'Bot inbox', status: 'active', createdAt: 1, updatedAt: 1, source: { hostId: 'h', providerId: 'claude', nativeSessionId: 'n', title: 'Bot' },
      messages: [], members: [seat], inbox: { botId: bot, timers: [{ name: 'Check in', intervalMs: 600_000, dueAt: 5 }] } };
    const chain = { id: 'c_' + '0'.repeat(16), cause: 'timer', bot, bots: [bot], messages: 1, turns: 0, created: 0, depth: 0, usage: { tokens: 0 }, startedAt: 1, updatedAt: 1 };
    const state = stateWith({ initialState: saved({ teams: [team as never], chains: [chain as never] }) });
    expect(state.teams[0]!.inbox).toEqual({ botId: bot });
    expect(state.chains).toEqual([expect.objectContaining({ cause: 'routine' })]);
  });

  it('refuses saved Teams that are not valid', () => {
    expect(() => stateWith({ initialState: saved({ teams: [{ id: 'not a team' } as never] }) })).toThrow('Invalid saved Teams.');
  });
});

describe('BrokerState commit', () => {
  it('publishes only after the save returned, and the stage saw the state before the change', async () => {
    const order: string[] = [];
    const state = stateWith({ onStateChange: async saved => { order.push(`save ${saved.keys.length}`); } });
    await state.commit(draft => {
      order.push(`stage ${draft.keys.length}`);
      draft.keys.push(['hash', { expires: 5_000 }]);
      return { value: 1, publish() { order.push('publish'); state.keys.set('hash', { expires: 5_000 }); } };
    });
    expect(order).toEqual(['stage 0', 'save 1', 'publish']);
    expect(state.snapshot().keys).toEqual([['hash', { expires: 5_000 }]]);
  });

  it('saves nothing for a stage that reports no change', async () => {
    let saves = 0;
    const state = stateWith({ onStateChange: () => { saves += 1; } });
    expect(await state.commit(() => ({ value: 'same', unchanged: true, publish() { throw new Error('not published'); } }))).toBe('same');
    expect(saves).toBe(0);
  });

  it('runs stages one at a time in the order they were asked for', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const state = stateWith({ onStateChange: async () => { await slow; } });
    const first = state.commit(() => ({ value: 1, publish() { order.push('first'); } }));
    const second = state.commit(() => { order.push('second staged'); return { value: 2, publish() { order.push('second'); } }; });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second staged', 'second']);
  });

  it('leaves the records as they were when a stage throws, and lets the next commit run', async () => {
    const state = stateWith();
    await expect(state.commit(() => { throw new BrokerError(409, 'conflict', 'No.'); })).rejects.toMatchObject({ code: 'conflict' });
    expect(await state.commit(() => ({ value: 'ok', publish() {} }))).toBe('ok');
  });

  it('fails closed when the save fails: the state is unavailable, the listeners run once, and no stage publishes', async () => {
    const state = stateWith({ onStateChange: () => { throw new Error('disk full'); } });
    let notified = 0;
    state.onUnavailable(() => { notified += 1; });
    await expect(state.commit(() => ({ value: 1, publish() { throw new Error('not published'); } }))).rejects.toThrow('disk full');
    expect(state.unavailable).toBe(true);
    expect(notified).toBe(1);
    await expect(state.commit(() => ({ value: 1, publish() {} }))).rejects.toMatchObject({ status: 503, code: 'state_unavailable' });
    state.failClosed();
    expect(notified).toBe(1);
  });

  it('closes without telling the listeners, which the shutdown runs itself', () => {
    const state = stateWith();
    let notified = 0;
    state.onUnavailable(() => { notified += 1; });
    state.close();
    expect(state.unavailable).toBe(true);
    expect(notified).toBe(0);
    expect(() => state.assertAvailable()).toThrow(BrokerError);
  });

  it('hands the next save the previous objects for what did not change, so they are not encoded again', async () => {
    const seen: RemoteHostBrokerState[] = [];
    const state = stateWith({ initialState: saved({ keys: [['hash', { expires: 5_000, installationId: 'i' }]] }), onStateChange: async next => { seen.push(next); } });
    await state.commit(draft => { draft.keys.push(['other', { expires: 6_000 }]); return { value: 0, publish() { state.keys.set('other', { expires: 6_000 }); } }; });
    await state.commit(draft => { draft.keys.push(['third', { expires: 7_000 }]); return { value: 0, publish() { state.keys.set('third', { expires: 7_000 }); } }; });
    expect(seen[1]!.keys[0]).toBe(seen[0]!.keys[0]);
    expect(seen[1]!.keys[1]).toBe(seen[0]!.keys[1]);
  });
});

describe('BrokerState Host checks', () => {
  it('refuses a Host that was replaced by another record or that reconnected since the caller began', () => {
    const state = stateWith();
    const current = host('a');
    state.hosts.set('a', current);
    expect(() => state.assertHostCurrent(current, 1)).not.toThrow();
    expect(() => state.assertHostCurrent(current, 2)).toThrow(expect.objectContaining({ status: 503, code: 'host_reconnected' }));
    expect(() => state.assertHostCurrent(host('a'))).toThrow(expect.objectContaining({ status: 401, code: 'host_revoked' }));
    state.hosts.delete('a');
    expect(() => state.assertHostCurrent(current)).toThrow(expect.objectContaining({ code: 'host_revoked' }));
  });

  it('saves a Host without its connection', () => {
    const state = stateWith();
    const connected = { ...host('a'), ready: true, tunnelToken: 'secret', outbox: 1 as const };
    state.hosts.set('a', connected);
    const [persisted] = state.snapshot().hosts;
    expect(persisted).toEqual({ outbox: 1, id: 'a', installationId: 'installation-a', name: 'a', providers: [], legacyDsh: false });
  });
});
