import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { HttpWebSocketTransport, type WebSocketLike } from '../../../agent-remote-web/src/headless.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remote from '../index.js';

const closeables: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });
const negotiate = JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' });

async function fixture(options: Record<string, unknown> = {}) {
  const { agentId = 'agent-one', ...hostOptions } = options;
  if (typeof agentId !== 'string') throw new TypeError('fixture agentId must be a string.');
  const sent: unknown[] = [], failures: unknown[] = [], commands: string[] = [];
  let finishSend: (() => void) | undefined;
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; },
    async runtimeInfo() { return { providerId: 'test', sessionId: 'native-one', status: 'idle' }; },
    async sendMessage(text) { commands.push(text); if (text === 'hold') await new Promise<void>((r) => { finishSend = r; }); },
    async respondToInteraction() {}, async dispose() {},
  };
  const relay = remote.createAgentRemoteRelay({ providers: [{ descriptor: { providerId: 'test', displayName: 'Test' },
    async createSession() { return session; }, async resumeSession() { return session; } }], epoch: () => 'epoch-one' });
  closeables.push(() => relay.close());
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: {
    requestId: 'create', operationId: '00000000-0000-4000-8000-000000000001', agentId, providerId: 'test', config: { sessionId: 'native-one' },
  } });
  expect(remote.createAgentRemotePluginHost).toBeTypeOf('function');
  const host = remote.createAgentRemotePluginHost(relay, {
    agentId, send: (json: string) => sent.push(JSON.parse(json)), onFailure: (e: unknown) => failures.push(e), ...hostOptions,
  });
  closeables.push(() => { finishSend?.(); host.close(); });
  const receive = (value: object) => host.receive(JSON.stringify({ uplinkVersion: 1, ...value }));
  return { relay, host, receive, sent, failures, commands, finish: () => finishSend?.() };
}

describe('socket-free plugin uplink host', () => {
  it('binds each v2 stream and control mutation to its explicit Remote Session target', async () => {
    const f = await fixture();
    const controls: unknown[] = [];
    expect(remote.createRemoteHostPluginHost).toBeTypeOf('function');
    const host = remote.createRemoteHostPluginHost(f.relay, {
      resolveSession: (sessionId: string) => sessionId === 'remote-one' ? f.relay.requireAgent('agent-one') : undefined,
      control: async (request: unknown) => {
        controls.push(request);
        return { status: 200, body: '{"nativeSessionId":"native-one"}' };
      },
      send: (json: string) => f.sent.push(JSON.parse(json)),
      onFailure: (error: unknown) => f.failures.push(error),
    });
    closeables.push(() => host.close());
    const receive = (value: object) => host.receive(JSON.stringify({ uplinkVersion: 2, ...value }));

    receive({ type: 'stream_open', streamId: 'bound', sessionId: 'remote-one' });
    receive({ type: 'rpc_request', requestId: 'attach', method: 'POST', path: '/remote/attach', sessionId: 'remote-one',
      body: '{"nativeSessionId":"native-one"}' });
    receive({ type: 'stream_open', streamId: 'foreign', sessionId: 'remote-two' });

    await vi.waitFor(() => expect(f.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ uplinkVersion: 2, type: 'stream_opened', streamId: 'bound' }),
      expect.objectContaining({ uplinkVersion: 2, type: 'rpc_response', requestId: 'attach', status: 200 }),
      expect.objectContaining({ uplinkVersion: 2, type: 'stream_close', streamId: 'foreign', code: 1008 }),
    ])));
    expect(controls).toEqual([{
      requestId: 'attach', method: 'POST', path: '/remote/attach', sessionId: 'remote-one', body: '{"nativeSessionId":"native-one"}',
    }]);
    expect(f.failures).toEqual([]);
  });

  it('serves the production provider, snapshot, and Timeline reads through an attached target', async () => {
    const f = await fixture({ agentId: 'remote-one' });
    const controls: unknown[] = [];
    const requests: string[] = [];
    const pending = new Map<string, (response: { status: number; body: string }) => void>();
    let socket: WebSocketLike | undefined;
    const host = remote.createRemoteHostPluginHost(f.relay, {
      resolveSession: (sessionId: string) => sessionId === 'remote-one' ? f.relay.requireAgent('remote-one') : undefined,
      control: async (request: unknown) => {
        controls.push(request);
        return { status: 200, body: '{"nativeSessionId":"native-one"}' };
      },
      send: (json: string) => {
        const message = JSON.parse(json) as Record<string, unknown>;
        if (message.type === 'rpc_response') {
          pending.get(message.requestId as string)?.({ status: message.status as number, body: message.body as string });
          return;
        }
        if (message.type === 'stream_message') socket?.onmessage?.({ data: message.message });
      },
      onFailure: (error: unknown) => f.failures.push(error),
    });
    closeables.push(() => host.close());
    let requestNumber = 0;
    const receiveRpc = (method: 'GET' | 'POST', path: string, body?: string) => new Promise<{ status: number; body: string }>((resolve) => {
      const requestId = `request-${++requestNumber}`;
      pending.set(requestId, (response) => { pending.delete(requestId); resolve(response); });
      requests.push(path);
      host.receive(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method, path, sessionId: 'remote-one',
        ...(body === undefined ? {} : { body }) }));
    });

    await receiveRpc('POST', '/remote/attach', '{"nativeSessionId":"native-one"}');
    const transport = new HttpWebSocketTransport('http://remote-host.test/', {
      fetch: async (input, init) => {
        const address = new URL(String(input));
        const response = await receiveRpc((init?.method ?? 'GET') as 'GET' | 'POST', `${address.pathname}${address.search}`,
          typeof init?.body === 'string' ? init.body : undefined);
        return new Response(response.body, { status: response.status });
      },
      webSocketFactory: () => {
        const browser: WebSocketLike = {
          onopen: null, onmessage: null, onclose: null, onerror: null,
          send: (message) => {
            requests.push('negotiate');
            host.receive(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: 'browser', message }));
          },
          close: () => host.receive(JSON.stringify({ uplinkVersion: 2, type: 'stream_close', streamId: 'browser', code: 1000, reason: 'closed' })),
        };
        socket = browser;
        queueMicrotask(() => {
          host.receive(JSON.stringify({ uplinkVersion: 2, type: 'stream_open', streamId: 'browser', sessionId: 'remote-one' }));
          browser.onopen?.({});
        });
        return browser;
      },
    });
    await new Promise<void>((resolve) => {
      const connection = transport.connect('remote-one', {
        onOpen: () => { connection.send(JSON.parse(negotiate)); resolve(); }, onMessage: () => {}, onDisconnect: () => {},
      });
    });

    await expect(transport.listProviders()).resolves.toEqual([{ providerId: 'test', displayName: 'Test' }]);
    await expect(transport.fetchSnapshot('remote-one')).resolves.toMatchObject({ payload: { id: 'remote-one' } });
    await expect(transport.fetchTimeline('remote-one', 'tail', undefined, 10)).resolves.toMatchObject({ payload: { agentId: 'remote-one' } });
    expect(requests).toEqual([
      '/remote/attach', 'negotiate', '/v1/providers?protocolVersion=1.5.0',
      '/v1/sessions/remote-one/snapshot?protocolVersion=1.5.0',
      '/v1/sessions/remote-one/timeline?protocolVersion=1.5.0&requestId=remote-http-1&direction=tail&limit=10',
    ]);
    expect(controls).toEqual([{ requestId: 'request-1', method: 'POST', path: '/remote/attach', sessionId: 'remote-one', body: '{"nativeSessionId":"native-one"}' }]);
    expect(f.failures).toEqual([]);
  });

  it('isolates browser negotiation and retains the same public snapshot after transport close', async () => {
    const f = await fixture();
    for (const streamId of ['one', 'two']) {
      f.receive({ type: 'stream_open', streamId });
      f.receive({ type: 'stream_message', streamId, message: negotiate });
    }
    await vi.waitFor(() => expect(f.sent.filter((v: any) => v.type === 'stream_message')).toHaveLength(6));
    const snapshots = f.sent.filter((v: any) => v.type === 'stream_message')
      .map((v: any) => JSON.parse(v.message)).filter((v: any) => v.type === 'agent_snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual(snapshots[1]);
    f.host.close();
    expect(f.relay.requireAgent('agent-one').snapshot()).toEqual(snapshots[0]);
  });

  it('rejects foreign Agent HTTP routes and native-session import', async () => {
    const f = await fixture();
    f.receive({ type: 'rpc_request', requestId: 'foreign', method: 'GET', path: '/v1/sessions/other/snapshot?protocolVersion=1.5.0' });
    f.receive({ type: 'rpc_request', requestId: 'resume', method: 'POST', path: '/v1/sessions/resume', body: '{}' });
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'foreign', status: 403 }), expect.objectContaining({ requestId: 'resume', status: 403 }),
    ]));
  });

  it('serializes commands within a stream while another browser remains responsive', async () => {
    const f = await fixture();
    f.receive({ type: 'stream_open', streamId: 'one' });
    f.receive({ type: 'stream_message', streamId: 'one', message: negotiate });
    const controlToken = await takeControl(f, 'one');
    f.receive({ type: 'stream_message', streamId: 'one', message: JSON.stringify({ protocolVersion: '1.5.0', type: 'send_message', controlToken,
      payload: { requestId: 'hold', operationId: '00000000-0000-4000-8000-000000000002', agentId: 'agent-one', text: 'hold' } }) });
    f.receive({ type: 'stream_message', streamId: 'one', message: JSON.stringify({ protocolVersion: '1.5.0', type: 'timeline_request',
      payload: { requestId: 'history-after-send', agentId: 'agent-one', direction: 'tail', limit: 10 } }) });
    f.receive({ type: 'stream_open', streamId: 'two' });
    f.receive({ type: 'stream_message', streamId: 'two', message: negotiate });
    await vi.waitFor(() => expect(f.commands).toEqual(['hold']));
    expect(f.sent.filter((v: any) => v.streamId === 'two' && v.type === 'stream_message')).toHaveLength(3);
    expect(f.sent.some((v: any) => v.message?.includes('history-after-send'))).toBe(false);
    f.finish();
    await vi.waitFor(() => expect(f.sent.some((v: any) => v.message?.includes('history-after-send'))).toBe(true));
  });

  it('retires cancelled RPC delivery without replaying or undoing its Provider action', async () => {
    const f = await fixture();
    f.receive({ type: 'rpc_request', requestId: 'cancelled', method: 'GET', path: '/v1/providers?protocolVersion=1.5.0' });
    f.receive({ type: 'rpc_cancel', requestId: 'cancelled' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.sent).toEqual([]);
    f.receive({ type: 'rpc_request', requestId: 'next', method: 'GET', path: '/v1/providers?protocolVersion=1.5.0' });
    await vi.waitFor(() => expect(f.sent).toEqual([expect.objectContaining({ requestId: 'next', status: 200 })]));
  });

  it('does not deliver a closed stream command acknowledgement to a reused stream identity', async () => {
    const f = await fixture();
    f.receive({ type: 'stream_open', streamId: 'one' });
    f.receive({ type: 'stream_message', streamId: 'one', message: negotiate });
    const controlToken = await takeControl(f, 'one');
    f.receive({ type: 'stream_message', streamId: 'one', message: JSON.stringify({ protocolVersion: '1.5.0', type: 'send_message', controlToken,
      payload: { requestId: 'old-command', operationId: '00000000-0000-4000-8000-000000000003', agentId: 'agent-one', text: 'hold' } }) });
    await vi.waitFor(() => expect(f.commands).toEqual(['hold']));
    f.receive({ type: 'stream_close', streamId: 'one', code: 1000, reason: 'Reattach' });
    f.receive({ type: 'stream_open', streamId: 'one' });
    f.receive({ type: 'stream_message', streamId: 'one', message: negotiate });
    f.finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.sent.some((v: any) => v.message?.includes('old-command'))).toBe(false);
  });

  it('bounds browser input and stream counts without closing unrelated streams', async () => {
    const f = await fixture({ maxStreams: 1, maxPendingPerStream: 1 });
    f.receive({ type: 'stream_open', streamId: 'one' });
    f.receive({ type: 'stream_open', streamId: 'two' });
    expect(f.sent).toContainEqual(expect.objectContaining({ type: 'stream_close', streamId: 'two', code: 1013 }));
    f.receive({ type: 'stream_message', streamId: 'one', message: negotiate });
    f.receive({ type: 'stream_message', streamId: 'one', message: negotiate });
    expect(f.sent).toContainEqual(expect.objectContaining({ type: 'stream_close', streamId: 'one', code: 1013 }));
    expect(f.failures).toEqual([]);
  });
});

async function takeControl(f: Awaited<ReturnType<typeof fixture>>, streamId: string): Promise<string> {
  const control = () => f.sent.filter((value: any) => value.type === 'stream_message' && value.streamId === streamId)
    .map((value: any) => JSON.parse(value.message)).filter((value: any) => value.type === 'session_control').at(-1)?.payload;
  await vi.waitFor(() => expect(control()).toBeDefined());
  f.receive({ type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: '1.5.0', type: 'session_control_request',
    payload: { agentId: 'agent-one', requestId: 'take-control', action: 'take_over', revision: control().revision } }) });
  await vi.waitFor(() => expect(control()?.access).toBe('control'));
  return control().token;
}
