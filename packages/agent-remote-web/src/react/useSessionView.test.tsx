import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer.js';
import { AgentReplica } from '../replica/store.js';
import type { RemoteSessionClient, RemoteSessionStatus } from '../client/remote-session-client.js';
import type { RemoteAgentTransport } from '../client/transport.js';
import { render, rerender, unmount } from '../test/setup.js';
import { useSessionView, type SessionConnectionSource } from './useSessionView.js';
import type { SessionViewActions } from './session-view-actions.js';

it('retires exact draft recipients on reconnect, lease replacement, session switch and unmount', async () => {
  const replica = new AgentReplica();
  const observers: Array<(status: RemoteSessionStatus) => void> = [];
  function connection(): SessionConnectionSource {
    return { acquire() {
      const client = { subscribeSessionState(listener: (state: RemoteSessionState) => void) {
        observers.push(status => listener(remoteSessionState(replica.getState(), status)));
        observers.at(-1)!('ready');
        return () => {};
      } } as unknown as RemoteSessionClient;
      return { client, replica, release() {} };
    } };
  }
  const first = connection(), second = connection(), transport = {} as RemoteAgentTransport;
  let result!: ReturnType<typeof useSessionView>;
  function View({ agentId = 'a', source = first }: { agentId?: string; source?: SessionConnectionSource }) {
    result = useSessionView({ agentId, source, transport });
    return null;
  }
  const view = await render(<View />);
  const original = result.imageRecipient!;
  expect(original?.isCurrent()).toBe(true);
  await act(async () => { observers[0]!('disconnected'); observers[0]!('ready'); });
  const reconnected = result.imageRecipient!;
  expect(original.isCurrent()).toBe(false);
  expect(reconnected.isCurrent()).toBe(true);
  expect(reconnected.lifetime).not.toBe(original.lifetime);
  await rerender(view, <View source={second} />);
  const replaced = result.imageRecipient!;
  expect(reconnected.isCurrent()).toBe(false);
  expect(replaced.isCurrent()).toBe(true);
  await rerender(view, <View source={second} agentId="b" />);
  const switched = result.imageRecipient!;
  expect(replaced.isCurrent()).toBe(false);
  expect(switched.isCurrent()).toBe(true);
  await unmount(view);
  expect(switched.isCurrent()).toBe(false);
});

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
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
    id: 'access-restoration', providerId: 'test', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z',
    status: 'idle', activeTurn: null, pendingInteractions: [],
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    runtimeInfo: { providerId: 'test', status: 'idle' },
  } });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
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

it('binds view operations to its acquired client and retires captured authority before a replacement render', async () => {
  const replica = new AgentReplica();
  const client = { subscribeSessionState(listener: (state: RemoteSessionState) => void) {
    listener(remoteSessionState(replica.getState(), 'ready')); return () => {};
  } } as unknown as RemoteSessionClient;
  const source: SessionConnectionSource = { acquire: () => ({ client, replica, release() {} }) };
  let view!: ReturnType<typeof useSessionView>;
  function View({ enabled = true, agentId = 'supporting' }: { enabled?: boolean; agentId?: string }) {
    view = useSessionView({ agentId, transport: {} as RemoteAgentTransport, source, enabled }); return null;
  }
  const container = await render(<View />);
  const operation = view.operationScope!;
  expect(operation?.client).toBe(client);
  expect(operation?.replica).toBe(replica);
  expect(operation?.agentId).toBe('supporting');
  expect(operation?.isCurrent()).toBe(true);
  await rerender(container, <View enabled={false} />);
  expect(operation.isCurrent()).toBe(false);
  expect(view.operationScope).toBeUndefined();
  await rerender(container, <View />);
  expect(operation.isCurrent()).toBe(false);
  const restored = view.operationScope!;
  expect(restored.isCurrent()).toBe(true);
  await rerender(container, <View agentId="replacement" />);
  expect(restored.isCurrent()).toBe(false);
  await unmount(container);
});

it.each(['send', 'queue', 'content', 'queued input'].flatMap(delivery => ['pending', 'pending then current', 'lease replacement'].map(boundary => ({ delivery, boundary }))))(
  'rejects the captured $delivery callback after $boundary retires its view authority', async ({ delivery, boundary }) => {
    const acknowledgement = { type: 'command_acknowledged', payload: { agentId: 'A', requestId: 'current-request', command: 'send_message' } };
    const replica = new AgentReplica(), send = vi.fn(async () => acknowledgement), content = vi.fn(async () => {});
    const initial = remoteSessionState(replica.getState(), 'ready');
    const client = { sendMessage: send, sendMessageContent: content, subscribeSessionState(listener: (state: RemoteSessionState) => void) {
      listener({ ...initial, operations: { ...initial.operations, send_message: { allowed: true }, queue_message: { allowed: true } } }); return () => {};
    } } as unknown as RemoteSessionClient;
    const first: SessionConnectionSource = { acquire: () => ({ client, replica, release() {} }) };
    const second: SessionConnectionSource = { acquire: () => ({ client, replica, release() {} }) };
    const transport = {} as RemoteAgentTransport;
    let view!: ReturnType<typeof useSessionView>;
    function View({ pending = false, source = first }: { pending?: boolean; source?: SessionConnectionSource }) {
      view = useSessionView({ agentId: 'A', transport, source, pending }); return null;
    }
    const container = await render(<View />);
    const original = view.operationScope!;
    const message = view.actions.sendMessage!, rich = view.actions.sendMessageContent!, queued = view.sendQueuedInput!;
    const dispatch = () => delivery === 'content' ? rich([{ type: 'text', text: 'Held A input' }])
      : delivery === 'queued input' ? queued('Held A input', 'retained-operation')
      : message('Held A input', delivery === 'queue' ? { delivery: 'next_turn' } : undefined);
    if (boundary === 'lease replacement') await rerender(container, <View source={second} />);
    else await rerender(container, <View pending />);
    if (boundary === 'pending then current') await rerender(container, <View />);
    expect(original.isCurrent()).toBe(false);
    await expect(dispatch()).rejects.toThrow('The original session view is no longer current.');
    expect(send).not.toHaveBeenCalled(); expect(content).not.toHaveBeenCalled();
    await rerender(container, <View source={boundary === 'lease replacement' ? second : first} />);
    await view.actions.sendMessage!('Current A input');
    expect(send).toHaveBeenCalledExactlyOnceWith('Current A input', undefined);
    if (delivery === 'queued input') {
      expect(await view.sendQueuedInput!('Current queued input', 'current-operation')).toBe(acknowledgement);
      expect(send).toHaveBeenLastCalledWith('Current queued input', { operationId: 'current-operation' });
    }
  }, 10000,
);

it('waits for a native binding before acquiring and retires its lease and authority when binding disappears', async () => {
  const release = vi.fn(), sendMessage = vi.fn(async () => {});
  const replica = new AgentReplica();
  const client = { subscribeSessionState(listener: (state: RemoteSessionState) => void) { listener(remoteSessionState(replica.getState(), 'ready')); return () => {}; }, sendMessage } as unknown as RemoteSessionClient;
  const source = { acquire: vi.fn(() => ({ client, replica, release })) };
  let result!: ReturnType<typeof useSessionView>;
  function View({ connect }: { connect: boolean }) { result = useSessionView({ agentId: connect ? 'bound' : '', transport: {} as RemoteAgentTransport, source, connect }); return null; }
  const container = await render(<View connect={false} />);
  expect(source.acquire).not.toHaveBeenCalled();
  expect(result.operationScope).toBeUndefined();
  await rerender(container, <View connect />);
  expect(source.acquire).toHaveBeenCalledExactlyOnceWith('bound', expect.any(AgentReplica));
  const send = result.actions.sendMessage!;
  await send('bound input');
  expect(sendMessage).toHaveBeenCalledOnce();
  await rerender(container, <View connect={false} />);
  expect(release).toHaveBeenCalledOnce();
  expect(result.actions.sendMessage).toBeUndefined();
  expect(result.operationScope).toBeUndefined();
  await expect(send('retired input')).rejects.toThrow('no longer current');
  await unmount(container);
  expect(release).toHaveBeenCalledOnce();
});

it.each(['unmount', 'session switch', 'lease replacement', 'pending', 'pending then current', 'disabled', 'disabled then current', 'disconnected binding'] as const)(
  'rejects native mutations from a captured view after %s while its peer keeps the shared session usable', async boundary => {
    const mutations: Array<{ name: keyof SessionViewActions; invoke(actions: SessionViewActions): Promise<unknown> }> = [
      { name: 'takeControl', invoke: actions => actions.takeControl!() },
      { name: 'uploadResource', invoke: actions => actions.uploadResource!(new Blob(['resource']), 'resource.txt', 'resource-upload') },
      { name: 'uploadImage', invoke: actions => actions.uploadImage!(new Blob(['image']), 'image-upload') },
      { name: 'retryMessage', invoke: actions => actions.retryMessage!('saved-message') },
      { name: 'deleteMessage', invoke: async actions => { actions.deleteMessage!('saved-message'); } },
      { name: 'cancel', invoke: actions => actions.cancel!() },
      { name: 'setPlanning', invoke: actions => actions.setPlanning!(true) },
      { name: 'setSessionSetting', invoke: actions => actions.setSessionSetting!('model', 'model-b') },
      { name: 'executeCommand', invoke: actions => actions.executeCommand!('command', 'arguments') },
      { name: 'respondToInteraction', invoke: actions => actions.respondToInteraction!('question', { kind: 'question', answers: [] }) },
    ];
    function connection() {
      const replica = new AgentReplica();
      const initial = remoteSessionState(replica.getState(), 'ready');
      const calls = Object.fromEntries(mutations.map(({ name }) => [name, vi.fn(async (..._args: unknown[]) => {})]));
      const client = { ...calls, subscribeSessionState(listener: (state: RemoteSessionState) => void) {
        listener({ ...initial, operations: { ...initial.operations, send_message: { allowed: true }, cancel: { allowed: true },
          set_planning: { allowed: true }, set_session_setting: { allowed: true }, execute_command: { allowed: true },
          interaction_response: { allowed: true } } });
        return () => {};
      } } as unknown as RemoteSessionClient;
      return { client, replica, calls };
    }
    const retained = connection(), replacement = connection();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const acquire: SessionConnectionSource['acquire'] = agentId => {
      const release = vi.fn(); releases.push(release);
      return { ...(agentId === 'A' ? retained : replacement), release };
    };
    const first: SessionConnectionSource = { acquire }, second: SessionConnectionSource = { acquire };
    const transport = {} as RemoteAgentTransport;
    const views = new Map<string, ReturnType<typeof useSessionView>>();
    type ViewProps = { name: string; agentId?: string; source?: SessionConnectionSource; pending?: boolean; enabled?: boolean; connect?: boolean };
    function View({ name, agentId = 'A', source = first, ...options }: ViewProps) {
      views.set(name, useSessionView({ agentId, source, transport, ...options })); return null;
    }
    function Views({ visible = true, ...options }: Omit<ViewProps, 'name'> & { visible?: boolean }) {
      return <>{visible ? <View key="original" name="original" {...options} /> : null}<View key="peer" name="peer" /></>;
    }
    const container = await render(<Views />);
    const original = views.get('original')!, peer = views.get('peer')!;
    const authority = original.operationScope!;
    expect(authority.client).toBe(peer.operationScope!.client);
    if (boundary === 'unmount') await rerender(container, <Views visible={false} />);
    else if (boundary === 'session switch') await rerender(container, <Views agentId="B" />);
    else if (boundary === 'lease replacement') await rerender(container, <Views source={second} />);
    else if (boundary === 'disconnected binding') await rerender(container, <Views connect={false} />);
    else if (boundary.startsWith('pending')) await rerender(container, <Views pending />);
    else await rerender(container, <Views enabled={false} />);
    if (boundary.endsWith('then current')) await rerender(container, <Views />);
    expect(authority.isCurrent()).toBe(false);
    expect(peer.operationScope!.isCurrent()).toBe(true);
    for (const mutation of mutations) {
      await expect(mutation.invoke(original.actions), mutation.name).rejects.toThrow('The original session view is no longer current.');
      expect(retained.calls[mutation.name], mutation.name).not.toHaveBeenCalled();
      expect(replacement.calls[mutation.name], mutation.name).not.toHaveBeenCalled();
      await mutation.invoke(peer.actions);
      expect(retained.calls[mutation.name], mutation.name).toHaveBeenCalledOnce();
    }
    if (['unmount', 'session switch', 'lease replacement', 'disconnected binding'].includes(boundary)) expect(releases[0]).toHaveBeenCalledOnce();
    else expect(releases[0]).not.toHaveBeenCalled();
    expect(releases[1]).not.toHaveBeenCalled();
    await unmount(container);
  }, 10000,
);
