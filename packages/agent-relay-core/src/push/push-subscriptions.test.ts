// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PUSH_DEVICE_LIMIT } from '@orchardworks/agent-remote-protocol';
import { decodeHostedSnapshot, encodeHostedSnapshot } from '../record-codec.js';
import { createRelayState, emptyRelayState, MAX_PUSH_SUBSCRIPTIONS, validateRelayState, type HostedRelayState } from '../state.js';
import { createPushSubscriptions, deviceSubscription, PushSubscriptionsError } from './push-subscriptions.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'push-subscription-test-secret-0123456789' };
/** The state through its stored records and back, as a restart reads it. */
function restored(value: HostedRelayState): HostedRelayState {
  const records = [...encodeHostedSnapshot(value, auth).records.values()];
  return decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
}
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const request = (endpoint: string, extra: Record<string, unknown> = {}) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${endpoint}`, keys: KEYS, locale: 'en', ...extra });

function fixture(initial?: HostedRelayState) {
  let saved: HostedRelayState | undefined, clock = 1_000;
  const start = initial ?? emptyRelayState(auth);
  for (const subject of ['alice', 'bob']) if (!start.tenants.some(tenant => tenant.subject === subject)) start.tenants.push({ subject,
    namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'), broker: { keys: [], hosts: [], bindings: [], creations: [] } });
  const state = createRelayState(auth, { initial: start, async commit(value) { saved = structuredClone(value); } }, () => {}, () => {});
  const store = createPushSubscriptions(state, { now: () => clock, accepts: endpoint => endpoint.startsWith('https://fcm.googleapis.com/') });
  return { state, store, saved: () => saved!, advance: (ms: number) => { clock += ms; } };
}

describe('a device\'s subscription', () => {
  it('is kept per account and device, replaced by the device\'s next one, and told back without its keys', async () => {
    const f = fixture();
    const first = await f.store.save('alice', 'browser-1', request('a'));
    expect(first).toMatchObject({ subject: 'alice', device: 'browser-1', locale: 'en', createdAt: 1_000, updatedAt: 1_000 });
    f.advance(50);
    await f.store.save('alice', 'browser-1', request('b', { locale: 'zh', paused: true }));
    expect(f.store.list('alice').map(deviceSubscription)).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/b', locale: 'zh', paused: true }]);
    expect(f.store.device('alice', 'browser-1')).toMatchObject({ createdAt: 1_000, updatedAt: 1_050 });
    expect(f.saved().pushSubscriptions).toHaveLength(1);
  });

  it('belongs to one account: a browser that subscribes for another account takes its endpoint over', async () => {
    const f = fixture();
    await f.store.save('alice', 'browser-1', request('shared'));
    await f.store.save('bob', 'browser-1', request('shared'));
    expect(f.store.list('alice')).toEqual([]);
    expect(f.store.subjects()).toEqual(['bob']);
  });

  it('keeps an account\'s last devices, replacing the least recently updated', async () => {
    const f = fixture();
    for (let index = 0; index < PUSH_DEVICE_LIMIT; index += 1) { await f.store.save('alice', `device-${index}`, request(`e${index}`)); f.advance(1); }
    await f.store.save('alice', 'device-new', request('new'));
    expect(f.store.list('alice').map(item => item.device)).not.toContain('device-0');
    expect(f.store.list('alice')).toHaveLength(PUSH_DEVICE_LIMIT);
  });

  it('refuses a request that is no subscription, or an endpoint that is not a push service the Relay sends to', async () => {
    const f = fixture();
    await expect(f.store.save('alice', 'browser-1', { endpoint: 'x' })).rejects.toMatchObject({ status: 400, code: 'invalid_push_subscription' });
    await expect(f.store.save('alice', 'browser-1', { ...request('a'), endpoint: 'https://169.254.169.254/latest/meta-data' })).rejects.toMatchObject({ status: 400, code: 'push_service_refused' });
    expect(f.store.list('alice')).toEqual([]);
  });

  it('refuses a new subscription past the Relay\'s bound', async () => {
    const initial = emptyRelayState(auth);
    initial.pushSubscriptions = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS }, (_, index) => ({ ...request(`full-${index}`), locale: 'en' as const, subject: `user-${index}`, device: 'd', createdAt: 1, updatedAt: 1 }));
    const f = fixture(initial);
    await expect(f.store.save('alice', 'browser-1', request('one-more'))).rejects.toBeInstanceOf(PushSubscriptionsError);
  });
});

describe('forgetting', () => {
  it('forgets a device, an endpoint a push service ended, or every device of an account', async () => {
    const f = fixture();
    await f.store.save('alice', 'phone', request('phone'));
    await f.store.save('alice', 'desk', request('desk'));
    await f.store.save('alice', 'tablet', request('tablet'));
    await f.store.save('bob', 'laptop', request('laptop'));
    expect(await f.store.remove('alice', 'phone')).toBe(true);
    expect(await f.store.remove('alice', 'phone')).toBe(false);
    await f.store.forgetEndpoint('https://fcm.googleapis.com/fcm/send/desk');
    expect(f.store.list('alice').map(item => item.device)).toEqual(['tablet']);
    await f.store.forgetDevices('alice', ['tablet']);
    expect(f.store.list('alice')).toEqual([]);
    await f.store.forgetDevices('bob');
    expect(f.store.subjects()).toEqual([]);
  });
});

describe('in the Relay state', () => {
  it('survives the state\'s encoding, and the state refuses a subscription of the wrong shape or one endpoint twice', async () => {
    const f = fixture();
    await f.store.save('alice', 'browser-1', request('a'));
    expect(restored(f.saved()).pushSubscriptions).toEqual(f.saved().pushSubscriptions);
    const valid = f.saved();
    expect(() => validateRelayState({ ...valid, pushSubscriptions: [{ ...valid.pushSubscriptions![0], keys: { p256dh: 'x', auth: 'y' } }] }, auth)).toThrow();
    expect(() => validateRelayState({ ...valid, pushSubscriptions: [valid.pushSubscriptions![0], { ...valid.pushSubscriptions![0], device: 'browser-2' }] }, auth)).toThrow();
  });

  it('keeps a header field this build does not know, as an older Worker keeps the subscriptions it does not know', async () => {
    const f = fixture();
    const later = { ...f.state.read(), futureField: [{ device: 'x' }] } as HostedRelayState;
    expect((restored(later) as HostedRelayState & { futureField?: unknown }).futureField).toEqual([{ device: 'x' }]);
  });
});
