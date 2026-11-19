import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';

import { decodeAgentSessionResponse, decodeAgentSnapshot, decodeServerMessage, encodeCreateAgentRequest } from '@orchardworks/agent-remote-protocol';

import {
  collectMessages, createRequest, interactionCases, openSocket, recoversInFlightResponse, start,
} from '../S3/runtime-http-server.fixture.js';

/** The Runtime HTTP server over a real port: the tests whose subject is the socket. The server's contract over HTTP and WebSocket is `tests/S3/runtime-http-server.integration.test.ts`. */

  it('creates an Agent and serves its independent Snapshot by relay agentId', async () => {
    const { url } = await start([], undefined, { listener: true });
    const body = encodeCreateAgentRequest({
      protocolVersion: '1.8.0', type: 'create_agent',
      payload: {
        requestId: 'create-1', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent-http', providerId: 'fake',
        config: { sessionId: 'provider-session-http', cwd: '/workspace' },
      },
    });
    if (body.status !== 'ok') throw new Error('Create fixture did not encode.');

    const createResponse = await fetch(`${url}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body.json,
    });
    const created = decodeAgentSessionResponse(await createResponse.text());
    const snapshotResponse = await fetch(`${url}/v1/sessions/agent-http/snapshot?protocolVersion=1.8.0`);
    const snapshot = decodeAgentSnapshot(await snapshotResponse.text());

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      status: 'ok',
      value: {
        type: 'agent_session',
        payload: {
          requestId: 'create-1', agentId: 'agent-http', providerId: 'fake',
          sessionId: 'provider-session-http',
        },
      },
    });
    expect(snapshotResponse.status).toBe(200);
    expect(snapshot).toMatchObject({
      status: 'ok',
      value: { type: 'agent_snapshot', payload: { id: 'agent-http', runtimeInfo: { sessionId: 'provider-session-http' } } },
    });
    if (snapshot.status === 'ok') {
      expect(snapshot.value.payload).not.toHaveProperty('timeline');
      expect(snapshot.value.payload).not.toHaveProperty('epoch');
    }
  });

  it('does not bind or retain Agent events before exact negotiation', async () => {
    const { relay, url } = await start([], undefined, { listener: true });
    await relay.createAgent(createRequest('agent-unnegotiated', 'provider-session-unnegotiated'));
    const agent = relay.requireAgent('agent-unnegotiated');
    const subscribe = vi.spyOn(agent, 'subscribe');
    const requireAgent = vi.spyOn(relay, 'requireAgent');
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-unnegotiated/events`);

    for (let index = 0; index < 10_000; index += 1) {
      agent.replaceTimeline(`epoch-unnegotiated-${index}`);
    }

    expect(requireAgent).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    const negotiated = collectMessages(socket, 3);
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiate' }));
    const messages = (await negotiated).map((json) => decodeServerMessage(json));

    expect(requireAgent).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(messages).toMatchObject([
      { status: 'ok', value: { type: 'negotiated' } },
      { status: 'ok', value: { type: 'agent_snapshot', payload: { id: 'agent-unnegotiated' } } },
      { status: 'ok', value: { type: 'session_control', payload: { access: 'read_only' } } },
    ]);
    socket.close();
  });

  it('rejects malformed upgrades without breaking later HTTP or WebSocket traffic', async () => {
    const { relay, url } = await start([], undefined, { listener: true });
    const port = Number(new URL(url).port);
    expect(await rawUpgrade(port, '/v1/sessions/%/events', 'dGhlIHNhbXBsZSBub25jZQ=='))
      .toMatch(/^HTTP\/1\.1 400 /);
    expect(await rawUpgrade(port, '/v1/sessions/agent/events', 'bad-key'))
      .toMatch(/^HTTP\/1\.1 400 /);

    await relay.createAgent(createRequest('agent-after-attack', 'provider-session-after-attack'));
    const snapshot = await fetch(
      `${url}/v1/sessions/agent-after-attack/snapshot?protocolVersion=1.8.0`,
    );
    expect(snapshot.status).toBe(200);
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-after-attack/events`);
    socket.close();
  });

it('recovers an accepted in-flight response after the real socket is lost', () => recoversInFlightResponse(interactionCases[0]!.request, interactionCases[0]!.response, { listener: true }));

async function rawUpgrade(port: number, path: string, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (response.length > 0) finish();
      else reject(error);
    });
  });
}

