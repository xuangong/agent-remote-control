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
      message: JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiated' }) });
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/attach`, alice.cookie,
    { providerId: 'codex', nativeSessionId: 'native' })).status).toBe(200);
  const channel = await f.upgrade(alice.basePath + 'v1/session-channel?observation=session', { cookie: alice.cookie, origin });
  expect(await event(channel, 'message')).toMatchObject({ type: 'ready' });
  for (const subscriptionId of [1, 2]) {
    const negotiated = event(channel, 'message');
    channel.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'subscribe', subscriptionId, agentId: 'agent',
      message: { protocolVersion: '1.5.0', type: 'negotiate' } }));
    expect(await negotiated).toMatchObject({ type: 'message', subscriptionId, message: { type: 'negotiated' } });
    expect(streams.size).toBe(1);
    if (subscriptionId === 1) {
      channel.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'unsubscribe', subscriptionId }));
      await expect.poll(() => streams.size, { timeout: 1500 }).toBe(0);
    }
  }
  const closed = event(channel, 'close');
  expect((await f.json('/auth/logout', alice.cookie, {})).status).toBe(200);
  expect((await closed).code).toBe(1008);
  await expect.poll(() => streams.size, { timeout: 1500 }).toBe(0);
}, 15_000);
