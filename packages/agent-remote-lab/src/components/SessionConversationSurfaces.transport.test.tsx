import 'fake-indexeddb/auto';
import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { HttpWebSocketTransport, remoteSessionState, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { createRecordedValidationServer } from '../server/recorded.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';
import { DraftStore } from '../draft-store.js';
import { render, unmount, setPromptText, promptText } from '../test/setup.js';
import type { WorkbenchMode } from '../workbench-mode.js';
import { SessionConversationMount, SessionConversationSurfaces, type SessionSurfaceDescriptor } from './SessionConversationSurfaces.js';

async function fixture() {
  const server = createRecordedValidationServer();
  const { url } = await server.http.listen();
  const sockets: WebSocket[] = [], sends: unknown[] = [];
  const transport = new HttpWebSocketTransport(url, { sessionChannels: true, webSocketFactory: address => {
    const socket = new WebSocket(address, { origin: process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175' });
    sockets.push(socket); return socket as unknown as WebSocketLike;
  } });
  transport.onProtocolMessage(event => { if (event.direction === 'outbound' && event.message.type === 'send_message') sends.push(event.message); });
  const created = await transport.createAgent('surface-agent', 'recorded', { sessionId: 'surface-native' });
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: created.payload.sessionId, title: 'Surface session', agentId: 'surface-agent' };
  const connections = new ConversationConnections(transport), drafts = new DraftStore(url);
  let update!: (next: Partial<{ mode: WorkbenchMode; claimed: boolean; disconnected: boolean; rebound: boolean }>) => void;
  function Harness() {
    const [state, set] = useState({ mode: 'window' as WorkbenchMode, claimed: true, disconnected: false, rebound: false });
    update = next => set(current => ({ ...current, ...next }));
    const descriptor: SessionSurfaceDescriptor = { slotId: 'composition-slot', titleInteraction: undefined, props: {
      storageScope: url, baseUrl: url, target, attachedSession: target, attachmentManaged: true, viewId: 'composition-slot', windowViewId: 'view',
      transport, draftStore: drafts, draftBinding: { store: drafts, key: 'text-owner' },
      imageDraftBinding: { scope: url, key: JSON.stringify([url, 'image-owner']) }, displayBinding: { scope: url, key: 'display-owner' },
      hostLabel: 'Host', compact: false, active: true, offline: false, familyRoot: true, visible: true, entries: [target], onNavigate: async () => {},
      sessionPresentation: context => state.disconnected ? { sessionStatus: 'disconnected', sessionState: remoteSessionState(context.state, 'disconnected') } : {},
    } };
    return <SessionViewOperationsContext.Provider value={{ storageScope: url, transport, enabled: true,
      resolveTarget: source => ({ target: state.rebound ? { ...source, nativeSessionId: 'replacement' } : source }),
      directory: () => { throw new Error('Unused'); }, refreshSettled: async () => {} }}>
      <ConversationConnectionScope.Provider value={connections}><SessionConversationSurfaces scope={url} transport={transport} mode={state.mode}>
      {(['window', 'bot'] as const).map(mode => <section key={mode} data-destination={mode}>{state.claimed ? <SessionConversationMount mode={mode}
        active={state.mode === mode} descriptor={{ ...descriptor, props: { ...descriptor.props, fixedDisplayMode: mode === 'bot' ? 'content' : undefined } }} /> : null}</section>)}
    </SessionConversationSurfaces></ConversationConnectionScope.Provider></SessionViewOperationsContext.Provider>;
  }
  const container = await render(<Harness />);
  await act(async () => { await vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'), { timeout: 5000 }); });
  const client = connections.find(target)!.client;
  async function enter(text: string) {
    await act(async () => {
      const prompt = container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
      setPromptText(prompt, text); prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function submit() {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
  }
  return { container, client, connections, sockets, sends, drafts, enter, submit,
    async update(next: Parameters<typeof update>[0]) { await act(async () => update(next)); },
    async close() { await unmount(container); connections.clear(); transport.dispose(); await server.close(); },
  };
}

it.each([true, false])('keeps one real stream and in-flight editor through locator changes (unclaimed: %s)', async unclaimed => {
  const f = await fixture();
  let finish!: () => void;
  const receipt = new Promise<void>(resolve => { finish = resolve; });
  const original = f.client.sendMessage.bind(f.client);
  const send = vi.spyOn(f.client, 'sendMessage').mockImplementation(async (...args) => { const result = await original(...args); await receipt; return result; });
  try {
    const prompt = f.container.querySelector('[data-testid="prompt-input"]');
    await f.enter('Exactly one operation'); await f.submit();
    await act(async () => { await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 5000 }); });
    await f.update({ mode: 'bot' });
    expect(f.container.querySelector('[data-destination="bot"] [data-testid="prompt-input"]')).toBe(prompt);
    expect(f.container.querySelector('[data-testid="prompt-submit"]')?.getAttribute('aria-label')).toBe('Sending…');
    await f.update({ claimed: !unclaimed, rebound: true });
    expect(prompt?.isConnected).toBe(true);
    if (unclaimed) expect(prompt?.closest('[inert]')).not.toBeNull();
    expect(f.connections.agentIds).toEqual(['surface-agent']);
    if (!unclaimed) await f.update({ rebound: false });
    await act(async () => { finish(); await vi.waitFor(() => expect(f.sends).toHaveLength(1), { timeout: 5000 }); });
    if (unclaimed) await vi.waitFor(async () => { await act(async () => {}); expect(f.container.querySelector('.lab-session-conversation-host')).toBeNull(); }, { timeout: 5000 });
    else expect(f.container.querySelector('[data-testid="prompt-input"]')).toBe(prompt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.sockets).toHaveLength(1);
    expect(f.connections.agentIds).toEqual(unclaimed ? [] : ['surface-agent']);
  } finally { await act(async () => finish()); await f.close(); }
});

it('keeps waiting input parked until a destination returns and never replays an uncertain dispatch', async () => {
  const f = await fixture();
  const original = f.client.sendMessage.bind(f.client);
  const send = vi.spyOn(f.client, 'sendMessage').mockImplementation(async (...args) => { await original(...args); throw new Error('Delivery receipt is unknown.'); });
  try {
    await f.update({ disconnected: true });
    await f.enter('One queued operation'); await f.submit();
    expect(f.container.textContent).toContain('One queued operation');
    expect(send).not.toHaveBeenCalled();
    await f.enter('A separate editable draft');
    const prompt = f.container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    await f.update({ claimed: false, disconnected: false });
    expect(prompt.closest('[hidden]')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
    await f.update({ claimed: true, mode: 'bot' });
    await vi.waitFor(async () => { await act(async () => {}); expect(f.container.textContent).toContain('Delivery receipt is unknown.'); }, { timeout: 5000 });
    expect(f.sends).toHaveLength(1);
    expect(f.container.querySelector('[data-testid="prompt-input"]')).toBe(prompt);
    expect(promptText(prompt)).toBe('A separate editable draft');
    expect(f.drafts.get('text-owner')).toBe('A separate editable draft');
    await f.update({ rebound: true });
    expect(prompt.isConnected).toBe(true);
    expect(f.container.textContent).toContain('Delivery receipt is unknown.');
    await f.update({ claimed: false });
    expect(prompt.isConnected).toBe(true);
    expect(prompt.closest('[inert]')).not.toBeNull();
    await f.update({ claimed: true, mode: 'window', rebound: false });
    expect(f.container.textContent).toContain('Delivery receipt is unknown.');
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.sockets).toHaveLength(1);
  } finally { await f.close(); }
});
