// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { createPushSender, isBrowserPushService, retryAfterMs, RETRY_LIMIT_MS, type PushMessage } from './push-sender.js';
import { generateVapidKeys, type VapidKeys } from './web-push.js';

// The sender against a scripted push service port: what it sends and what it makes of each answer. The seam test S8 runs it against
// the push service simulator, which checks the token and decrypts the payload.
const BROWSER = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const TARGET = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: BROWSER };
const MESSAGE: PushMessage = { payload: '{"kind":"needs_you"}', topic: 'chief', ttlSeconds: 86_400, urgency: 'high' };
let vapid: VapidKeys;
beforeAll(async () => { vapid = await generateVapidKeys(); });

function sender(answers: Array<number | [number, Record<string, string>] | 'offline'>, now = () => Date.parse('2026-11-22T12:00:00Z')) {
  const requests: Request[] = [], waits: number[] = [], forgotten: string[] = [];
  const push = createPushSender({ vapid: { ...vapid, subject: 'https://agents.example' }, now, wait: async ms => { waits.push(ms); },
    forget: endpoint => { forgotten.push(endpoint); },
    post: async request => {
      requests.push(request);
      const answer = answers.shift() ?? 201;
      if (answer === 'offline') throw new TypeError('fetch failed');
      const [status, headers] = Array.isArray(answer) ? answer : [answer, {}];
      return new Response(null, { status, headers });
    } });
  return { push, requests, waits, forgotten };
}

describe('a push', () => {
  it('is a POST of the encrypted payload with the authorization, TTL, Urgency and Topic', async () => {
    const { push, requests } = sender([201]);
    expect(await push.deliver(TARGET, MESSAGE)).toEqual({ status: 'sent' });
    const [request] = requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe(TARGET.endpoint);
    expect(Object.fromEntries(['content-encoding', 'content-type', 'ttl', 'urgency', 'topic'].map(name => [name, request!.headers.get(name)]))).toEqual({
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', topic: 'chief' });
    expect(request!.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    expect((await request!.arrayBuffer()).byteLength).toBe(86 + MESSAGE.payload.length + 1 + 16);
  });

  it('reuses the token for one push service until an hour before it expires', async () => {
    let now = Date.parse('2026-11-22T12:00:00Z');
    const { push, requests } = sender([], () => now);
    await push.deliver(TARGET, MESSAGE);
    await push.deliver({ ...TARGET, endpoint: 'https://fcm.googleapis.com/fcm/send/device-2' }, MESSAGE);
    await push.deliver({ ...TARGET, endpoint: 'https://web.push.apple.com/QGuQyavXutnMsC' }, MESSAGE);
    now += 11.5 * 3600_000;
    await push.deliver(TARGET, MESSAGE);
    const tokens = requests.map(request => request.headers.get('authorization'));
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
    expect(tokens[3]).not.toBe(tokens[0]);
  });
});

describe('what the sender makes of the answer', () => {
  it.each([404, 410] as const)('%i: the subscription ended, and the sender forgets it', async code => {
    const { push, forgotten } = sender([code]);
    expect(await push.deliver(TARGET, MESSAGE)).toEqual({ status: 'gone', code });
    expect(forgotten).toEqual([TARGET.endpoint]);
  });

  it('429: waits as long as Retry-After asks and tries once more', async () => {
    const { push, waits, requests } = sender([[429, { 'retry-after': '20' }], 201]);
    expect(await push.deliver(TARGET, MESSAGE)).toEqual({ status: 'sent' });
    expect(waits).toEqual([20_000]);
    expect(requests).toHaveLength(2);
  });

  it('a busy or unreachable service twice fails the push; a wait over the limit is not taken', async () => {
    expect(await sender([503, 503]).push.deliver(TARGET, MESSAGE)).toEqual({ status: 'failed', code: 503 });
    expect(await sender(['offline', 'offline']).push.deliver(TARGET, MESSAGE)).toEqual({ status: 'failed' });
    const patient = sender([[429, { 'retry-after': String(RETRY_LIMIT_MS / 1000 + 1) }]]);
    expect(await patient.push.deliver(TARGET, MESSAGE)).toEqual({ status: 'failed', code: 429 });
    expect(patient.waits).toEqual([]);
  });

  it.each([[400, 'refused'], [401, 'refused'], [403, 'refused'], [413, 'too_large']] as const)('%i is %s, and the subscription is kept', async (code, status) => {
    const { push, forgotten, requests } = sender([code]);
    expect((await push.deliver(TARGET, MESSAGE)).status).toBe(status);
    expect(forgotten).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('sends nothing to an endpoint that is not a browser push service, or a payload over one record', async () => {
    const { push, requests } = sender([]);
    expect(await push.deliver({ ...TARGET, endpoint: 'http://169.254.169.254/latest' }, MESSAGE)).toEqual({ status: 'blocked' });
    expect(await push.deliver(TARGET, { ...MESSAGE, payload: 'x'.repeat(4000) })).toEqual({ status: 'too_large' });
    expect(requests).toEqual([]);
  });
});

describe('the rules around it', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/x', true], ['https://web.push.apple.com/x', true], ['https://updates.push.services.mozilla.com/wpush/v2/x', true],
    ['https://wns2-par02p.notify.windows.com/w/?token=x', true], ['http://fcm.googleapis.com/x', false], ['https://fcm.googleapis.com:8443/x', false],
    ['https://evil.example/web.push.apple.com', false], ['https://push.apple.com.evil.example/x', false], ['https://127.0.0.1/x', false],
  ])('%s is a browser push service: %s', (url, allowed) => { expect(isBrowserPushService(new URL(url))).toBe(allowed); });

  it('reads Retry-After in seconds or as a date, and waits 30 s without one', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs(new Date(now + 45_000).toUTCString(), now)).toBe(45_000);
    expect(retryAfterMs(null, now)).toBe(30_000);
    expect(retryAfterMs('soon', now)).toBe(30_000);
  });
});
