import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { AgentReplica, type RemoteAgentTransport, type RemoteTransportListener } from '@orchardworks/agent-remote-web';
import type { AgentSnapshot, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { SideConversation } from './SideConversation.js';
import { ForkStore } from '../session-forks.js';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';

function fixture() {
  const listeners = new Map<string, RemoteTransportListener>();
  const closes: string[] = [];
  const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id, status: 'running', runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: id },
  } });
  const page = (id: string): HistoryPage => ({ protocolVersion: '1.5.0', type: 'timeline_page', payload: {
    agentId: id, requestId: 'history', direction: 'tail', epoch: `epoch-${id}`, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: `epoch-${id}`, seq: 1 }, endCursor: { epoch: `epoch-${id}`, seq: 1 },
    entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-20T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'assistant_message', text: `Conversation ${id}` } }],
    hasOlder: false, hasNewer: false, error: null,
  } });
  const fetchTimeline = vi.fn<RemoteAgentTransport['fetchTimeline']>(async id => page(id));
  let paused = false;
  const connect = vi.fn<RemoteAgentTransport['connect']>((id, listener) => {
    listeners.set(id, listener);
    if (!paused) queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
    return { close: () => { closes.push(id); listeners.delete(id); }, send: message => {
      if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
    } };
  });
  const transport: RemoteAgentTransport = { connect, fetchSnapshot: async id => snapshot(id), fetchTimeline, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  return { transport, connect, listeners, closes, fetchTimeline, pause: () => { paused = true; }, resume: (id: string) => { listeners.get(id)!.onOpen(); listeners.get(id)!.onMessage(snapshot(id)); } };
}

it('keeps simultaneous side streams through focus and hidden-window changes and retains full state on disconnect', async () => {
  const f = fixture();
  const store = new ForkStore('side-streams');
  let focus!: (id: string) => void;
  function Harness() {
    const [focused, setFocus] = useState('a'); focus = setFocus;
    return <>{['a', 'b'].map(id => <SideConversation key={id}
      session={{ agentId: id, providerId: 'recorded', nativeSessionId: id, title: id }}
      transport={f.transport} store={store} draft="" onDraftChange={() => {}} onClose={() => {}} onOpenSource={() => {}} onOpenFork={() => {}}
      onFork={async () => { throw new Error('Unexpected fork'); }} focused={focused === id} expanded={focused === id} />)}</>;
  }
  const container = await render(<Harness />);
  expect(f.connect).toHaveBeenCalledTimes(2);
  await act(async () => focus('b'));
  await act(async () => focus('a'));
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.closes).toEqual([]);
  await act(async () => f.listeners.get('a')!.onDisconnect());
  const first = container.querySelector<HTMLElement>('.lab-side-conversation')!;
  expect(first.textContent).toContain('Conversation a');
  expect(first.querySelector('[data-session-status]')?.getAttribute('data-session-status')).toBe('running');
  expect(first.textContent).toContain('Reconnecting');
});

it('displays cached content before reconnecting and resumes a reopened side window from its epoch and cursor', async () => {
  const f = fixture();
  const replica = new AgentReplica();
  const store = new ForkStore('side-cache');
  let show!: (visible: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(true); show = setOpen;
    return open ? <SideConversation replica={replica}
      session={{ agentId: 'side', providerId: 'recorded', nativeSessionId: 'side', title: 'Side' }}
      transport={f.transport} store={store} draft="" onDraftChange={() => {}} onClose={() => {}} onOpenSource={() => {}} onOpenFork={() => {}}
      onFork={async () => { throw new Error('Unexpected fork'); }} /> : null;
  }
  const container = await render(<Harness />);
  expect(container.textContent).toContain('Conversation side');
  expect(f.fetchTimeline.mock.calls[0]?.[1]).toBe('tail');
  await act(async () => show(false));
  expect(f.closes).toEqual(['side']);
  f.pause();
  await act(async () => show(true));
  expect(container.textContent).toContain('Conversation side');
  expect(f.fetchTimeline).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  let finishHistory!: (value: HistoryPage) => void;
  f.fetchTimeline.mockImplementationOnce(() => new Promise(resolve => { finishHistory = resolve; }));
  await act(async () => f.resume('side'));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  const previousPage = await f.fetchTimeline.mock.results[0]!.value;
  await act(async () => finishHistory(previousPage));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(false);
  expect(f.fetchTimeline.mock.calls[1]?.slice(0, 3)).toEqual(['side', 'after', { epoch: 'epoch-side', seq: 1 }]);
});


it('reuses a tracked subscription after its side window unmounts and releases it after untracking', async () => {
  const f = fixture();
  const connections = new ConversationConnections(f.transport);
  const session = { agentId: 'side', providerId: 'recorded', nativeSessionId: 'side', title: 'Side' };
  connections.retainTracked([session]);
  const store = new ForkStore('side-retained');
  let show!: (value: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(true); show = setOpen;
    return <ConversationConnectionScope.Provider value={connections}>{open ? <SideConversation
      session={session} transport={f.transport} store={store} onClose={() => {}} onOpenSource={() => {}} onOpenFork={() => {}}
      onFork={async () => { throw new Error('Unexpected fork'); }} /> : null}</ConversationConnectionScope.Provider>;
  }
  try {
    const container = await render(<Harness />);
    expect(f.connect).toHaveBeenCalledOnce();
    await act(async () => show(false));
    expect(f.closes).toEqual([]);
    await act(async () => show(true));
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.fetchTimeline).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Conversation side');
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Working');
    await act(async () => connections.retainTracked([]));
    expect(f.closes).toEqual([]);
    await act(async () => show(false));
    expect(f.closes).toEqual(['side']);
  } finally { await act(async () => connections.clear()); }
});
