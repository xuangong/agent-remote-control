import { expect, it } from 'vitest';
import { fixture, origin } from './fixture.js';

it('keeps read positions per account and shares them with every page that asks for them', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const phone = await f.login('alice'); const bob = await f.login('bob');
  const listen = async (account: typeof alice, query = 'observation=activity&reads=1') => {
    const messages: any[] = [];
    const socket = await f.upgrade(account.basePath + `v1/session-channel?${query}`, { cookie: account.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, messages, reads: () => messages.filter(message => message.type === 'session_reads') };
  };
  const desk = await listen(alice), other = await listen(phone), stranger = await listen(bob), plain = await listen(alice, 'observation=activity');
  await expect.poll(() => desk.reads()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_reads', snapshot: true, reads: [] });
  const mark = (account: typeof alice, reads: unknown[]) => f.json(account.basePath + 'v1/session-reads', account.cookie, { reads });
  // The first request starts the account's positions.
  const started = await (await mark(alice, [])).json() as { since: number; reads: unknown[] };
  expect(started).toEqual({ since: expect.any(Number), reads: [] });
  await expect.poll(() => other.reads().at(-1)).toMatchObject({ since: started.since });
  const position = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread', readAt: 7 };
  expect((await mark(alice, [position])).status).toBe(200);
  await expect.poll(() => other.reads().at(-1)?.reads).toEqual([position]);
  // A position never moves back, and a page that connects later starts from the same positions.
  await mark(alice, [{ ...position, readAt: 3 }]);
  const late = await listen(phone);
  await expect.poll(() => late.reads()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_reads', snapshot: true, since: started.since, reads: [position] });
  expect(await (await f.json(alice.basePath + 'v1/session-reads', alice.cookie)).json()).toEqual({ since: started.since, reads: [position] });
  expect((await mark(alice, [{ ...position, readAt: -1 }])).status).toBe(400);
  expect(stranger.reads()).toEqual([{ protocolVersion: '1.8.0', type: 'session_reads', snapshot: true, reads: [] }]);
  expect(plain.messages.some(message => message.type === 'session_reads')).toBe(false);
  // Positions outlive a restart of the Relay.
  await f.restart();
  const again = await f.login('alice');
  const after = await listen(again);
  await expect.poll(() => after.reads()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_reads', snapshot: true, since: started.since, reads: [position] });
}, 20000);
