// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type WebSocketLike, type RemoteSessionStatus } from '@orchardworks/agent-remote-web/headless';
import { createRecordedValidationServer } from './recorded.js';

it('opens a discovered native session and sends through the public WebSocket protocol', async () => {
  const server = createRecordedValidationServer();
  const address = await server.http.listen();
  const origin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
  let client: RemoteSessionClient | undefined;
  try {
    const catalog = await (await fetch(`${address.url}/v1/remote/catalog?providerId=recorded`)).json();
    const opened = await (await fetch(`${address.url}/v1/remote/attach`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'recorded', nativeSessionId: catalog.items[0].nativeSessionId }),
    })).json();
    const transport = new HttpWebSocketTransport(address.url, {
      webSocketFactory: (url) => new WebSocket(url, { headers: { origin } }) as unknown as WebSocketLike,
    });
    const replica = new AgentReplica();
    client = new RemoteSessionClient(opened.agentId, transport, replica, { operationTimeoutMs: 5_000 });
    let status: RemoteSessionStatus = 'idle';
    client.subscribeStatus((value) => { status = value; });
    client.start();
    await vi.waitFor(() => expect(status).toBe('ready'));
    const result = await client.sendMessage('Independent host message');
    expect(result.type).toBe('command_acknowledged');
    await vi.waitFor(() => expect(JSON.stringify(replica.getState().timeline)).toContain('Recorded reply: Independent host message'));
    expect((await transport.fetchSnapshot(opened.agentId)).payload.id).toBe(opened.agentId);
    const advanced = await fetch(`${address.url}/v1/lab/recorded/${opened.agentId}/advance`, { method: 'POST', headers: { origin } });
    expect(advanced.status).toBe(204);
  } finally { client?.stop(); await server.close(); }
});
