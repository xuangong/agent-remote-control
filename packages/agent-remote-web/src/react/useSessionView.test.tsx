import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer.js';
import { AgentReplica } from '../replica/store.js';
import type { RemoteSessionClient, RemoteSessionStatus } from '../client/remote-session-client.js';
import type { RemoteAgentTransport } from '../client/transport.js';
import { render, rerender, unmount } from '../test/setup.js';
import { useSessionView, type SessionConnectionSource } from './useSessionView.js';

it('leases neutral session connections and preserves deferred send actions across reconnects', async () => {
  let publishStatus: (status: RemoteSessionStatus) => void = () => {};
  const sendMessage = vi.fn(async () => {}), release = vi.fn();
  const unsubscribeStatus = vi.fn();
  const client = { subscribeSessionState(listener: (state: RemoteSessionState) => void) { publishStatus = status => listener(remoteSessionState(new AgentReplica().getState(), status)); publishStatus('ready'); return unsubscribeStatus; }, sendMessage } as unknown as RemoteSessionClient;
  const source: SessionConnectionSource = { acquire: vi.fn(() => ({ client, replica: new AgentReplica(), release })) };
  const transport = {} as RemoteAgentTransport;
  let result: ReturnType<typeof useSessionView>;
  function View({ enabled = true }: { enabled?: boolean }) {
    result = useSessionView({ agentId: 'session', transport, source, enabled });
    return <span>{result.status}</span>;
  }
  const container = await render(<View />);
  expect(container.textContent).toBe('ready');
  await act(async () => publishStatus('disconnected'));
  expect(result!.actions.sendMessage).toBeDefined();
  expect(result!.actions.setPlanning).toBeUndefined();
  await act(async () => result!.actions.sendMessage!('Keep pending input'));
  expect(sendMessage).toHaveBeenCalledWith('Keep pending input', undefined);
  await rerender(container, <View enabled={false} />);
  expect(result!.actions.sendMessage).toBeDefined();
  expect(result!.sendQueuedInput).toBeUndefined();
  expect(result!.status).toBe('connecting');
  expect(source.acquire).toHaveBeenCalledTimes(1);
  await unmount(container);
  expect(release).toHaveBeenCalledOnce();
  expect(unsubscribeStatus).toHaveBeenCalledOnce();
});

it('queues input during consumer access restoration and dispatches only after access returns', async () => {
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: {
    id: 'access-restoration', providerId: 'test', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z',
    status: 'idle', activeTurn: null, pendingInteractions: [],
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    runtimeInfo: { providerId: 'test', status: 'idle' },
  } });
  replica.applyHistory({ protocolVersion: '1.5.0', type: 'timeline_page', payload: {
    requestId: 'initial', agentId: 'access-restoration', direction: 'tail', epoch: 'access-restoration',
    reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [], error: null,
  } });
  const sendMessage = vi.fn(async (_text: string, _options?: unknown) => {});
  const client = { subscribeSessionState(listener: (state: RemoteSessionState) => void) { listener(remoteSessionState(replica.getState(), 'ready')); return () => {}; }, sendMessage } as unknown as RemoteSessionClient;
  const source: SessionConnectionSource = { acquire: () => ({ client, replica, release() {} }) };
  const transport = {} as RemoteAgentTransport;
  function View({ enabled }: { enabled: boolean }) {
    const view = useSessionView({ agentId: 'access-restoration', transport, source, cachedReplica: replica, enabled });
    return <AgentComposer state={view.state} disabled={view.status !== 'ready'} onSendMessage={view.actions.sendMessage} />;
  }
  const container = await render(<View enabled={false} />);
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this pending');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(sendMessage).not.toHaveBeenCalled();
  expect(input.value).toBe('');
  expect(container.textContent).toContain('Keep this pending');
  await rerender(container, <View enabled />);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  expect(sendMessage.mock.calls[0]?.[0]).toBe('Keep this pending');
  await unmount(container);
});


it('exposes the complete public session state and gates actions by its operation availability', async () => {
  const replica = new AgentReplica();
  let publish!: (state: RemoteSessionState) => void;
  const initial = remoteSessionState(replica.getState(), 'ready');
  const client = { subscribeSessionState(listener: typeof publish) { publish = listener; listener(initial); return () => {}; } } as unknown as RemoteSessionClient;
  const source: SessionConnectionSource = { acquire: () => ({ client, replica, release() {} }) };
  let view!: ReturnType<typeof useSessionView>;
  function View() { view = useSessionView({ agentId: 'session', transport: {} as RemoteAgentTransport, source }); return null; }
  const container = await render(<View />);
  expect(view.sessionState).toEqual(initial);
  expect(view.actions.cancel).toBeUndefined();
  const ready = { ...initial, synchronized: true, operations: { ...initial.operations, cancel: { allowed: true as const } } };
  await act(async () => publish(ready));
  expect(view.sessionState).toEqual(ready);
  expect(view.actions.cancel).toBeDefined();
  await unmount(container);
});
