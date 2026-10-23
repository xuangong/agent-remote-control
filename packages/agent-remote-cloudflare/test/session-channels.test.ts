import { expect, it } from 'vitest';
import { event, fixture, origin, send } from './fixture.js';

it('reuses Worker session channels and releases their Host streams on logout', async () => {
  const f = await fixture();
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key);
  const streams = new Set<string>();
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'rpc_request') send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200,
      body: JSON.stringify({ agentId: 'agent', nativeSessionId: 'native' }) });
    if (frame.type === 'stream_open') {
      streams.add(frame.streamId);
      send(host, { type: 'stream_opened', streamId: frame.streamId });
    }
    if (frame.type === 'stream_close') streams.delete(frame.streamId);
    if (frame.type === 'stream_message') send(host, { type: 'stream_message', streamId: frame.streamId,
      message: JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiated' }) });
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/attach`, alice.cookie,
    { providerId: 'codex', nativeSessionId: 'native' })).status).toBe(200);
  const channel = await f.upgrade(alice.basePath + 'v1/session-channel?observation=session', { cookie: alice.cookie, origin });
  expect(await event(channel, 'message')).toMatchObject({ type: 'ready' });
  for (const subscriptionId of [1, 2]) {
    const negotiated = event(channel, 'message');
    channel.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'subscribe', subscriptionId, agentId: 'agent',
      message: { protocolVersion: '1.8.0', type: 'negotiate' } }));
    expect(await negotiated).toMatchObject({ type: 'message', subscriptionId, message: { type: 'negotiated' } });
    expect(streams.size).toBe(1);
    if (subscriptionId === 1) {
      channel.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'unsubscribe', subscriptionId }));
      await expect.poll(() => streams.size, { timeout: 1500 }).toBe(0);
    }
  }
  const closed = event(channel, 'close');
  expect((await f.json('/auth/logout', alice.cookie, {})).status).toBe(200);
  expect((await closed).code).toBe(1008);
  await expect.poll(() => streams.size, { timeout: 1500 }).toBe(0);
}, 15_000);

it('gives a full account stream to the subscription in most recent use and pauses the least recently used one', async () => {
  const f = await fixture();
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key);
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'rpc_request') send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200,
      body: JSON.stringify({ agentId: 'agent', nativeSessionId: 'native' }) });
    if (frame.type === 'stream_open') send(host, { type: 'stream_opened', streamId: frame.streamId });
    if (frame.type === 'stream_message') send(host, { type: 'stream_message', streamId: frame.streamId,
      message: JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiated' }) });
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/attach`, alice.cookie,
    { providerId: 'codex', nativeSessionId: 'native' })).status).toBe(200);
  const channel = async (query: string) => {
    const socket = await f.upgrade(alice.basePath + `v1/session-channel?observation=session${query}`, { cookie: alice.cookie, origin });
    const frames: any[] = [];
    socket.addEventListener('message', message => frames.push(JSON.parse(String(message.data))));
    await expect.poll(() => frames.length).toBe(1);
    const subscribe = (subscriptionId: number, idleMs?: number) => socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'subscribe', subscriptionId, agentId: 'agent',
      message: { protocolVersion: '1.8.0', type: 'negotiate' }, ...(idleMs === undefined ? {} : { idleMs }) }));
    const outcome = (subscriptionId: number) => frames.find(frame => frame.subscriptionId === subscriptionId);
    return { socket, frames, subscribe, outcome };
  };
  // A background tab holds the whole allowance; two of its sessions are in other Windows, one used longer ago.
  const background = await channel('&preemption=1');
  expect(background.frames[0]).toEqual({ protocolVersion: '1.8.0', type: 'ready', preemption: 1 });
  for (let id = 1; id <= 64; id++) background.subscribe(id, id === 63 ? 120_000 : id === 64 ? 60_000 : undefined);
  await expect.poll(() => background.frames.filter(frame => frame.type === 'message').length, { timeout: 10_000 }).toBe(64);

  const current = await channel('&preemption=1');
  current.subscribe(1);
  await expect.poll(() => current.outcome(1)).toMatchObject({ type: 'message', message: { type: 'negotiated' } });
  await expect.poll(() => background.frames.find(frame => frame.type === 'closed')).toMatchObject({ subscriptionId: 63, code: 4030 });

  // A subscription unused for longer than everything open cannot take a stream, and neither can an older client.
  current.subscribe(2, 90_000);
  await expect.poll(() => current.outcome(2)).toMatchObject({ type: 'closed', code: 4029 });
  const older = await channel('');
  expect(older.frames[0]).toEqual({ protocolVersion: '1.8.0', type: 'ready' });
  older.subscribe(1);
  await expect.poll(() => older.outcome(1)).toMatchObject({ type: 'closed', code: 4029 });
  expect(background.frames.filter(frame => frame.type === 'closed')).toHaveLength(1);

  // Once the background tab reports that a shown session is no longer in use, it goes next.
  background.socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'intent', active: false, subscriptionIds: [5] }));
  current.subscribe(3);
  await expect.poll(() => current.outcome(3)).toMatchObject({ type: 'message', message: { type: 'negotiated' } });
  expect(background.frames.filter(frame => frame.type === 'closed').map(frame => frame.subscriptionId)).toEqual([63, 64]);
  current.subscribe(4);
  await expect.poll(() => current.outcome(4)).toMatchObject({ type: 'message', message: { type: 'negotiated' } });
  expect(background.frames.filter(frame => frame.type === 'closed').map(frame => frame.subscriptionId)).toEqual([63, 64, 5]);
}, 30_000);
