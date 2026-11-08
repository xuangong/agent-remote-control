import { act, StrictMode, useMemo, useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { DraftStore } from '../draft-store.js';
import { render, unmount } from '../test/setup.js';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkspaceReady } from '../workspace-access.js';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { TrackViewScope } from '../hooks/useSessionAttention.js';
import { SessionConversationMount, SessionConversationSurfaces, type SessionSurfaceDescriptor } from './SessionConversationSurfaces.js';
import type { SessionConversationProps } from './SessionConversation.js';

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0, pending: undefined as ((count: number) => void) | undefined }));
vi.mock('./SessionConversation.js', async () => {
  const { useEffect, useContext } = await import('react');
  const { WindowLayoutContext } = await import('../window-workspace-context.js');
  const { TrackViewScope } = await import('../hooks/useSessionAttention.js');
  return { SessionConversation(props: SessionConversationProps) {
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++; }; }, []);
    lifecycle.pending = props.onPendingInputChange;
    const layout = useContext(WindowLayoutContext), track = useContext(TrackViewScope);
    return <><input aria-label="Owned draft" defaultValue="draft" /><output data-visible={props.visible} data-attach={props.attachmentEnabled}
      data-blocked={props.mutationBlocked} data-layout={layout?.window.id} data-track={!!track} data-managed={!!props.attachmentManaged}
      data-agent={props.attachedSession?.agentId} /></>;
  } };
});
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'one', title: 'One' };
function descriptor(transport: RemoteAgentTransport, mode: WorkbenchMode): SessionSurfaceDescriptor {
  return { slotId: 'slot-one', titleInteraction: undefined, props: {
    storageScope: 'scope', baseUrl: '/scope', target, hostLabel: 'Host', compact: false, active: true,
    offline: false, transport, draftStore: new DraftStore('scope'), viewId: 'slot-one', familyRoot: true,
    entries: [target], visible: true, onNavigate: async () => {},
    ...(mode === 'window' ? { attachmentManaged: true, attachedSession: { ...target, agentId: 'agent-one' } } : {}),
  } };
}
const firstTransport = {} as RemoteAgentTransport, secondTransport = {} as RemoteAgentTransport;
let update!: (next: Partial<{ mode: WorkbenchMode; window: boolean; bot: boolean; scope: string; transport: RemoteAgentTransport; ready: boolean; generation: number }>) => void;
function Harness() {
  const [state, set] = useState({ mode: 'window' as WorkbenchMode, window: true, bot: true, scope: 'scope', transport: firstTransport, ready: true, generation: 0 });
  update = next => set(current => ({ ...current, ...next }));
  const descriptors = useMemo(() => ({ window: descriptor(state.transport, 'window'), bot: descriptor(state.transport, 'bot') }), [state.transport]);
  return <WorkspaceReady.Provider value={state.ready}><SessionConversationSurfaces scope={state.scope} transport={state.transport} mode={state.mode}>
    {(['window', 'bot'] as const).map(mode => <section key={mode} data-destination={mode}>
      <button onClick={() => update({ mode })}>{mode === 'window' ? 'Window mode' : 'Bot mode'}</button>
      {state[mode] ? <SessionConversationMount key={`${mode}:${state.generation}`} mode={mode} descriptor={descriptors[mode]} active={state.mode === mode} /> : null}
    </section>)}
  </SessionConversationSurfaces></WorkspaceReady.Provider>;
}
beforeEach(() => { lifecycle.mounts = 0; lifecycle.unmounts = 0; lifecycle.pending = undefined; });
it('moves one leaf between mode destinations without losing its input node or focus', async () => {
  const container = await render(<Harness />);
  const input = container.querySelector<HTMLInputElement>('input')!;
  input.value = 'keep this exact editor'; input.focus();
  await act(async () => update({ mode: 'bot' }));
  expect(container.querySelector('[data-destination="bot"] input')).toBe(input);
  expect(input.value).toBe('keep this exact editor');
  expect(document.activeElement).toBe(input);
  expect(lifecycle.mounts).toBe(1); expect(lifecycle.unmounts).toBe(0);
  expect(container.querySelector('output')?.dataset).toMatchObject({ managed: 'true', agent: 'agent-one', visible: 'true' });
  await act(async () => update({ mode: 'window' }));
  expect(container.querySelector('[data-destination="window"] input')).toBe(input);
});
it('keeps the surviving registration and collects the last idle host', async () => {
  const container = await render(<Harness />), input = container.querySelector('input');
  await act(async () => update({ window: false, mode: 'bot' }));
  expect(container.querySelector('[data-destination="bot"] input')).toBe(input);
  expect(lifecycle.unmounts).toBe(0);
  await act(async () => update({ bot: false }));
  expect(container.querySelector('.lab-session-conversation-host')).toBeNull();
  expect(lifecycle.unmounts).toBe(1);
});
it('parks an unclaimed pending leaf without mutation or attachment until settlement', async () => {
  const container = await render(<Harness />), input = container.querySelector('input');
  await act(async () => lifecycle.pending!(1));
  const settled = lifecycle.pending!;
  await act(async () => update({ window: false, bot: false }));
  expect(container.querySelector('input')).toBe(input);
  expect(input?.closest('[hidden]')).not.toBeNull();
  expect(input?.closest('[inert]')).not.toBeNull();
  expect(container.querySelector('output')?.dataset).toMatchObject({ visible: 'false', blocked: 'true', attach: 'false' });
  expect(lifecycle.unmounts).toBe(0);
  await act(async () => settled(0));
  expect(container.querySelector('.lab-session-conversation-host')).toBeNull();
  expect(lifecycle.unmounts).toBe(1);
});
it('does not let stale unregister or pending callbacks collect a newer registration', async () => {
  const container = await render(<Harness />), input = container.querySelector('input');
  const oldPending = lifecycle.pending!;
  await act(async () => { oldPending(1); update({ generation: 1 }); });
  await act(async () => oldPending(0));
  expect(container.querySelector('input')).toBe(input);
  expect(lifecycle.unmounts).toBe(0);
});
it.each(['scope', 'transport', 'ready'] as const)('releases old hosts and ignores delayed callbacks on %s replacement', async field => {
  const container = await render(<Harness />), oldHost = container.querySelector('.lab-session-conversation-host');
  const oldPending = lifecycle.pending!;
  await act(async () => oldPending(1));
  await act(async () => update(field === 'scope' ? { scope: 'next' } : field === 'transport' ? { transport: secondTransport } : { ready: false }));
  expect(oldHost?.isConnected).toBe(false);
  const current = container.querySelector('input');
  await act(async () => oldPending(0));
  expect(container.querySelector('input')).toBe(current);
  if (field === 'ready') {
    expect(current).toBeNull();
    await act(async () => update({ ready: true }));
    expect(container.querySelector('input')).not.toBeNull();
  }
});
it('survives StrictMode replay and destination replacement after the initial baseline', async () => {
  const container = await render(<StrictMode><Harness /></StrictMode>);
  const input = container.querySelector('input'), baseline = { mounts: lifecycle.mounts, unmounts: lifecycle.unmounts };
  await act(async () => update({ mode: 'bot', generation: 1 }));
  expect(container.querySelector('[data-destination="bot"] input')).toBe(input);
  expect({ mounts: lifecycle.mounts, unmounts: lifecycle.unmounts }).toEqual(baseline);
  await unmount(container);
  expect(document.querySelector('.lab-session-conversation-host')).toBeNull();
});
it('captures Window contexts and removes them in Bot without remounting', async () => {
  const layout = { window: { schemaVersion: 3 as const, id: 'window', title: 'Window', revision: 0, views: [], selectedPrimaryViewId: null, selectedViewId: null }, operate() {} };
  const container = await render(<WindowLayoutContext.Provider value={layout}><TrackViewScope.Provider value={async () => ({})}><Harness /></TrackViewScope.Provider></WindowLayoutContext.Provider>);
  const input = container.querySelector('input');
  expect(container.querySelector('output')?.dataset).toMatchObject({ layout: 'window', track: 'true' });
  await act(async () => update({ mode: 'bot' }));
  expect(container.querySelector('output')?.dataset.layout).toBeUndefined();
  expect(container.querySelector('output')?.dataset.track).toBe('false');
  expect(container.querySelector('input')).toBe(input);
});

it('keeps distinct view slots separate even when they reference the same native session', async () => {
  const first = descriptor(firstTransport, 'window');
  const second = { ...first, slotId: 'second-slot', props: { ...first.props, viewId: 'second-slot' } };
  const container = await render(<SessionConversationSurfaces scope="scope" transport={firstTransport} mode="window">
    <SessionConversationMount mode="window" active descriptor={first} />
    <SessionConversationMount mode="window" active descriptor={second} />
  </SessionConversationSurfaces>);
  const inputs = container.querySelectorAll<HTMLInputElement>('input');
  expect(inputs).toHaveLength(2);
  inputs[0]!.value = 'First view only';
  expect(inputs[1]!.value).toBe('draft');
  expect(lifecycle.mounts).toBe(2);
});
