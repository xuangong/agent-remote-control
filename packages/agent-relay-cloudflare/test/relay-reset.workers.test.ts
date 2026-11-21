import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { WebSocket } from 'miniflare';
import { expect, it } from 'vitest';
import { event, fixture, origin, send } from './fixture.js';

/** Frames of a socket in arrival order; `next` waits for the first unread frame that matches, with a deadline. */
function inbox(socket: WebSocket) {
  const frames: any[] = []; let read = 0; let wake: (() => void) | undefined;
  socket.addEventListener('message', message => { frames.push(JSON.parse(String(message.data))); wake?.(); });
  return {
    frames,
    async next(match: (frame: any) => boolean, label: string) {
      const deadline = Date.now() + 5000;
      for (;;) {
        while (read < frames.length) { const frame = frames[read++]; if (match(frame)) return frame; }
        if (Date.now() > deadline) throw new Error(`Deadline exceeded waiting for ${label}`);
        await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 100); });
      }
    },
  };
}

const owner = { kind: 'native_cli', generation: '00000000-0000-4000-8000-0000000000f1' };
const operations = { free: '00000000-0000-4000-8000-0000000000a1', owned: '00000000-0000-4000-8000-0000000000b1', stale: '00000000-0000-4000-8000-0000000000c1', again: '00000000-0000-4000-8000-0000000000a2', ownedAgain: '00000000-0000-4000-8000-0000000000b2' };

it('resets the Relay object under two pages that hold control: every socket learns of it, the Host and the pages return, and control is acquired again without a conflict or a lost send', async () => {
  const f = await fixture({ heartbeatIntervalMs: 400 });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  // The Controller: agent-1 takes sends; agent-2 is held by a terminal, which refuses every send and names itself when asked.
  const delivered: string[] = []; let ownerAsked = 0; let refusals = 0;
  const serve = (socket: WebSocket) => socket.addEventListener('message', message => {
    const data = JSON.parse(String(message.data));
    if (data.type === 'rpc_request') {
      const native = JSON.parse(data.body ?? '{}').nativeSessionId as string | undefined;
      const agentId = native === 'native-2' ? 'agent-2' : 'agent-1';
      // The Relay asks who holds a session by attaching it again after a refusal.
      if (agentId === 'agent-2' && data.path === '/remote/attach' && ownerAsked === 0 && refusals > 0) {
        ownerAsked++;
        send(socket, { type: 'rpc_response', requestId: data.requestId, status: 409, body: JSON.stringify({ code: 'native_session_owned', error: 'A terminal holds this session.', nativeOwner: owner }) });
      } else send(socket, { type: 'rpc_response', requestId: data.requestId, status: 200, body: JSON.stringify({ agentId, nativeSessionId: native }) });
    }
    if (data.type === 'stream_open') {
      send(socket, { type: 'stream_opened', streamId: data.streamId });
      send(socket, { type: 'stream_message', streamId: data.streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { id: data.sessionId } }) });
    }
    if (data.type === 'stream_message') {
      const frame = JSON.parse(data.message);
      if (frame.type !== 'send_message') return;
      const reply = (body: object) => send(socket, { type: 'stream_message', streamId: data.streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }) });
      if (frame.payload.agentId === 'agent-2') {
        refusals++; ownerAsked = 0;
        reply({ type: 'protocol_error', payload: { requestId: frame.payload.requestId, code: 'native_session_owned', message: 'A terminal holds this session.', recoverable: true } });
      } else {
        delivered.push(frame.payload.operationId);
        reply({ type: 'command_acknowledged', payload: { requestId: frame.payload.requestId, agentId: frame.payload.agentId, command: 'send_message' } });
      }
    }
  });
  let host = await f.host(pairing.key); serve(host.socket);
  for (const nativeSessionId of ['native-1', 'native-2']) {
    expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/attach`, alice.cookie, { providerId: 'codex', nativeSessionId })).status).toBe(200);
  }
  const hostId = host.hostId;

  const open = async (agentId: string) => {
    const socket = await f.upgrade(alice.basePath + `v1/sessions/${agentId}/events`, { cookie: alice.cookie, origin });
    const frames = inbox(socket);
    await frames.next(frame => frame.type === 'agent_snapshot', 'the Snapshot');
    const first = await frames.next(frame => frame.type === 'session_control', 'the first control state');
    return { socket, frames, first: first.payload, agentId };
  };
  const control = (page: Awaited<ReturnType<typeof open>>, requestId: string, revision: string) => {
    page.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { requestId, agentId: page.agentId, action: 'acquire', revision } }));
    return page.frames.next(frame => frame.type === 'session_control' && frame.payload.requestId === requestId, 'the control grant');
  };
  const message = (page: Awaited<ReturnType<typeof open>>, operationId: string, token: string) => page.socket.send(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: token, payload: { requestId: `send-${operationId}`, operationId, agentId: page.agentId, text: 'hello' } }));

  // Before the reset: both pages hold control, and page 2 has seen the terminal refuse it.
  const one = await open('agent-1'); const two = await open('agent-2');
  expect(one.first).toMatchObject({ access: 'read_only', available: true }); expect(one.first.token).toBeUndefined();
  const oneToken = (await control(one, 'a1', one.first.revision)).payload.token as string;
  const twoGrant = (await control(two, 'a2', two.first.revision)).payload; expect(twoGrant.access).toBe('control');
  message(one, operations.free, oneToken);
  await one.frames.next(frame => frame.type === 'command_acknowledged', 'the first send acknowledged');
  message(two, operations.owned, twoGrant.token);
  await two.frames.next(frame => frame.type === 'protocol_error' && frame.payload.code === 'native_session_owned', 'the refusal');
  const owned = await two.frames.next(frame => frame.type === 'session_control' && frame.payload.nativeOwner, 'the owner');
  expect(owned.payload).toMatchObject({ access: 'read_only', available: false, nativeOwner: owner });
  expect(delivered).toEqual([operations.free]);

  // The object is reset while the Worker and the other objects live.
  const closes = [event(one.socket, 'close'), event(two.socket, 'close'), event(host.socket, 'close')];
  await f.inspect('abort').catch(() => undefined);
  for (const closed of closes) expect((await closed).code).toBeGreaterThanOrEqual(1000);

  // The object is built again from its storage: the Host, its sessions and its credential are still known.
  expect((await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as any).hosts[0]).toMatchObject({ id: host.hostId, online: false });
  host = await f.host(host.key); serve(host.socket);
  expect(host.hostId).toBe(hostId);
  const heartbeats: string[] = [];
  host.socket.addEventListener('message', message => { const frame = JSON.parse(String(message.data)); if (frame.type === 'heartbeat') heartbeats.push(frame.nonce); });
  await expect.poll(() => heartbeats.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  expect(new Set(heartbeats).size).toBe(heartbeats.length); expect(host.socket.readyState).toBe(1);

  // The pages return read-only: the old token is not accepted, and a new lease is a different one.
  const oneAgain = await open('agent-1'); const twoAgain = await open('agent-2');
  for (const page of [oneAgain, twoAgain]) { expect(page.first).toMatchObject({ access: 'read_only', available: true }); expect(page.first.token).toBeUndefined(); }
  message(oneAgain, operations.stale, oneToken);
  expect((await oneAgain.frames.next(frame => frame.type === 'protocol_error', 'the stale token refused')).payload).toMatchObject({ code: 'session_read_only', requestId: `send-${operations.stale}` });
  const newToken = (await control(oneAgain, 'b1', oneAgain.first.revision)).payload;
  expect(newToken).toMatchObject({ access: 'control', available: true }); expect(newToken.token).not.toBe(oneToken);
  const twoNew = (await control(twoAgain, 'b2', twoAgain.first.revision)).payload; expect(twoNew.access).toBe('control'); expect(twoNew.token).not.toBe(twoGrant.token);
  const reacquired = await control(oneAgain, 'b3', oneAgain.first.revision);
  expect(reacquired.payload.token).toBe(newToken.token);

  // No loss and no repeat: one send reaches the Controller once, the terminal's session is refused with its owner named.
  message(oneAgain, operations.again, newToken.token);
  await oneAgain.frames.next(frame => frame.type === 'command_acknowledged', 'the send acknowledged');
  expect(delivered).toEqual([operations.free, operations.again]);
  message(twoAgain, operations.ownedAgain, twoNew.token);
  await twoAgain.frames.next(frame => frame.type === 'protocol_error' && frame.payload.code === 'native_session_owned', 'the refusal again');
  expect((await twoAgain.frames.next(frame => frame.type === 'session_control' && frame.payload.nativeOwner, 'the owner again')).payload)
    .toMatchObject({ access: 'read_only', available: false, nativeOwner: owner });
  expect(delivered).toEqual([operations.free, operations.again]);
  expect(f.runtimeErrors).not.toContain('Error:');
}, 30000);
