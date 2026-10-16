import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { SessionWindow } from './SessionWindow.js';
import { SessionAskHome, SessionAskSurface, SessionAskSurfaceProvider } from './SessionAskSurface.js';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { WindowSessionBridgeContext } from '../window-session-bridge-context.js';
import { createCompositionSlot } from '../session-composition.js';
import { DraftStore } from '../draft-store.js';
import { WorkspaceReady } from '../workspace-access.js';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import * as conversationHooks from '../hooks/useConversationSession.js';

const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([{ shared: true }, { shared: false }, { shared: true, intent: 'history' as const }])('keeps dock ownership and explicit history intent through the real family: %j', async ({ shared, intent }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Dock' };
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: session.agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: session.nativeSessionId } } });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'history', agentId: session.agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false, error: null, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
  const real = conversationHooks.useConversationSession;
  vi.spyOn(conversationHooks, 'useConversationSession').mockImplementation((source, transport, _cached, pending, following) => real(source, transport, replica, pending, following));
  vi.stubGlobal('fetch', async () => Response.json({ agentId: session.agentId, nativeSessionId: session.nativeSessionId }));
  const primary = createWindowView('primary', session, 'primary');
  const dock = createWindowView('ordinary-dock', { ...session, ...(intent ? { sessionIntent: intent } : {}) });
  const slot = createCompositionSlot('dock-slot', session, 'dock-test');
  const bound = vi.fn();
  const focus = vi.fn();
  const historical = vi.fn();
  const window = { schemaVersion: 2 as const, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: primary.id, selectedViewId: dock.id, views: [primary, dock] };
  const view = await render(<WorkspaceReady.Provider value={true}>
    <WindowLayoutContext.Provider value={shared ? { window, operate() {} } : undefined}>
      <WindowSessionBridgeContext.Provider value={{ slotForView: id => id === dock.id ? slot : undefined }}>
        <SessionAskSurfaceProvider>
          <SessionAskSurface id={slot.id}><aside>Dock Ask content</aside></SessionAskSurface>
          <SessionWindow entry={{ id: dock.id, slotId: slot.id, target: session, managed: false }} baseUrl="http://fixture" visible compact={false} hostLabel="Host" offline={false}
            transport={transport} draftStore={new DraftStore('dock-test')} navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })} onFocus={focus} onClose={() => {}}
            onSessionBound={bound} sessionPresentation={context => { historical(context.operationBinding.historical); return { composerNotice: <p>{context.viewId} presentation</p> }; }}
            renderSessionFooter={context => <SessionAskHome id={context.viewId!} />} />
        </SessionAskSurfaceProvider>
      </WindowSessionBridgeContext.Provider>
    </WindowLayoutContext.Provider>
  </WorkspaceReady.Provider>);
  await vi.waitFor(() => expect(bound).toHaveBeenCalledWith(expect.objectContaining(session), slot.id, shared ? dock.id : undefined));
  const pane = view.querySelector('.lab-session-family-pane')!;
  expect(pane.textContent).toContain(`${slot.id} presentation`);
  expect(pane.textContent).toContain('Dock Ask content');
  expect(bound.mock.calls.every(call => call[1] === slot.id)).toBe(true);
  expect(historical).toHaveBeenLastCalledWith(intent === 'history');
  focus.mockClear();
  await act(async () => {
    pane.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  expect(focus).toHaveBeenCalledTimes(shared ? 0 : 2);
});
