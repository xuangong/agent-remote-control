import { expect, it } from 'vitest';
import { HttpPushClient, PushRequestError } from './push-client.js';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

function relay(answer: (request: Request) => Response) {
  const requests: Request[] = [];
  const client = new HttpPushClient('https://relay.example/u/alice/', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request); return answer(request);
  }) as typeof fetch);
  return { client, requests };
}

it('asks, keeps and forgets this device\'s subscription under the account\'s path', async () => {
  const { client, requests } = relay(request => Response.json(request.method === 'DELETE' ? { publicKey: KEYS.p256dh } : { publicKey: KEYS.p256dh, device: { endpoint: 'https://web.push.apple.com/x', locale: 'zh' } }));
  expect(await client.device()).toEqual({ publicKey: KEYS.p256dh, device: { endpoint: 'https://web.push.apple.com/x', locale: 'zh' } });
  await client.subscribe({ endpoint: 'https://web.push.apple.com/x', keys: KEYS, locale: 'zh' });
  expect(await client.unsubscribe()).toEqual({ publicKey: KEYS.p256dh });
  expect(requests.map(request => [request.method, request.url, request.headers.get('content-type')])).toEqual([
    ['GET', 'https://relay.example/u/alice/v1/push-subscriptions', null],
    ['POST', 'https://relay.example/u/alice/v1/push-subscriptions', 'application/json'],
    ['DELETE', 'https://relay.example/u/alice/v1/push-subscriptions', 'application/json']]);
  expect(await requests[1]!.json()).toEqual({ endpoint: 'https://web.push.apple.com/x', keys: KEYS, locale: 'zh' });
});

it('turns a refusal into an error with the Relay\'s code, and refuses an answer of the wrong shape', async () => {
  await expect(relay(() => Response.json({ code: 'push_unavailable', error: 'Not here.' }, { status: 503 })).client.subscribe({ endpoint: 'https://web.push.apple.com/x', keys: KEYS, locale: 'en' }))
    .rejects.toMatchObject({ status: 503, code: 'push_unavailable' });
  await expect(relay(() => Response.json({ publicKey: 'short' })).client.device()).rejects.toBeInstanceOf(PushRequestError);
});
