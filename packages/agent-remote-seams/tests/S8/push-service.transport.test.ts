// S8 at a loopback port: the push service simulator served over HTTP, as the e2e stack reaches it, and the Relay's push sender with the
// real fetch. The rules of the seam are push-service.integration.test.ts's; this checks they hold over a socket.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createPushSender, generateVapidKeys, type VapidKeys } from '@orchardworks/agent-relay-core';
import { startPushService, type PushService } from '@orchardworks/agent-remote-fixtures/push-service';

let service: PushService;
let vapid: VapidKeys;
beforeEach(async () => { service = await startPushService(); vapid = await generateVapidKeys(); });
afterEach(async () => { await service.close(); });

it('S8 over HTTP: a push the service accepts, signed for its origin, that the browser decrypts; and a 410 that forgets the subscription', async () => {
  const subscription = await service.subscribe({ applicationServerKey: vapid.publicKey });
  expect(subscription.endpoint.startsWith(`${service.origin}/push/`)).toBe(true);
  const forgotten: string[] = [];
  const push = createPushSender({ vapid: { ...vapid, subject: 'https://agents.example' }, post: request => fetch(request), now: Date.now,
    endpoints: url => url.origin === service.origin, forget: endpoint => { forgotten.push(endpoint); } });
  const message = { payload: JSON.stringify({ v: 1, kind: 'needs_you', name: 'Chief' }), topic: 'chief', ttlSeconds: 60, urgency: 'high' as const };
  expect(await push.deliver(subscription, message)).toEqual({ status: 'sent' });
  expect(service.received()[0]).toMatchObject({ status: 201, vapid: { publicKey: vapid.publicKey, claims: { aud: service.origin } } });
  expect((await service.delivered(subscription.endpoint)).map(each => each.payload)).toEqual([message.payload]);
  service.expire(subscription.endpoint, 410);
  expect(await push.deliver(subscription, message)).toEqual({ status: 'gone', code: 410 });
  expect(forgotten).toEqual([subscription.endpoint]);
});
