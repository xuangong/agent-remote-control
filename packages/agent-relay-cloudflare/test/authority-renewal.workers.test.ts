import { expect, it } from 'vitest';
import { fixture } from './fixture.js';

it('renews authority before the lease expires without browser requests or reconnecting the Host', async () => {
  const f = await fixture();
  f.setAuthority(200, 1600);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket } = await f.host(pairing.key);
  const calls = f.authorityCalls;
  const closes: number[] = [];
  socket.addEventListener('close', event => closes.push(event.code));
  await new Promise(resolve => setTimeout(resolve, 4200));
  expect(closes).toEqual([]);
  expect(socket.readyState).toBe(1);
  expect(f.authorityCalls).toBeGreaterThan(calls + 1);
}, 15000);

