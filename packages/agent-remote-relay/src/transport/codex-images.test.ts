import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { CodexAppServerProvider } from '../../../agent-provider-codex/src/provider.js';
import { createScriptedAppServer } from '../../../agent-provider-codex/src/test-utils/scripted-app-server.js';
import {
  AgentReplica,
  HttpWebSocketTransport,
  RemoteSessionClient,
  type RemoteProtocolObservation,
  type RemoteSessionStatus,
  type WebSocketLike,
} from '../../../agent-remote-web/src/headless.js';
import { createAgentRemoteRelay } from '../relay.js';
import { createAgentRemoteHttpServer } from './http-server.js';

const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';

describe('Codex images over HTTP and WebSocket', () => {
  it('reads native history and live image resources and preserves their bindings across reconnect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codex-remote-images-'));
    const imagePath = join(cwd, 'viewed.png');
    await writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
    const appServer = createScriptedAppServer({
      'thread/resume': () => ({ thread: { id: 'codex-images', cwd } }),
      'thread/read': () => ({ thread: { id: 'codex-images', turns: [{ id: 'turn-history', items: [
        { type: 'imageView', id: 'viewed-image', path: 'viewed.png' },
      ] }] } }),
    });
    const relay = createAgentRemoteRelay({
      providers: [new CodexAppServerProvider({ spawn: () => appServer.child })],
      epoch: () => 'image-epoch',
    });
    const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: {
      authenticate: () => ({ subject: 'image-test' }), authorize: () => true,
    } });
    const sockets: WebSocket[] = [];
    const observations: RemoteProtocolObservation[] = [];
    let client: RemoteSessionClient | undefined;
    try {
      const { url } = await server.listen(0, '127.0.0.1');
      const transport = new HttpWebSocketTransport(url, { webSocketFactory: (socketUrl) => {
        const socket = new WebSocket(socketUrl);
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      } });
      transport.onProtocolMessage((observation) => observations.push(observation));
      await transport.resumeAgent('agent-images', { providerId: 'codex', sessionId: 'codex-images', opaque: '{}' });
      const replica = new AgentReplica();
      let status: RemoteSessionStatus = 'idle';
      let reconnect: (() => void) | undefined;
      client = new RemoteSessionClient('agent-images', transport, replica, {
        operationTimeoutMs: 2_000,
        scheduleReconnect: (_delay, restart) => { reconnect = restart; return () => { reconnect = undefined; }; },
      });
      client.subscribeStatus((next) => { status = next; });
      client.start();
      await vi.waitFor(() => expect(status).toBe('ready'));
      const historyEntry = replica.getState().timeline.entries[0]!;
      const historyBinding = historyEntry.resources[0]!;
      expect(historyEntry.item).toEqual({ type: 'assistant_message', messageId: 'viewed-image', text: `![Viewed image](${historyBinding.locator})` });
      expect(historyBinding.locator).toMatch(/^codex-image:[a-f0-9]{64}$/);
      await vi.waitFor(async () => {
        const response = await client!.requestResource(historyBinding.resourceId);
        expect(response.payload.state).toMatchObject({ status: 'available', mediaType: 'image/png', contentBase64: imageBase64 });
      });

      appServer.child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: {
        threadId: 'codex-images', turnId: 'turn-live',
        item: { type: 'imageGeneration', id: 'generated-image', status: 'completed', result: imageBase64 },
      } })}\n`);
      await vi.waitFor(() => expect(replica.getState().timeline.entries).toHaveLength(2));
      const liveEntry = replica.getState().timeline.entries[1]!;
      const liveBinding = liveEntry.resources[0]!;
      expect(liveEntry.item).toEqual({ type: 'assistant_message', messageId: 'generated-image', text: `![Generated image](${liveBinding.locator})` });
      expect(liveBinding.locator).not.toBe(historyBinding.locator);
      await vi.waitFor(async () => {
        expect((await client!.requestResource(liveBinding.resourceId)).payload.state)
          .toMatchObject({ status: 'available', mediaType: 'image/png', contentBase64: imageBase64 });
      });

      const before = await transport.fetchTimeline('agent-images', 'tail');
      await writeFile(imagePath, '<html>the native file changed</html>');
      sockets.at(-1)!.terminate();
      await vi.waitFor(() => {
        expect(status).toBe('disconnected');
        expect(reconnect).toBeTypeOf('function');
      });
      reconnect!();
      await vi.waitFor(() => expect(status).toBe('ready'));
      const after = await transport.fetchTimeline('agent-images', 'tail');
      expect(after.payload.entries).toEqual(before.payload.entries);
      expect(replica.getState().timeline.entries).toHaveLength(2);
      const reloadedBindings = replica.getState().timeline.entries.flatMap((entry) => entry.resources);
      expect(reloadedBindings.map(({ locator }) => locator)).toEqual([historyBinding.locator, liveBinding.locator]);
      for (const binding of reloadedBindings) {
        expect((await client.requestResource(binding.resourceId)).payload.state)
          .toMatchObject({ status: 'available', mediaType: 'image/png', contentBase64: imageBase64 });
      }
      expect(observations.some(({ channel, message }) => channel === 'http' && message.type === 'timeline_page')).toBe(true);
      expect(observations.some(({ channel, message }) => channel === 'websocket' && message.type === 'agent_stream')).toBe(true);
      expect(observations.some(({ channel, message }) => channel === 'websocket' && message.type === 'resource_response')).toBe(true);
      expect(replica.getState().diagnostics).toEqual([]);
    } finally {
      client?.stop();
      for (const socket of sockets) socket.terminate();
      await server.close();
      await relay.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 10_000);
});
