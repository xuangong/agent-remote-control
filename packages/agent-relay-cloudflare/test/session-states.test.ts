import { expect, it } from 'vitest';
import { fixture, origin, send } from './fixture.js';

it('shares a Host\'s session states with every page of its owner over the session channel, without session streams', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const second = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  let key = pairing.key;
  const host = await f.upgrade('/ws/remote-host?sessionStates=1', { authorization: `Bearer ${key}` });
  const frames: any[] = [];
  host.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); frames.push(frame);
    if (frame.type === 'heartbeat') send(host, { type: 'heartbeat_ack', nonce: frame.nonce });
    if (frame.type === 'credential_issued') { key = frame.credential; send(host, { type: 'credential_saved' }); }
  });
  send(host, { type: 'register', credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  await expect.poll(() => frames.find(frame => frame.type === 'registered')).toBeTruthy();
  const registered = frames.find(frame => frame.type === 'registered');
  expect(registered.sessionStates).toBe(1);
  const hostId = registered.hostId as string;
  const listen = async (account: typeof alice, query = 'observation=activity&states=1') => {
    const messages: any[] = [];
    const socket = await f.upgrade(account.basePath + `v1/session-channel?${query}`, { cookie: account.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, messages, states: () => messages.filter(message => message.type === 'session_states') };
  };
  const first = await listen(alice), other = await listen(second), stranger = await listen(bob), plain = await listen(alice, 'observation=activity');
  await expect.poll(() => first.states()[0]).toMatchObject({ snapshot: true, hosts: [{ hostId, online: true }] });
  // Each page's snapshot arrives on its own socket, in no particular order.
  await expect.poll(() => stranger.states()).toEqual([{ protocolVersion: '1.8.0', type: 'session_states', snapshot: true }]);
  send(host, { type: 'session_states', full: true, states: [{ providerId: 'codex', nativeSessionId: 'thread', state: 'running', updatedAt: 5 }] });
  for (const page of [first, other]) {
    await expect.poll(() => page.states().at(-1)).toMatchObject({ hosts: [{ hostId, online: true, confirmedAgeMs: expect.any(Number) }],
      states: [{ hostId, providerId: 'codex', nativeSessionId: 'thread', state: 'running', updatedAt: 5, ageMs: expect.any(Number) }] });
  }
  send(host, { type: 'session_states', full: false, states: [{ providerId: 'codex', nativeSessionId: 'thread', state: 'waiting', updatedAt: 6 }] });
  await expect.poll(() => other.states().at(-1)?.states?.[0]?.state).toBe('waiting');
  expect(other.states().at(-1).hosts).toBeUndefined();
  // A page connecting later starts from the same shared states.
  const late = await listen(second);
  await expect.poll(() => late.states()[0]).toMatchObject({ snapshot: true, states: [{ nativeSessionId: 'thread', state: 'waiting' }] });
  host.close(1000);
  await expect.poll(() => first.states().at(-1)).toMatchObject({ hosts: [{ hostId, online: false }], removed: [{ hostId, providerId: 'codex', nativeSessionId: 'thread' }] });
  expect(stranger.states()).toHaveLength(1);
  expect(plain.messages.some(message => message.type === 'session_states')).toBe(false);
}, 15000);

it('shares reply facts only with pages that ask for them', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.upgrade('/ws/remote-host?sessionStates=1&sessionReplyFacts=1', { authorization: `Bearer ${pairing.key}` });
  const frames: any[] = [];
  host.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); frames.push(frame);
    if (frame.type === 'heartbeat') send(host, { type: 'heartbeat_ack', nonce: frame.nonce });
    if (frame.type === 'credential_issued') send(host, { type: 'credential_saved' });
  });
  send(host, { type: 'register', credentialRotation: true, installationId: 'workers-facts-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  await expect.poll(() => frames.find(frame => frame.type === 'registered')).toBeTruthy();
  expect(frames.find(frame => frame.type === 'registered').sessionStates).toBe(2);
  const listen = async (query: string) => {
    const messages: any[] = [];
    const socket = await f.upgrade(alice.basePath + `v1/session-channel?${query}`, { cookie: alice.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, states: () => messages.filter(message => message.type === 'session_states').flatMap(message => message.states ?? []) };
  };
  const current = await listen('observation=activity&states=2'), older = await listen('observation=activity&states=1');
  const thread = { providerId: 'codex', nativeSessionId: 'thread', state: 'idle', updatedAt: 5 };
  send(host, { type: 'session_states', full: true, states: [{ ...thread, replyAt: 7, preview: 'Release notes are ready.' }] });
  await expect.poll(() => current.states().at(-1)).toMatchObject({ ...thread, replyAt: 7, preview: 'Release notes are ready.' });
  await expect.poll(() => older.states().at(-1)).toMatchObject(thread);
  expect(older.states().at(-1)).not.toHaveProperty('preview');
  expect(older.states().at(-1)).not.toHaveProperty('replyAt');
  // A change of facts alone reaches the pages that asked for them, and nothing reaches the others.
  const seen = older.states().length;
  send(host, { type: 'session_states', full: false, states: [{ ...thread, replyAt: 9, preview: 'Shipped.' }] });
  await expect.poll(() => current.states().at(-1)?.preview).toBe('Shipped.');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(older.states()).toHaveLength(seen);
  host.close(1000);
}, 15000);
