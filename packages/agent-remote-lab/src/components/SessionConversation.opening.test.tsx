import 'fake-indexeddb/auto';
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport, RemoteServerMessage, RemoteTransportListener } from '@orchardworks/agent-client';
import { buildSnapshot, buildTailPage } from '@orchardworks/agent-client/testing';
import { DirectoryError, SessionDirectoryClient } from '../directory-client.js';
import { DraftStore } from '../draft-store.js';
import { SessionLocatorSynchronizingError, SessionViewOperationsContext } from '../session-view-operations.js';
import { sessionKey } from '../session-tree.js';
import { render, setPromptText } from '../test/setup.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionConversation } from './SessionConversation.js';

// A message sent at once after a session link opens, over a slow network (O44). The page paints a stand-in from the device store and
// takes the message; the Window's pane replaces it while the succession still confirms the session's locator, and attaches it a
// round trip later. Both are waits: the message is delivered once the session is ready, and only a failed open holds it as Not sent.

const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'slow', title: 'Slow' };
const agentId = 'slow-agent';
/** The Relay's answer time for the attach, as M1 measures it at a 300 ms round trip. */
const ATTACH_MS = 300;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A Relay that serves the session once attached: its Snapshot, granted control and an empty tail. It keeps and acknowledges every message sent. */
function relay(): { transport: RemoteAgentTransport; sent: Array<Extract<ClientMessage, { type: 'send_message' }>> } {
  const sent: Array<Extract<ClientMessage, { type: 'send_message' }>> = [];
  const snapshot = buildSnapshot({ id: agentId, providerId: target.providerId, nativeSessionId: target.nativeSessionId,
    runtimeInfo: { providerId: target.providerId, sessionId: target.nativeSessionId, status: 'idle' } });
  const transport = {
    fetchSnapshot: async () => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot }),
    fetchTimeline: async () => buildTailPage([], { agentId }),
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(_agent: string, listener: RemoteTransportListener) {
      const emit = (message: RemoteServerMessage) => listener.onMessage(message);
      const control = (requestId?: string) => emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, ...(requestId ? { requestId } : {}), revision: 'control', access: 'control', available: false, token: 'control-token' } });
      queueMicrotask(() => listener.onOpen());
      return { close() {}, send(message: ClientMessage) {
        if (message.type === 'negotiate') {
          emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot });
          control();
        } else if (message.type === 'session_control_request') control(message.payload.requestId);
        else if (message.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        else if (message.type === 'send_message') {
          sent.push(message);
          emit({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: { agentId, requestId: message.payload.requestId, command: 'send_message' } });
        }
      } };
    },
  } as unknown as RemoteAgentTransport;
  return { transport, sent };
}

/**
 * The page of a session link: first the stand-in, then the Window's pane, whose locator stays unconfirmed until `confirm` and whose
 * attach answers `ATTACH_MS` later with `answer`.
 */
async function sessionLink(answer: () => Promise<{ agentId: string; nativeSessionId: string }>) {
  vi.useFakeTimers();
  const { transport, sent } = relay();
  const scope = `slow-open-${crypto.randomUUID()}`;
  const directory = new SessionDirectoryClient('http://fixture');
  const attach = vi.spyOn(directory, 'attach').mockImplementation(() => new Promise((resolve, reject) => setTimeout(() => answer().then(resolve, reject), ATTACH_MS)));
  let showPane!: () => void, confirm!: () => void;
  function Page() {
    const [pane, setPane] = useState<'stand-in' | 'window'>('stand-in');
    const [confirmed, setConfirmed] = useState(false);
    showPane = () => setPane('window'); confirm = () => setConfirmed(true);
    return <SessionViewOperationsContext.Provider value={{ storageScope: scope, transport, enabled: true, directory: () => { throw new Error('Unused'); }, refreshSettled: async () => {},
      resolveTarget: () => { if (!confirmed) throw new SessionLocatorSynchronizingError(); return { target }; } }}>
      {pane === 'stand-in' ? <LabWorkbench key="stand-in" draftOnly opening draftSessionKey={sessionKey(target)} sessionStatus="connecting" actions={{}} />
        : <SessionConversation key="window" target={target} viewId="view" familyRoot={false} entries={[target]} onNavigate={async () => {}}
          directoryFor={() => directory} baseUrl="http://fixture" storageScope={scope} hostLabel="Host" compact={false} active offline={false}
          transport={transport} draftStore={new DraftStore(scope)} />}
    </SessionViewOperationsContext.Provider>;
  }
  const container = await render(<Page />);
  const send = async (text: string) => {
    const input = container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    await act(async () => { setPromptText(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  };
  const waiting = () => [...container.querySelectorAll('[data-testid="pending-send"]')].map(item => item.textContent ?? '');
  await send('Sent at once');
  return { container, sent, attach, waiting, send, advance: (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); }),
    showPane: () => act(async () => showPane()), confirm: () => act(async () => confirm()) };
}

it('delivers messages sent while the session opens slowly, in order, once the session is ready, and never says Not sent', async () => {
  const link = await sessionLink(async () => ({ agentId, nativeSessionId: target.nativeSessionId }));
  expect(link.waiting()).toEqual([expect.stringContaining('Sending')]);
  await link.showPane();
  await link.advance(100);
  // The Window's pane takes the stand-in's message, and one more, while its locator is still being confirmed.
  await link.send('Typed into the pane');
  expect(link.waiting()).toEqual([expect.stringContaining('Sending'), expect.stringContaining('Sending')]);
  expect(link.attach).not.toHaveBeenCalled();
  await link.confirm();
  await link.advance(ATTACH_MS / 2);
  expect(link.waiting()).toHaveLength(2);
  expect(link.sent).toEqual([]);
  await link.advance(ATTACH_MS);
  expect(link.attach).toHaveBeenCalledOnce();
  expect(link.sent.map(message => 'text' in message.payload ? message.payload.text : message.payload.content)).toEqual(['Sent at once', 'Typed into the pane']);
  expect(link.waiting()).toEqual([]);
  expect(link.container.textContent).not.toContain('Not sent');
});

it('holds a waiting message as Not sent when the session could not be opened, and sends nothing', async () => {
  const link = await sessionLink(async () => { throw new DirectoryError('The Host refused the session.', 'session_unavailable', 503); });
  await link.showPane();
  await link.confirm();
  await link.advance(ATTACH_MS);
  expect(link.waiting()).toEqual([expect.stringContaining('Not sent')]);
  expect(link.container.querySelector('[role="alert"]')?.textContent).toContain('The Host refused the session.');
  await link.advance(60_000);
  expect(link.sent).toEqual([]);
});
