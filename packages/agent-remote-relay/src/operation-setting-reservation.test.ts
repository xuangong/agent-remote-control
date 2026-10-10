import { expect, test } from 'vitest';
import { createOperationCache, type MutationEntry, type NativeEffectReservation } from './operation-cache.js';

const descriptor = { operationId: '00000000-0000-4000-8000-000000000001', scope: 'owner', kind: 'set_session_setting', target: 'A', parameters: {} };

test('reserves the later native slot before accepting and rolls back partial intent capacity', async () => {
  const cache = createOperationCache({ maxEntries: 8, maxBytes: 4400, maxResultBytes: 64 });
  const disable = cache.enableMutationTarget('A'); let accepted = false;
  try {
    await expect(cache.execute(descriptor, { mutationTargets: ['A'], maximumResultBytes: 64, dispatch: async entry => {
      const release = entry.retainAsyncWork('A');
      try { entry.reserveNativeEffect('A'); accepted = true; } catch (error) { release(); throw error; }
    } })).rejects.toMatchObject({ code: 'mutation_evidence_capacity' });
    expect(accepted).toBe(false); expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { disable(); await cache.close(); }
}, 10000);

test('reuses one reserved native slot and preserves active evidence after intent termination', async () => {
  let now = 1000;
  const cache = createOperationCache({ maxEntries: 8, maxBytes: 8192, maxResultBytes: 64, ttlMs: 10, now: () => now });
  const disable = cache.enableMutationTarget('A'); let slot!: NativeEffectReservation; let entry!: MutationEntry; let release!: () => void;
  try {
    await cache.execute(descriptor, { mutationTargets: ['A'], maximumResultBytes: 64, dispatch: async current => {
      entry = current; release = entry.retainAsyncWork('A'); slot = entry.reserveNativeEffect('A'); return { accepted: true };
    } });
    for (let attempt = 0; attempt < 50; attempt++) { const call = slot.start(); call.settled(); }
    const current = slot.start();
    release(); slot.release(); now += 11;
    expect(cache.hasUnsettledMutation('A')).toBe(true);
    await expect(cache.execute(descriptor, { dispatch: async () => { throw new Error('must not replay'); } })).resolves.toEqual({ accepted: true });
    current.settled(); expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { disable(); await cache.close(); }
}, 10000);

test('a stale completion cannot settle a reused reserved slot', async () => {
  const cache = createOperationCache(); let slot!: NativeEffectReservation;
  try {
    await cache.execute(descriptor, { mutationTargets: ['A'], dispatch: async entry => { slot = entry.reserveNativeEffect('A'); } });
    const first = slot.start(); first.settled(); const second = slot.start();
    slot.release(); first.settled(); expect(cache.hasUnsettledMutation('A')).toBe(true);
    second.settled(); expect(cache.hasUnsettledMutation('A')).toBe(false);
  } finally { await cache.close(); }
}, 10000);

test('expired ordinary reservation never borrows or settles a same-key replacement entry', async () => {
  let now = 1000;
  const cache = createOperationCache({ ttlMs: 10, now: () => now });
  let original!: NativeEffectReservation, replacement!: NativeEffectReservation;
  try {
    await cache.execute(descriptor, { mutationTargets: ['A'], dispatch: async entry => { original = entry.reserveNativeEffect('A'); return { receipt: 'original' }; } });
    now += 11; expect(cache.hasUnsettledMutation('A')).toBe(false);
    const disable = cache.enableMutationTarget('B');
    const next = { ...descriptor, target: 'B' };
    try {
      await cache.execute(next, { mutationTargets: ['B'], dispatch: async entry => { replacement = entry.reserveNativeEffect('B'); return { receipt: 'replacement' }; } });
      const newer = replacement.start(); replacement.release();
      const older = original.start(); older.settled();
      const retried = original.start(); original.release(); older.settled(); older.unresolved(); retried.settled();
      expect(cache.hasUnsettledMutation('A')).toBe(false);
      expect(cache.hasUnsettledMutation('B')).toBe(true);
      now += 11;
      expect(await cache.execute(next, { dispatch: async () => { throw new Error('Replacement must stay retained'); } })).toEqual({ receipt: 'replacement' });
      newer.settled(); expect(cache.hasUnsettledMutation('B')).toBe(false);
    } finally { disable(); }
  } finally { await cache.close(); }
}, 10000);

test.each(['released', 'active', 'closed', 'enabled'] as const)('expired ordinary reservation still rejects when %s', async reason => {
  let now = 1000;
  const cache = createOperationCache({ ttlMs: 10, now: () => now });
  let slot!: NativeEffectReservation; let disable: (() => void) | undefined;
  try {
    await cache.execute(descriptor, { mutationTargets: ['A'], dispatch: async entry => { slot = entry.reserveNativeEffect('A'); } });
    const active = reason === 'active' ? slot.start() : undefined;
    now += 11; expect(cache.hasUnsettledMutation('A')).toBe(false);
    if (reason === 'released') slot.release();
    if (reason === 'closed') await cache.close();
    if (reason === 'enabled') disable = cache.enableMutationTarget('A');
    expect(() => slot.start()).toThrow(expect.objectContaining({ code: 'mutation_reservation_unavailable' }));
    active?.settled(); slot.release();
  } finally { disable?.(); await cache.close(); }
}, 10000);
