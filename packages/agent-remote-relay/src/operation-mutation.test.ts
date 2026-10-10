import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createOperationCache, OperationCacheError, type MutationEntry, type NativeEffectHandle } from './operation-cache.js';

const descriptor = () => ({ operationId: randomUUID(), scope: 'test', kind: 'send_message', target: 'A', parameters: {} });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('fresh admission covers validation and final publication; duplicates never re-admit', async () => {
  const cache = createOperationCache(); const wait = deferred(); const op = descriptor(); let admissions = 0, active = 0;
  const work = { mutationTargets: ['A'], admit: () => { admissions++; active++; return () => { active--; }; }, validate: () => wait.promise, dispatch: async () => ({ accepted: true }) };
  try {
    const first = cache.execute(op, work), duplicate = cache.execute(op, work);
    expect(active).toBe(1); expect(cache.hasUnsettledMutation('A')).toBe(true);
    wait.resolve(); await Promise.all([first, duplicate]);
    expect(active).toBe(0); expect(cache.hasUnsettledMutation('A')).toBe(false);
    await cache.execute(op, work); expect(admissions).toBe(1);
  } finally { wait.resolve(); await cache.close(); }
}, 10000);

test('validation rejection releases admission and never starts a native effect', async () => {
  const cache = createOperationCache(); let active = 0, calls = 0;
  try {
    await expect(cache.execute(descriptor(), { mutationTargets: ['A'], admit: () => { active++; return () => { active--; }; },
      validate: () => { throw new OperationCacheError('invalid', 'Invalid input.'); }, dispatch: async () => { calls++; } })).rejects.toMatchObject({ code: 'invalid' });
    expect(active).toBe(0); expect(calls).toBe(0); expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { await cache.close(); }
}, 10000);

test('native completion settles effects even when local receipt encoding fails', async () => {
  const cache = createOperationCache();
  try {
    await expect(cache.execute(descriptor(), { mutationTargets: ['A'], dispatch: async entry => {
      entry.startNativeEffect('A').settled(); return { invalid: 1n };
    } })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { await cache.close(); }
}, 10000);

test('ordinary unresolved effects expire, opted-in pins survive TTL until explicit settlement', async () => {
  let now = 100; const cache = createOperationCache({ ttlMs: 10, now: () => now }); let effect!: NativeEffectHandle;
  try {
    await cache.execute(descriptor(), { mutationTargets: ['ordinary'], dispatch: async entry => { entry.startNativeEffect('ordinary').unresolved(); } });
    expect(cache.hasUnsettledMutation('ordinary')).toBe(true); now += 11; expect(cache.hasUnsettledMutation('ordinary')).toBe(false);
    const disable = cache.enableMutationTarget('A'); const op = descriptor(); let calls = 0;
    await cache.execute(op, { mutationTargets: ['A'], dispatch: async entry => { calls++; effect = entry.startNativeEffect('A'); effect.unresolved(); } });
    disable(); now += 11; expect(cache.hasUnsettledMutation('A')).toBe(true);
    await cache.execute(op, { dispatch: async () => { calls++; } }); expect(calls).toBe(1);
    effect.settled(); expect(cache.hasUnsettledMutation('A')).toBe(false);
    await cache.close(); expect(cache.hasUnsettledMutation('A')).toBe(false); effect.settled();
  } finally { await cache.close(); }
}, 10000);

test('async handles retain the same entry after acceptance and count one pin for multiple handles', async () => {
  const cache = createOperationCache({ maxEntries: 8, maxBytes: 8192 }); cache.enableMutationTarget('A');
  let entry!: MutationEntry; let release!: () => void;
  try {
    await cache.execute(descriptor(), { maximumResultBytes: 64, mutationTargets: ['A'], dispatch: async value => { entry = value; release = entry.retainAsyncWork('A'); return { accepted: true }; } });
    const effect = entry.startNativeEffect('A'); release(); expect(cache.hasUnsettledMutation('A')).toBe(true);
    effect.settled(); expect(cache.hasUnsettledMutation('A')).toBe(false);
    await cache.execute(descriptor(), { maximumResultBytes: 64, mutationTargets: ['A'], dispatch: async value => { value.startNativeEffect('A').settled(); } });
  } finally { await cache.close(); }
}, 10000);

test('pin quota rejects second opted-in effect before native work while preserving ordinary headroom', async () => {
  const cache = createOperationCache({ maxEntries: 8, maxBytes: 8192 }); cache.enableMutationTarget('A'); let calls = 0;
  try {
    const work = { maximumResultBytes: 64, mutationTargets: ['A'], dispatch: async (entry: MutationEntry) => { entry.startNativeEffect('A').unresolved(); calls++; } };
    await cache.execute(descriptor(), work);
    await expect(cache.execute(descriptor(), work)).rejects.toMatchObject({ code: 'mutation_evidence_capacity' });
    expect(calls).toBe(1);
    await expect(cache.execute(descriptor(), { maximumResultBytes: 64, dispatch: async () => 'ordinary' })).resolves.toBe('ordinary');
  } finally { await cache.close(); }
}, 10000);

test.each(['native', 'async'] as const)('ordinary-target %s handles on a pinned entry obey the pin byte budget', async kind => {
  const cache = createOperationCache({ maxEntries: 8, maxBytes: 8192 }); cache.enableMutationTarget('A');
  let entry!: MutationEntry; let effects = 0; let rejected: unknown;
  try {
    await cache.execute(descriptor(), { maximumResultBytes: 64, mutationTargets: ['A', 'C'], dispatch: async value => {
      entry = value; entry.startNativeEffect('A').unresolved();
    } });
    for (let index = 0; index < 16; index++) {
      try {
        if (kind === 'native') entry.startNativeEffect('C'); else entry.retainAsyncWork('C');
        effects++;
      } catch (error) { rejected = error; break; }
    }
    expect(rejected).toMatchObject({ code: 'mutation_evidence_capacity' });
    expect(effects).toBeGreaterThan(0); expect(effects).toBeLessThan(16);
    expect(cache.hasUnsettledMutation('A')).toBe(true);
    await expect(cache.execute(descriptor(), { maximumResultBytes: 1024, mutationTargets: ['C'], dispatch: async ordinary => {
      ordinary.startNativeEffect('C').settled(); return 'ordinary';
    } })).resolves.toBe('ordinary');
  } finally { await cache.close(); }
}, 10000);

test.each([{ maxEntries: 7, maximumResultBytes: 64 }, { maxEntries: 8, maximumResultBytes: 800 }])('zero allowance and oversized pins reject before effects: %j', async config => {
  const cache = createOperationCache({ maxEntries: config.maxEntries, maxBytes: 8192 }); cache.enableMutationTarget('A'); let calls = 0;
  try {
    await expect(cache.execute(descriptor(), { maximumResultBytes: config.maximumResultBytes, mutationTargets: ['A'], dispatch: async entry => { entry.startNativeEffect('A'); calls++; } })).rejects.toMatchObject({ code: 'mutation_evidence_capacity' });
    expect(calls).toBe(0);
  } finally { await cache.close(); }
}, 10000);

test('native uncertainty survives TTL and exact effect settlement never rewrites the unknown receipt', async () => {
  let now = 100; const cache = createOperationCache({ ttlMs: 10, now: () => now }); cache.enableMutationTarget('A');
  let effect!: NativeEffectHandle; let calls = 0; const op = descriptor();
  const work = { mutationTargets: ['A'], dispatch: async (entry: MutationEntry) => { effect = entry.startNativeEffect('A'); calls++; effect.unresolved(); throw new Error('Native reply lost'); } };
  try {
    await expect(cache.execute(op, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    now += 11;
    await expect(cache.execute(op, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' }); expect(calls).toBe(1);
    effect.settled(); expect(cache.hasUnsettledMutation('A')).toBe(false);
    const recent = descriptor();
    await expect(cache.execute(recent, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    effect.settled();
    await expect(cache.execute(recent, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' }); expect(calls).toBe(2);
  } finally { await cache.close(); }
}, 10000);

test('admission remains held during local receipt encoding and releases after its failure', async () => {
  const cache = createOperationCache(); let active = false, encodingActive = false, encodingUnsettled = false;
  try {
    await expect(cache.execute(descriptor(), { mutationTargets: ['A'], admit: () => { active = true; return () => { active = false; }; },
      dispatch: async entry => { entry.startNativeEffect('A').settled(); return { toJSON() { encodingActive = active; encodingUnsettled = cache.hasUnsettledMutation('A'); throw new Error('Local encoding failed'); } }; },
    })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(encodingActive).toBe(true); expect(encodingUnsettled).toBe(true);
    expect(active).toBe(false); expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { await cache.close(); }
}, 10000);
