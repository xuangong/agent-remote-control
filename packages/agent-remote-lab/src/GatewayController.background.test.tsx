import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  AgentReplica, HttpWebSocketTransport, RemoteActivityClient, RemoteSessionClient,
  type RemoteActivityState, type RemoteSessionStatus,
} from '@orchardworks/agent-remote-web';
import { GatewayController } from './GatewayController.js';
import { createProtocolValidationServer } from './server.js';
import { createRecordedLabProvider } from './server/recorded.js';
import { render, unmount } from './test/setup.js';
import { workspaceFetch, workspaceSocket } from './workspace-access.js';

const realSetTimeout = globalThis.setTimeout;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    localStorage.clear(); sessionStorage.clear();
  }
});

async function eventually(assertion: () => void): Promise<void> {
  const deadline = performance.now() + 3000;
  for (;;) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await new Promise(resolve => realSetTimeout(resolve, 5));
    });
    try { assertion(); return; }
    catch (error) { if (performance.now() >= deadline) throw error; }
  }
}

async function fixture() {
  localStorage.clear(); sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const recorded = createRecordedLabProvider();
  const relay = createProtocolValidationServer({ providers: [recorded.provider], labOrigin: location.origin });
  const { url: relayUrl } = await relay.http.listen(0, '127.0.0.1');
  cleanups.push(() => relay.close());
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const creator = new HttpWebSocketTransport(relayUrl, { fetch: nativeFetch });
  const ids = Array.from({ length: 5 }, (_, index) => `background-session-${index}`);
  for (const id of ids) await creator.createAgent(id, 'recorded', { sessionId: id });

  const basePath = '/u/' + 'a'.repeat(64) + '/';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname;
    if (path !== '/auth/status' && path !== '/auth/refresh') throw new Error(`Unexpected HTTP request: ${path}`);
    return Response.json({ basePath, expiresAt: Date.now() + 120_000, refreshAfterMs: 60_000 });
  });

  const sockets: WebSocket[] = [];
  const closed: WebSocket[] = [];
  class BrowserSocket extends WebSocket {
    constructor(address: string) {
      const incoming = new URL(address);
      super(relayUrl.replace('http:', 'ws:') + incoming.pathname.replace(basePath, '/') + incoming.search, { origin: location.origin });
      sockets.push(this);
      this.on('close', () => closed.push(this));
    }
  }
  vi.stubGlobal('WebSocket', BrowserSocket);
  cleanups.push(() => { for (const socket of sockets) socket.terminate(); });
  const transport = new HttpWebSocketTransport(new URL(basePath, location.origin).href, {
    sessionChannels: true, fetch: workspaceFetch, webSocketFactory: workspaceSocket,
  });
  cleanups.push(() => transport.dispose());
  const view = await render(<GatewayController>{(_url, _account, ready) => <output>{ready ? 'authorized' : 'restoring'}</output>}</GatewayController>);
  cleanups.push(() => unmount(view));
  expect(view.querySelector('output')?.textContent).toBe('authorized');

  const sessions = ids.map(id => {
    const replica = new AgentReplica();
    const client = new RemoteSessionClient(id, transport, replica);
    const statuses: RemoteSessionStatus[] = [];
    const activities: RemoteActivityState[] = [];
    client.subscribeStatus(status => statuses.push(status));
    const activity = new RemoteActivityClient(id, transport, state => activities.push(state));
    cleanups.push(() => { activity.stop(); client.stop(); });
    client.start(); activity.start();
    return { id, replica, client, statuses, activities };
  });
  await eventually(() => {
    for (const session of sessions) {
      expect(session.client.getSessionState().connection).toBe('ready');
      expect(session.activities.at(-1)?.connection).toBe('ready');
    }
  });
  expect(sockets).toHaveLength(2);
  for (const session of sessions) session.statuses.length = 0;

  const advance = async (milliseconds: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
    await act(async () => { await new Promise(resolve => realSetTimeout(resolve, 10)); });
  };
  const healthy = () => {
    expect(closed, 'Existing session and activity channels must stay open').toHaveLength(0);
    expect(sockets, 'Renewing access must not create replacement channels').toHaveLength(2);
    expect(sockets.every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
    for (const session of sessions) {
      expect(session.statuses).toEqual([]);
      expect(session.client.getSessionState().connection).toBe('ready');
      expect(session.activities.at(-1)?.connection).toBe('ready');
    }
  };
  const publish = async () => {
    const cursors = sessions.map(session => session.replica.getState().timeline.nextSeq);
    for (const id of ids) recorded.controller.advance(id);
    await eventually(() => {
      sessions.forEach((session, index) => {
        expect(session.replica.getState().timeline.nextSeq).toBeGreaterThan(cursors[index]!);
        expect(session.activities.at(-1)?.cursor?.seq).toBeGreaterThanOrEqual(cursors[index]!);
      });
    });
  };
  const hide = async () => {
    visibility = 'hidden';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  };
  return { advance, healthy, publish, hide };
}

it('keeps five background sessions live across two authorization lease lifetimes', async () => {
  const app = await fixture();
  await app.hide();
  for (let lease = 0; lease < 2; lease++) {
    await app.advance(120_001);
    app.healthy();
    await app.publish();
    app.healthy();
  }
}, 10_000);
