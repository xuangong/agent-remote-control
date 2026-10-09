import { createServer, type ServerResponse } from 'node:http';
import { act, useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentProviderAdapter, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { ClientMessage, SessionChannelClientMessage } from '@orchardworks/agent-remote-protocol';
import { HttpWebSocketTransport, RemoteSessionClient, AgentReplica, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { AgentComposer } from '@orchardworks/agent-remote-web/react';
import { GatewayController } from './GatewayController.js';
import { ConversationConnections, ConversationConnectionScope } from './conversation-connections.js';
import { useConversationSession } from './hooks/useConversationSession.js';
import { workspaceFetch, workspaceSocket } from './workspace-access.js';
import { createProtocolValidationServer } from './server.js';
import { render, unmount } from './test/setup.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear();
});

function observation(text: string): ProviderStreamItem {
  return { type: 'observation', sourceKey: text, occurredAt: Date.now(), delivery: 'live',
    event: { type: 'timeline', provider: 'fixture', item: { type: 'assistant_message', text, messageId: text } } };
}

/** Browser lifecycle events are simulated; HTTP, WebSocket, Relay, control and recovery are real. */
async function fixture(sessionControl: 'shared' | 'exclusive' = 'shared', composer = false) {
  localStorage.clear(); sessionStorage.clear();
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const visibilityChange = async (next: 'visible' | 'hidden') => {
    visibility = next;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  };
  const entries: ProviderStreamItem[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const publish = (text: string) => { entries.push(observation(text)); wake?.(); };
  const sendMessage = vi.fn(async () => {});
  const session: AgentSession = {
    capabilities: { sessionControl, history: true, sendMessage: true, steer: false, cancel: false,
      readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() {
      yield observation('Before background'); yield { type: 'history_boundary' };
      while (!stopped) {
        if (!entries.length) await new Promise<void>(resolve => { wake = resolve; });
        while (entries.length) yield entries.shift()!;
      }
    },
    sendMessage, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'fixture', sessionId: 'native', status: 'idle' }; },
    async dispose() { stopped = true; wake?.(); },
  };
  const provider: AgentProviderAdapter = { descriptor: { providerId: 'fixture', displayName: 'Fixture' },
    createSession: async () => session, resumeSession: async () => session };
  const relay = createProtocolValidationServer({ providers: [provider], labOrigin: window.location.origin });
  const { url: relayUrl } = await relay.http.listen();
  cleanups.push(() => relay.close());

  const basePath = '/u/' + 'a'.repeat(64) + '/';
  const access = () => ({ basePath, expiresAt: Date.now() + 120_000, refreshAfterMs: 60_000 });
  const renewals: ServerResponse[] = [];
  const accessPaths: string[] = [];
  const auth = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    accessPaths.push(request.url!);
    if (accessPaths.length > 1) renewals.push(response);
    else response.end(JSON.stringify(access()));
  });
  await new Promise<void>(resolve => auth.listen(0, '127.0.0.1', resolve));
  const authUrl = `http://127.0.0.1:${(auth.address() as { port: number }).port}`;
  cleanups.push(async () => {
    for (const response of renewals) if (!response.writableEnded) response.end(JSON.stringify(access()));
    auth.closeAllConnections();
    await new Promise<void>(resolve => auth.close(() => resolve()));
  });
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', ((input, init) => {
    const incoming = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const target = incoming.pathname.startsWith('/auth/')
      ? authUrl + incoming.pathname
      : relayUrl + incoming.pathname.replace(basePath, '/') + incoming.search;
    return nativeFetch(target, init);
  }) satisfies typeof fetch);

  const sent: Array<{ socket: NetworkSocket; frame: SessionChannelClientMessage }> = [];
  const received: Array<{ socket: NetworkSocket; type: string }> = [];
  const sockets: NetworkSocket[] = [];
  const inboundDelayMs = 60;
  let latency = { inbound: inboundDelayMs, outbound: 0 };
  let offline = false;
  class NetworkSocket implements WebSocketLike {
    readonly native: WebSocket;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    blackhole = false;
    dropAcknowledgements = false;
    closed = false;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    constructor(url: string) {
      const incoming = new URL(url);
      this.native = new WebSocket(relayUrl.replace('http:', 'ws:') + incoming.pathname.replace(basePath, '/') + incoming.search,
        { origin: window.location.origin });
      sockets.push(this);
      // Wire events can resolve recovery promises that publish state in later microtasks.
      this.native.on('open', async () => { await act(async () => this.onopen?.({})); });
      this.native.on('message', data => {
        const serialized = String(data);
        const frame = JSON.parse(serialized);
        if (offline || this.blackhole || (this.dropAcknowledgements && frame.message?.type === 'command_acknowledged')) return;
        const timer = setTimeout(async () => {
          this.timers.delete(timer);
          if (!this.closed && !offline && !this.blackhole) {
            received.push({ socket: this, type: frame.type });
            await act(async () => this.onmessage?.({ data: serialized }));
          }
        }, latency.inbound);
        this.timers.add(timer);
      });
      this.native.on('close', async () => { if (!this.closed) await act(async () => this.onclose?.({})); });
      this.native.on('error', async error => { await act(async () => this.onerror?.(error)); });
    }
    get readyState() { return this.native.readyState; }
    get bufferedAmount() { return this.native.bufferedAmount; }
    send(data: string) {
      sent.push({ socket: this, frame: JSON.parse(data) });
      if (offline || this.blackhole) return;
      if (!latency.outbound) { this.native.send(data); return; }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.closed && !offline && !this.blackhole && this.native.readyState === WebSocket.OPEN) this.native.send(data);
      }, latency.outbound);
      this.timers.add(timer);
    }
    close() {
      this.closed = true;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear(); this.native.close();
    }
  }
  vi.stubGlobal('WebSocket', NetworkSocket);
  cleanups.push(() => { for (const socket of sockets) { socket.close(); socket.native.terminate(); } });

  const baseUrl = new URL(basePath, window.location.origin).href;
  const transport = new HttpWebSocketTransport(baseUrl, { sessionChannels: true, fetch: workspaceFetch, webSocketFactory: workspaceSocket });
  cleanups.push(() => transport.dispose());
  const creator = new HttpWebSocketTransport(relayUrl, { fetch: nativeFetch });
  await creator.createAgent('agent', 'fixture', { sessionId: 'native' });
  const opened = { agentId: 'agent', providerId: 'fixture', nativeSessionId: 'native', title: 'Fixture' };
  const connections = new ConversationConnections(transport);
  cleanups.push(() => connections.clear());
  let current!: ReturnType<typeof useConversationSession>;
  const statuses: string[] = [];
  function SessionView() {
    current = useConversationSession(opened, transport);
    useEffect(() => { statuses.push(current.status); }, [current.status]);
    return <>{composer
      ? <AgentComposer state={current.state} sessionState={current.sessionState} onSendMessage={current.actions.sendMessage} />
      : <input aria-label="Draft" defaultValue="Keep this draft" />}<output>{current.status}</output></>;
  }
  const view = await render(<GatewayController>{() => <ConversationConnectionScope.Provider value={connections}><SessionView /></ConversationConnectionScope.Provider>}</GatewayController>);
  cleanups.push(() => unmount(view));
  const waitFor = async (assertion: () => void, timeout = 5000) => {
    const deadline = performance.now() + timeout;
    for (;;) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      try { assertion(); return; }
      catch (error) { if (performance.now() >= deadline) throw error; }
    }
  };
  await waitFor(() => expect(current?.status, view.textContent ?? '').toBe('ready'));
  const primary = connections.find(opened)!;
  const commands = (type: ClientMessage['type']) => sent.flatMap(({ frame }) => frame.type === 'message' && frame.message.type === type ? [frame.message] : []);
  const subscriptions = () => sent.filter(({ frame }) => frame.type === 'subscribe');
  const completeRenewals = async () => {
    await act(async () => { for (const response of renewals) if (!response.writableEnded) response.end(JSON.stringify(access())); });
  };
  return { relay, relayUrl, transport, view, sockets, sent, received, statuses, renewals, accessPaths, primary, sendMessage, publish,
    setLatency: (inbound: number, outbound: number) => { latency = { inbound, outbound }; },
    setOffline: (value: boolean) => { offline = value; },
    current: () => current, commands, subscriptions, visibilityChange, completeRenewals, waitFor, inboundDelayMs };
}

it('keeps a healthy authorized session usable while foreground access renewal is pending', async () => {
  const app = await fixture();
  const draft = app.view.querySelector('input')!;
  draft.value = 'Unsent foreground draft';
  const counts = {
    sockets: app.sockets.length, subscriptions: app.subscriptions().length,
    control: app.commands('session_control_request').length, history: app.commands('timeline_request').length,
  };
  app.statuses.length = 0;
  await app.visibilityChange('hidden');
  const resumedAt = performance.now();
  await app.visibilityChange('visible');
  await app.waitFor(() => expect(app.renewals).toHaveLength(1));
  expect(app.accessPaths).toEqual(['/auth/status', '/auth/status']);
  expect(app.renewals[0]!.writableEnded).toBe(false);
  expect(app.current().status).toBe('ready');
  await act(async () => { await app.current().actions.sendMessage!('Foreground input'); });
  const acknowledgementMs = Math.round(performance.now() - resumedAt);
  expect(app.sendMessage).toHaveBeenCalledOnce();
  expect(app.renewals[0]!.writableEnded).toBe(false);
  expect(app.statuses).toEqual([]);
  expect(app.view.querySelector('input')).toBe(draft);
  expect(draft.value).toBe('Unsent foreground draft');
  expect({
    sockets: app.sockets.length, subscriptions: app.subscriptions().length,
    control: app.commands('session_control_request').length, history: app.commands('timeline_request').length,
  }).toEqual(counts);
  expect(app.sent.filter(({ frame }) => frame.type === 'ping')).toHaveLength(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.max(0, 600 - (performance.now() - resumedAt)))); });
  await app.completeRenewals();
  console.info('Foreground healthy channel', { inboundDelayMs: app.inboundDelayMs, accessResponseDelayMs: 600, acknowledgementMs,
    additionalSockets: 0, additionalControlRequests: 0, additionalHistoryRequests: 0 });
}, 10_000);

it('replaces a silent dead foreground channel, recovers its cursor and does not replay an uncertain input', async () => {
  const app = await fixture();
  const socket = app.sockets[0]!;
  socket.dropAcknowledgements = true;
  let rejection: unknown;
  let input!: Promise<void>;
  await act(async () => { input = app.primary.client.sendMessage('Accepted before the receipt was lost').then(() => undefined, error => { rejection = error; }); });
  await app.waitFor(() => expect(app.sendMessage).toHaveBeenCalledOnce());
  const cursor = { epoch: app.primary.replica.getState().timeline.epoch, seq: app.primary.replica.getState().timeline.nextSeq - 1 };
  await app.visibilityChange('hidden');
  socket.blackhole = true;
  app.publish('Arrived while the browser was away');
  const resumedAt = performance.now();
  await app.visibilityChange('visible');
  await app.waitFor(() => {
    expect(app.sockets).toHaveLength(2);
    expect(app.current().status).toBe('ready');
    expect(app.primary.replica.getState().timeline.entries.map(entry => entry.item)).toMatchObject([
      { type: 'assistant_message', text: 'Before background' },
      { type: 'assistant_message', text: 'Arrived while the browser was away' },
    ]);
  }, 8000);
  const recoveryMs = Math.round(performance.now() - resumedAt);
  await input;
  expect(rejection).toMatchObject({ code: 'connection_disconnected' });
  expect(app.primary.replica.getState().outgoingMessages?.[0]?.status).toBe('unconfirmed');
  expect(app.commands('send_message')).toHaveLength(1);
  expect(app.sendMessage).toHaveBeenCalledOnce();
  const history = app.commands('timeline_request');
  expect(history).toHaveLength(2);
  expect(history[1]).toMatchObject({ payload: { direction: 'after', cursor } });
  expect(app.renewals[0]!.writableEnded).toBe(false);
  expect(app.primary.replica.getState().sessionControl?.access).toBe('control');
  app.publish('Live after recovery');
  await app.waitFor(() => expect(app.primary.replica.getState().timeline.entries).toHaveLength(3));
  await app.completeRenewals();
  console.info('Foreground dead channel', { inboundDelayMs: app.inboundDelayMs, recoveryMs,
    additionalSockets: 1, historyDirection: 'after', nativeInputDispatches: app.sendMessage.mock.calls.length });
}, 15_000);

it('keeps both pages authorized when another page opens while the foreground channel is unreachable', async () => {
  const app = await fixture('exclusive');
  expect(app.primary.replica.getState().sessionControl?.access).toBe('control');
  await app.visibilityChange('hidden');
  app.sockets[0]!.blackhole = true;
  const transport = new HttpWebSocketTransport(app.relayUrl, { sessionChannels: true,
    webSocketFactory: url => new WebSocket(url, { origin: window.location.origin }) as unknown as WebSocketLike });
  cleanups.push(() => transport.dispose());
  const replica = new AgentReplica();
  const otherPage = new RemoteSessionClient('agent', transport, replica, { requireSessionControl: true, clientKind: 'web' });
  cleanups.push(() => otherPage.stop());
  let status = '';
  otherPage.subscribeStatus(value => { status = value; });
  otherPage.start();
  await app.waitFor(() => expect(status).toBe('ready'));
  expect(replica.getState().sessionControl?.access).toBe('control');
  await otherPage.sendMessage('Other page while the first is away');
  await app.visibilityChange('visible');
  await app.waitFor(() => {
    expect(app.sockets).toHaveLength(2);
    expect(app.current().status).toBe('ready');
    expect(app.primary.replica.getState().sessionControl?.access).toBe('control');
  }, 8000);
  expect(app.current().sessionState.operations.send_message.allowed).toBe(true);
  let input!: ReturnType<RemoteSessionClient['sendMessage']>;
  await act(async () => { input = app.primary.client.sendMessage('First page after foreground recovery'); });
  await input;
  await otherPage.sendMessage('Other page still usable');
  expect(app.sendMessage.mock.calls).toEqual([['Other page while the first is away'], ['First page after foreground recovery'], ['Other page still usable']]);
  expect(replica.getState().sessionControl?.access).toBe('control');
  await app.completeRenewals();
}, 15_000);

async function fillComposer(view: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    const input = view.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitComposer(view: HTMLElement): Promise<void> {
  await act(async () => {
    const button = view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    expect(button.disabled).toBe(false);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    button.click();
  });
}

it('keeps the live composer and draft through a healthy foreground probe on an 1800 ms RTT link', async () => {
  const app = await fixture('shared', true);
  const draft = app.view.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await fillComposer(app.view, 'Draft before switching apps');
  const controls = app.commands('session_control_request').length;
  const histories = app.commands('timeline_request').length;
  app.statuses.length = 0;
  await app.visibilityChange('hidden');
  app.setLatency(900, 900);
  const resumedAt = performance.now();
  await app.visibilityChange('visible');
  expect(draft.disabled).toBe(false);
  expect(draft.readOnly).toBe(false);
  expect(draft.value).toBe('Draft before switching apps');
  await fillComposer(app.view, 'Continue typing on the slow link');
  await app.waitFor(() => expect(app.received.filter(frame => frame.type === 'pong')).toHaveLength(1), 4000);
  const probeCompletedMs = Math.round(performance.now() - resumedAt);
  expect(app.view.querySelector('[data-testid="prompt-input"]')).toBe(draft);
  expect(draft.value).toBe('Continue typing on the slow link');
  expect(app.statuses).toEqual([]);
  expect(app.sockets).toHaveLength(1);
  expect(app.subscriptions()).toHaveLength(1);
  expect(app.commands('session_control_request')).toHaveLength(controls);
  expect(app.commands('timeline_request')).toHaveLength(histories);
  expect(app.renewals[0]!.writableEnded).toBe(false);
  await submitComposer(app.view);
  await app.waitFor(() => {
    expect(app.sendMessage.mock.calls).toEqual([['Continue typing on the slow link']]);
    expect(draft.value).toBe('');
  }, 4000);
  expect(app.commands('send_message')).toHaveLength(1);
  await app.completeRenewals();
  console.info('Foreground slow healthy link', { injectedRttMs: 1800, probeCompletedMs,
    additionalSockets: 0, additionalControlRequests: 0, additionalHistoryRequests: 0 });
}, 15_000);

it('keeps offline composer inputs editable and sends its pending queue once after authoritative recovery', async () => {
  const app = await fixture('shared', true);
  app.setOffline(true);
  await act(async () => app.sockets[0]!.native.terminate());
  await app.waitFor(() => expect(app.current().status).not.toBe('ready'));
  const draft = app.view.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  expect(draft.disabled).toBe(false);
  expect(draft.readOnly).toBe(false);
  for (const text of ['First input while offline', 'Second input while offline']) {
    await fillComposer(app.view, text);
    await submitComposer(app.view);
    expect(draft.value).toBe('');
  }
  const pending = () => [...app.view.querySelectorAll('[data-testid="pending-send"]')];
  expect(pending().map(item => item.querySelector('.agent-pending-text')?.textContent)).toEqual([
    'First input while offline', 'Second input while offline',
  ]);
  expect(app.sendMessage).not.toHaveBeenCalled();
  expect(app.commands('send_message')).toHaveLength(0);
  await fillComposer(app.view, 'Keep the next unsent draft');
  app.setLatency(400, 400);
  const onlineAt = performance.now();
  await act(async () => {
    app.setOffline(false);
    for (const socket of app.sockets) socket.native.terminate();
    window.dispatchEvent(new Event('online'));
  });
  await app.waitFor(() => {
    expect(app.current().status).toBe('ready');
    expect(pending()).toHaveLength(0);
  }, 8000);
  const queueDrainedMs = Math.round(performance.now() - onlineAt);
  expect(app.sendMessage.mock.calls).toEqual([['First input while offline'], ['Second input while offline']]);
  expect(app.commands('send_message')).toHaveLength(2);
  expect(app.primary.replica.getState().sessionControl?.access).toBe('control');
  expect(app.view.querySelector('[data-testid="prompt-input"]')).toBe(draft);
  expect(draft.value).toBe('Keep the next unsent draft');
  await app.visibilityChange('hidden');
  const previousPongs = app.received.filter(frame => frame.type === 'pong').length;
  await app.visibilityChange('visible');
  await app.waitFor(() => expect(app.received.filter(frame => frame.type === 'pong')).toHaveLength(previousPongs + 1));
  expect(app.sendMessage).toHaveBeenCalledTimes(2);
  expect(app.commands('send_message')).toHaveLength(2);
  await app.completeRenewals();
  console.info('Offline composer queue', { injectedRttMs: 800, queueDrainedMs, nativeInputDispatches: 2,
    pendingMessages: pending().length, preservedDraft: draft.value });
}, 15_000);
