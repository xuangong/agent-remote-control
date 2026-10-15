import 'fake-indexeddb/auto';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { App, type LabTransport } from '../App.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { promptText, render, setPromptText } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';

it('restores mobile conversation actions when its Host reconnects while Context is unmounted', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const baseUrl = 'http://127.0.0.1:6175';
  const agentId = replicaState.agent!.id;
  window.localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ agentId, nativeSessionId: 'native', providerId: 'dsh', title: 'Mobile conversation', hostId: 'host-1' }]));
  let online = false;
  const hosts = vi.fn(async () => ({ hosts: [{ id: 'local', name: 'Local runtime', online: true }, { id: 'host-1', name: 'My DSH', online }] }));
  const attachments: unknown[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/remote/hosts/host-1/attach') {
      attachments.push(JSON.parse(String(options?.body)));
      return Response.json({ agentId, nativeSessionId: 'native' });
    }
    if (path.endsWith('/catalog')) return Response.json({ items: [], hasMore: false, revision: '1' });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    return Response.json({ error: 'Not found' }, { status: 404 });
  };
  vi.stubGlobal('fetch', fetcher);
  const directory = new SessionDirectoryClient(baseUrl, fetcher, 'host-1');
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const controlRequests: string[] = [];
  const snapshot = { ...replicaState.agent!, providerId: 'dsh', runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'dsh', sessionId: 'native' } };
  const transport: LabTransport = {
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    listProviders: async () => [{ providerId: 'dsh', displayName: 'DSH' }],
    createAgent: async () => { throw new Error('This test opens an existing session.'); },
    resumeAgent: async () => { throw new Error('This test opens an existing session.'); },
    fetchSnapshot: async () => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot }),
    fetchTimeline: async () => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'history', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null,
      entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: (_agentId, listener) => {
      queueMicrotask(() => listener.onOpen());
      return { close() {}, send(message) {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
            agentId, revision: 'available', access: 'read_only', available: true,
          } });
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot });
        } else if (message.type === 'session_control_request') {
          controlRequests.push(message.payload.action);
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
            agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token',
          } });
        }
        else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
          type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      } };
    },
  };
  window.history.replaceState(null, '', `/?agent=${agentId}`);
  try {
    const container = await render(<App baseUrl={baseUrl} directory={directory} transport={transport} hostService={{ hosts, pair: vi.fn() }} actions={{ sendMessage }} />);
    expect(attachments).toEqual([{ providerId: 'dsh', nativeSessionId: 'native' }]);
    expect(controlRequests).toEqual(['acquire']);
    expect(container.querySelector('#lab-context')).toBeNull();
    const input = container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.getAttribute('aria-disabled')).not.toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
    const beforeReconnect = hosts.mock.calls.length;
    online = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hosts).toHaveBeenCalledTimes(beforeReconnect + 1);
    expect(container.querySelector('#lab-context')).toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => {
      setPromptText(input, 'After the Host reconnects');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    expect(submit.disabled, container.textContent ?? '').toBe(false);
    await act(async () => {
      submit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      submit.click();
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith('After the Host reconnects'));
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(promptText(input)).toBe('');
  } finally {
    window.localStorage.removeItem(`agent-remote-opened:${baseUrl}`);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('restores the Host and Provider directory for an opened remote conversation', async () => {
  const baseUrl = 'http://127.0.0.1:6175';
  const agentId = replicaState.agent!.id;
  window.localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ agentId, nativeSessionId: 'native', providerId: 'codex', title: 'Codex conversation', hostId: 'host-1' }]));
  const directory = new SessionDirectoryClient(baseUrl, vi.fn(async () => Response.json({ items: [], hasMore: false, revision: '1', workspaces: [] })) as typeof fetch);
  try {
    const container = await render(<App baseUrl={baseUrl} directory={directory} hostService={{
      hosts: async () => ({ hosts: [{ id: 'host-1', name: 'Codex Host', online: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }] }), pair: vi.fn(),
    }} initialState={{ ...replicaState, agent: { ...replicaState.agent!, providerId: 'codex' } }} initialSessionStatus="ready" />);
    expect(container.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('host-1');
    expect(container.querySelector<HTMLSelectElement>('#provider-select')?.selectedOptions[0]?.textContent).toBe('Codex');
    expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Codex · Codex Host');
    expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).not.toContain('Online');
  } finally { window.localStorage.removeItem(`agent-remote-opened:${baseUrl}`); }
});

it('polls quiet chat less often and refreshes immediately when discovery opens', async () => {
  vi.useFakeTimers();
  const hosts = vi.fn(async () => ({ hosts: [] }));
  const service = { hosts, pair: vi.fn() };
  const { useRemoteHosts } = await import('./useRemoteHosts.js');
  const { useState } = await import('react');
  function Harness() {
    const [discovery, setDiscovery] = useState(false);
    useRemoteHosts(service, true, discovery);
    return <button onClick={() => setDiscovery(true)}>Discover</button>;
  }
  try {
    const container = await render(<Harness />);
    expect(hosts).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(29_000));
    expect(hosts).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(hosts).toHaveBeenCalledTimes(2);
    await act(async () => container.querySelector('button')!.click());
    expect(hosts).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(hosts).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});
