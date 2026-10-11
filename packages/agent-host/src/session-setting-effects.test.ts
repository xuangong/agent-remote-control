import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { AgentOperationRejectedError, type AgentSession, type AgentRuntimeInfo, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { AgentManager, createOperationCache, createOperationExecutor, type OperationCacheOptions, type SessionWireOperation } from '@orchardworks/agent-remote-relay';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';

const target = { controllerId: 'controller', providerId: 'fixture', nativeSessionId: 'A' };
const key = nativeSessionRefKey(target);
const operationId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(options: OperationCacheOptions = {}, preEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'arc-setting-effects-'));
  const contexts = new SessionSuccessionContextStore(root); await contexts.ready;
  let now = 1000;
  const cache = createOperationCache({ ttlMs: 100, now: () => now, ...options });
  const disable = preEnabled ? cache.enableMutationTarget(key) : () => {};
  const boundary = new SessionSuccessionBoundary(contexts, () => {}, () => undefined, cache);
  let stopped = false; let wake = gate(); let revision = 0;
  const observations: ProviderStreamItem[] = [];
  let value = 'first'; let read: () => Promise<void> = async () => {};
  let apply: NonNullable<AgentSession['setSessionSetting']> = async () => ({ status: 'pending' });
  const calls: Array<{ value: string; entry: string | undefined }> = [];
  const runtime = (): AgentRuntimeInfo => ({ providerId: 'fixture', sessionId: 'A', status: 'idle', settings: [
    { id: 'model', category: 'model', label: 'Model', value, mutable: true, scope: 'session',
      options: ['first', 'second', 'third'].map(value => ({ value, label: value })) },
  ] });
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, sessionSettings: true,
      interactions: { question: false, toolApproval: false, planApproval: false } },
    async runtimeInfo() { await read(); return runtime(); },
    async *observe(): AsyncIterable<ProviderStreamItem> {
      yield { type: 'history_boundary' };
      while (!stopped) {
        if (!observations.length) await wake.promise;
        wake = gate();
        while (observations.length) yield observations.shift()!;
      }
    },
    async setSessionSetting(id, selected) { calls.push({ value: selected, entry: boundary.currentEntry()?.key }); return apply(id, selected); },
    async sendMessage() {}, async respondToInteraction() {}, async dispose() { stopped = true; wake.resolve(); },
  };
  const manager = await AgentManager.attach({ agentId: 'A', provider: { providerId: 'fixture', displayName: 'Fixture' }, epoch: 'epoch',
    session: boundary.wrap(target, session), settingIntent: (_agent, accept) => boundary.settingIntent(target, accept) });
  await manager.ready;
  const entries = new Map<string, string>(); const admissionChecks: string[] = [];
  const execute = createOperationExecutor(cache, 'owner', {
    target: () => key, mutationTargets: () => [key], admission: (_agent, _operation, _scope, entry) => boundary.admit([target], entry.key),
    run: (_agent, operation, scope, entry, work) => { entries.set(operation.operationId, entry.key); return boundary.run(operation, scope, work, entry); },
    beforeDispatch: (_agent, operation) => { admissionChecks.push(operation.operationId); },
  });
  const setting = (selected: string, index: number, beforeDispatch = () => {}) => {
    const operation: SessionWireOperation = { operationId: operationId(index), kind: 'set_session_setting', parameters: { settingId: 'model', value: selected }, maximumResultBytes: 1024 };
    return execute(manager, operation, { beforeDispatch, dispatch: async () => { await manager.setSessionSetting('model', selected); return { accepted: true }; } });
  };
  return { cache, boundary, manager, calls, entries, admissionChecks, setting,
    disableSettings: () => { session.capabilities.sessionSettings = false; },
    value: (next: string) => { value = next; }, apply: (next: typeof apply) => { apply = next; }, read: (next: typeof read) => { read = next; },
    age: () => { now += 101; },
    async refresh() {
      observations.push({ type: 'observation', sourceKey: `runtime-${++revision}`, occurredAt: revision, delivery: 'live',
        event: { type: 'runtime_updated', provider: 'fixture', runtimeInfo: runtime() } });
      wake.resolve(); await vi.advanceTimersByTimeAsync(0);
    },
    async close() { await manager.close(); disable(); await boundary.close(); await cache.close(); await rm(root, { recursive: true, force: true }); },
  };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

test('each queued setting restores its own Host entry and Manager admission after disconnect', async () => {
  const f = await fixture(); const first = gate(), second = gate(); let connectionOpen = true;
  vi.useFakeTimers();
  try {
    f.apply(async (_id, value) => { await (value === 'second' ? first.promise : second.promise); f.value(value); });
    await f.setting('second', 1, () => { if (!connectionOpen) throw new Error('closed wire lease'); });
    await f.setting('third', 2, () => { if (!connectionOpen) throw new Error('closed wire lease'); });
    connectionOpen = false;
    const checked = f.admissionChecks.length;
    first.resolve(); await flush();
    expect(f.calls).toEqual([{ value: 'second', entry: f.entries.get(operationId(1)) }, { value: 'third', entry: f.entries.get(operationId(2)) }]);
    expect(f.admissionChecks.slice(checked)).toEqual([operationId(2)]);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ targetValue: 'third', status: 'pending' }]);
    second.resolve(); await flush();
    expect(f.manager.snapshot().payload.settingChanges).toEqual([]); expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { first.resolve(); second.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('a never-dispatched replacement releases its entry while old native completion preserves the newest target', async () => {
  const f = await fixture(); const first = gate(); vi.useFakeTimers();
  try {
    f.apply(async (_id, value) => { if (value === 'second') await first.promise; f.value(value); });
    await f.setting('second', 1); await f.setting('third', 2); await f.setting('first', 3);
    f.age();
    // The queued superseded operation follows normal TTL, proving its pin was released.
    await f.setting('third', 2);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ targetValue: 'third' }]);
    first.resolve(); await flush();
    expect(f.calls.map(call => call.value)).toEqual(['second', 'third']);
    expect(f.calls[1]?.entry).toBe(f.entries.get(operationId(2)));
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { first.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test.each(['timeout', 'close'] as const)('held native call retains evidence after %s and settles on its own late void completion', async end => {
  const f = await fixture(); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async () => held.promise);
    await f.setting('second', 1);
    if (end === 'timeout') await vi.advanceTimersByTimeAsync(30_001); else await f.manager.close();
    expect(f.cache.hasUnsettledMutation(key)).toBe(true); f.age();
    expect(await f.setting('second', 1)).toEqual({ accepted: true }); expect(f.calls).toHaveLength(1);
    held.resolve(); await flush();
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
    if (end === 'timeout') expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'timed_out', targetValue: 'second' }]);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('unconfirmed native pending survives matching UI confirmation, replacement, close and TTL', async () => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    await f.setting('second', 1); await flush();
    f.value('second'); await f.refresh();
    expect(f.manager.snapshot().payload.settingChanges).toEqual([]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    f.apply(async (_id, value) => { f.value(value); }); await f.setting('third', 2); await flush();
    await f.manager.close(); f.age();
    expect(await f.setting('second', 1)).toEqual({ accepted: true });
    expect(f.calls.map(call => call.value)).toEqual(['second', 'third']);
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test.each([false, true])('native rejection classification retains only uncertain effects: definite=%s', async definite => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    f.apply(async () => { if (definite) throw new AgentOperationRejectedError('native_rejected', 'No write submitted'); throw new Error('Native response lost'); });
    await f.setting('second', 1); await flush();
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'failed', confirmedValue: 'first' }]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(!definite);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('known void completion releases native evidence while readback failure leaves intent work until timeout', async () => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    f.apply(async () => {}); f.read(async () => { throw new Error('Readback failed'); });
    await f.setting('second', 1); await flush();
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'timed_out', confirmedValue: 'first' }]);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('deferred work releases on replacement and expiry without leaving a submitted effect', async () => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    f.apply(async () => ({ status: 'deferred' }));
    await f.setting('second', 1); await flush();
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    await f.setting('third', 2); await flush();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.calls.map(call => call.value)).toEqual(['second', 'third']);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('pin capacity rejects before visible acceptance and keeps the prior intent', async () => {
  const f = await fixture({ maxEntries: 8 }); vi.useFakeTimers();
  try {
    await f.setting('second', 1); await flush();
    const accepted = f.manager.snapshot().payload.settingChanges;
    await expect(f.setting('third', 2)).rejects.toMatchObject({ code: 'mutation_evidence_capacity' });
    expect(f.manager.snapshot().payload.settingChanges).toEqual(accepted);
    expect(f.calls.map(call => call.value)).toEqual(['second']);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('first Host admission pins its target while a generic target in the same cache retains normal TTL', async () => {
  const f = await fixture({}, false); vi.useFakeTimers();
  try {
    await expect(f.manager.setSessionSetting('model', 'invalid')).rejects.toThrow();
    expect(f.cache.hasUnsettledMutation(key)).toBe(false); expect(f.calls).toEqual([]);
    await f.cache.execute({ operationId: operationId(99), scope: 'generic', kind: 'native', target: 'generic', parameters: {} }, {
      mutationTargets: ['generic'], dispatch: async entry => { entry.startNativeEffect('generic').unresolved(); },
    });
    await f.setting('second', 1); await flush();
    expect(f.cache.hasUnsettledMutation('generic')).toBe(true);
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    f.age();
    expect(f.cache.hasUnsettledMutation('generic')).toBe(false);
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    expect(() => f.boundary.checkSource(target)).toThrow('Session has unsettled Host mutations.');
    expect(await f.setting('second', 1)).toEqual({ accepted: true });
    expect(f.calls).toEqual([{ value: 'second', entry: f.entries.get(operationId(1)) }]);
    expect(f.entries.size).toBe(1);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'pending' }]);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('deferred retries reuse bounded capacity and the accepted context on native readiness observations', async () => {
  const f = await fixture({ maxEntries: 8, maxBytes: 16_384 }); vi.useFakeTimers();
  try {
    f.apply(async () => ({ status: 'deferred' }));
    await f.setting('second', 1); await flush();
    for (let attempt = 0; attempt < 25; attempt++) await f.refresh();
    expect(f.calls).toHaveLength(26);
    expect(new Set(f.calls.map(call => call.entry))).toEqual(new Set([f.entries.get(operationId(1))]));
    f.apply(async (_id, selected) => { f.value(selected); });
    await f.refresh();
    expect(f.manager.snapshot().payload.settingChanges).toEqual([]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { await f.close(); vi.useRealTimers(); }
}, 10000);

test('close cancels queued and deferred work without borrowing an older in-flight call', async () => {
  const f = await fixture(); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async () => held.promise);
    await f.setting('second', 1); await f.setting('third', 2);
    await f.manager.close(); held.resolve(); await flush();
    expect(f.calls.map(call => call.value)).toEqual(['second']);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('late old pending return cannot clear replacement work or confirm its matching baseline', async () => {
  const f = await fixture(); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async (_id, selected) => { if (selected === 'second') await held.promise; return { status: 'pending' }; });
    await f.setting('second', 1); await f.setting('first', 2);
    held.resolve(); await flush();
    expect(f.calls.map(call => call.value)).toEqual(['second', 'first']);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'pending', targetValue: 'first' }]);
    await vi.advanceTimersByTimeAsync(30_001); await f.manager.close(); f.age();
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    expect(await f.setting('second', 1)).toEqual({ accepted: true });
    expect(await f.setting('first', 2)).toEqual({ accepted: true });
    expect(f.calls).toHaveLength(2);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('one actual call fits one reserved native slot while readback hangs after known void completion', async () => {
  const f = await fixture({ maxEntries: 8, maxBytes: 12_480 }); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async () => {}); f.read(async () => held.promise);
    expect(await f.setting('second', 1)).toEqual({ accepted: true }); await flush();
    expect(f.calls.map(call => call.value)).toEqual(['second']);
    expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('queued setting revalidates native capability before calling the provider', async () => {
  const f = await fixture(); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async (_id, value) => { if (value === 'second') await held.promise; });
    await f.setting('second', 1); await f.setting('third', 2);
    f.disableSettings(); held.resolve(); await flush();
    expect(f.calls.map(call => call.value)).toEqual(['second']);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ status: 'failed', targetValue: 'third' }]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('Host deferred intent survives receipt TTL under its original admission without reaccepting', async () => {
  const f = await fixture({}, false); vi.useFakeTimers();
  const acceptedRequests = new Set<string>();
  const unsubscribe = f.manager.subscribe(() => {
    for (const change of f.manager.snapshot().payload.settingChanges ?? []) acceptedRequests.add(change.requestId);
  });
  try {
    f.apply(async (_id, selected) => { if (f.calls.length === 1) return { status: 'deferred' }; f.value(selected); });
    await f.setting('second', 1); await flush();
    const accepted = f.manager.snapshot().payload.settingChanges?.[0]?.requestId;
    f.age(); expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    expect(() => f.boundary.checkSource(target)).toThrow('Session has unsettled Host mutations.');
    expect(await f.setting('second', 1)).toEqual({ accepted: true });
    expect(f.calls).toEqual([{ value: 'second', entry: f.entries.get(operationId(1)) }]);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ requestId: accepted, status: 'pending' }]);
    await f.refresh();
    expect(f.calls).toEqual([
      { value: 'second', entry: f.entries.get(operationId(1)) },
      { value: 'second', entry: f.entries.get(operationId(1)) },
    ]);
    expect(f.entries.size).toBe(1);
    expect(acceptedRequests).toEqual(new Set([accepted]));
    expect(f.manager.snapshot().payload.settingChanges).toEqual([]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { unsubscribe(); await f.close(); vi.useRealTimers(); }
}, 10000);

test('Host queued intent retains its original operation context past receipt TTL', async () => {
  const f = await fixture({}, false); const held = gate(); vi.useFakeTimers();
  try {
    f.apply(async (_id, selected) => { if (selected === 'second') await held.promise; f.value(selected); });
    await f.setting('second', 1); await f.setting('third', 2);
    const accepted = f.manager.snapshot().payload.settingChanges?.[0]?.requestId;
    f.age(); expect(f.cache.hasUnsettledMutation(key)).toBe(true);
    expect(() => f.boundary.checkSource(target)).toThrow('Session has unsettled Host mutations.');
    expect(await f.setting('second', 1)).toEqual({ accepted: true });
    expect(await f.setting('third', 2)).toEqual({ accepted: true });
    expect(f.calls).toEqual([{ value: 'second', entry: f.entries.get(operationId(1)) }]);
    expect(f.manager.snapshot().payload.settingChanges).toMatchObject([{ requestId: accepted, targetValue: 'third', status: 'pending' }]);
    held.resolve(); await flush();
    expect(f.calls).toEqual([
      { value: 'second', entry: f.entries.get(operationId(1)) },
      { value: 'third', entry: f.entries.get(operationId(2)) },
    ]);
    expect(f.entries.size).toBe(2);
    expect(f.manager.snapshot().payload.settingChanges).toEqual([]);
    expect(f.cache.hasUnsettledMutation(key)).toBe(false);
  } finally { held.resolve(); await f.close(); vi.useRealTimers(); }
}, 10000);
