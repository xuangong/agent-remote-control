import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, origin, send } from './test-utils/relay-harness.js';

it('keeps messages for an offline Host on every page until its Controller claims, delivers and settles them', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const phone = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  let key = pairing.key;
  const connect = async (query: string) => {
    const host = await f.upgrade(`/ws/remote-host?${query}`, { authorization: `Bearer ${key}` });
    const frames: any[] = [];
    host.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data)); frames.push(frame);
      if (frame.type === 'heartbeat') send(host, { type: 'heartbeat_ack', nonce: frame.nonce });
      if (frame.type === 'credential_issued') { key = frame.credential; send(host, { type: 'credential_saved' }); }
    });
    send(host, { type: 'register', credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
    await f.poll(() => frames.find(frame => frame.type === 'registered')).toBeTruthy();
    let next = 0;
    const call = async (body: object) => {
      const requestId = `outbox-${++next}`;
      send(host, { type: 'outbox_request', requestId, call: body });
      await f.poll(() => frames.find(frame => frame.type === 'outbox_response' && frame.requestId === requestId)).toBeTruthy();
      const response = frames.find(frame => frame.type === 'outbox_response' && frame.requestId === requestId);
      return { status: response.status as number, body: JSON.parse(response.body) };
    };
    return { host, frames, registered: frames.find(frame => frame.type === 'registered'), call };
  };
  const hosts = async () => (await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as { hosts: Array<{ id: string; online: boolean; outbox?: 1 }> }).hosts;
  const first = await connect('outbox=1');
  expect(first.registered.outbox).toBe(1);
  const hostId = first.registered.hostId as string;
  expect((await hosts())[0]).toMatchObject({ id: hostId, online: true, outbox: 1 });
  // The Host goes offline; pages still know its Controller delivers from the outbox.
  first.host.close();
  await f.poll(async () => (await hosts())[0]?.online).toBe(false);
  expect((await hosts())[0]?.outbox).toBe(1);
  const listen = async (account: typeof alice, query = 'observation=activity&outbox=1') => {
    const messages: any[] = [];
    const socket = await f.upgrade(account.basePath + `v1/session-channel?${query}`, { cookie: account.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, messages, outbox: () => messages.filter(message => message.type === 'session_outbox') };
  };
  const desk = await listen(alice), other = await listen(phone), stranger = await listen(bob), plain = await listen(alice, 'observation=activity');
  await f.poll(() => desk.outbox()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_outbox', snapshot: true, entries: [] });
  const queue = (account: typeof alice, id: string, text: string) => f.json(account.basePath + 'v1/outbox', account.cookie, { id, hostId, providerId: 'codex', nativeSessionId: 'thread', text });
  const id = randomUUID();
  const queued = await (await queue(alice, id, 'Run the suite when you are back.')).json();
  expect(queued).toEqual({ id, hostId, providerId: 'codex', nativeSessionId: 'thread', text: 'Run the suite when you are back.', createdAt: expect.any(Number), status: 'waiting' });
  await f.poll(() => other.outbox().at(-1)?.entries).toEqual([queued]);
  expect((await queue(alice, id, 'Run the suite when you are back.')).status).toBe(200);
  expect((await queue(bob, randomUUID(), 'Not your Host.')).status).toBe(403);
  // A second message, cancelled from the phone, leaves every page.
  const cancelled = randomUUID();
  await queue(alice, cancelled, 'Never mind.');
  expect((await f.json(phone.basePath + `v1/outbox/${cancelled}/cancel`, phone.cookie, {})).status).toBe(200);
  await f.poll(() => desk.outbox().at(-1)).toMatchObject({ entries: [], removed: [cancelled] });
  // The Host returns: its Controller polls, claims, delivers and settles.
  const second = await connect('outbox=1');
  expect((await second.call({ action: 'poll' }))).toEqual({ status: 200, body: { entries: [{ id, providerId: 'codex', nativeSessionId: 'thread', text: 'Run the suite when you are back.', createdAt: queued.createdAt, status: 'waiting' }] } });
  expect((await second.call({ action: 'claim', id })).status).toBe(200);
  await f.poll(() => other.outbox().at(-1)?.entries).toEqual([{ ...queued, status: 'delivering' }]);
  expect((await f.json(alice.basePath + `v1/outbox/${id}/cancel`, alice.cookie, {})).status).toBe(409);
  expect((await second.call({ action: 'settle', id, outcome: 'accepted' })).status).toBe(200);
  await f.poll(() => desk.outbox().at(-1)).toMatchObject({ entries: [], removed: [id] });
  // A message queued while the Host is connected tells its Controller; a refused one stays with its reason until retried.
  const refused = randomUUID();
  const readies = () => second.frames.filter(frame => frame.type === 'outbox_ready').length;
  await queue(alice, refused, 'For a session that is gone.');
  await f.poll(readies).toBe(1);
  await second.call({ action: 'claim', id: refused });
  await second.call({ action: 'settle', id: refused, outcome: 'rejected', error: 'The session is not on this Host.' });
  await f.poll(() => other.outbox().at(-1)?.entries).toEqual([expect.objectContaining({ id: refused, status: 'failed', error: 'The session is not on this Host.' })]);
  expect((await f.json(alice.basePath + `v1/outbox/${refused}/retry`, alice.cookie, {})).status).toBe(200);
  await f.poll(readies).toBe(2);
  expect(await (await f.json(alice.basePath + 'v1/outbox', alice.cookie)).json()).toEqual({ entries: [expect.objectContaining({ id: refused, status: 'waiting' })] });
  expect(stranger.outbox()).toEqual([{ protocolVersion: '1.8.0', type: 'session_outbox', snapshot: true, entries: [] }]);
  expect(plain.messages.some(message => message.type === 'session_outbox')).toBe(false);
  // A Controller that does not ask for the outbox turns it off for its Host and may not use it.
  second.host.close();
  await f.poll(async () => (await hosts())[0]?.online).toBe(false);
  const old = await connect('');
  expect(old.registered.outbox).toBeUndefined();
  expect((await hosts())[0]?.outbox).toBeUndefined();
  expect((await queue(alice, randomUUID(), 'Too old to deliver.')).status).toBe(403);
});

it("remembers across a restart of the Relay that an offline Host's Controller delivers from the outbox", async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  let key = pairing.key;
  const host = await f.upgrade('/ws/remote-host?outbox=1', { authorization: `Bearer ${key}` });
  const frames: any[] = [];
  host.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); frames.push(frame);
    if (frame.type === 'heartbeat') send(host, { type: 'heartbeat_ack', nonce: frame.nonce });
    if (frame.type === 'credential_issued') { key = frame.credential; send(host, { type: 'credential_saved' }); }
  });
  send(host, { type: 'register', credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  await f.poll(() => frames.find(frame => frame.type === 'registered')?.outbox).toBe(1);
  const hostId = frames.find(frame => frame.type === 'registered').hostId as string;
  host.close();
  await f.restart();
  const again = await f.login('alice');
  const hosts = await (await f.json(again.basePath + 'v1/remote/hosts', again.cookie)).json() as { hosts: Array<{ id: string; online: boolean; outbox?: 1 }> };
  expect(hosts.hosts).toEqual([expect.objectContaining({ id: hostId, online: false, outbox: 1 })]);
  expect((await f.json(again.basePath + 'v1/outbox', again.cookie, { id: randomUUID(), hostId, providerId: 'codex', nativeSessionId: 'thread', text: 'After the restart.' })).status).toBe(200);
});
