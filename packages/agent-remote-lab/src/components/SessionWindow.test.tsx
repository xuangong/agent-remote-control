import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { SessionWindow } from './SessionWindow.js';
import { SessionDockProvider, SessionDockRail } from './SessionDock.js';
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

it.each([
  { placement: 'dock' as const, bound: true }, { placement: 'float' as const, bound: true },
  { placement: 'dock' as const, bound: false }, { placement: 'float' as const, bound: false },
])('keeps placement and binding actions in one menu while close stays visible: %j', async ({ placement, bound }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'native', title: 'Session' };
  const pane = createWindowView('pane', bound ? target : undefined, placement);
  const close = vi.fn(), change = vi.fn(), operate = vi.fn();
  const view = await render(<WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ window: {
    schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: null, selectedViewId: pane.id, views: [pane],
  }, operate }}><SessionDockProvider enabled><SessionDockRail primaryGroups={[]} />
    <SessionWindow entry={{ id: pane.id, slotId: 'slot', target: bound ? target : undefined, managed: false }} baseUrl="http://fixture" visible compact={false} hostLabel="Host" offline
      transport={transport} draftStore={new DraftStore('window-menu')} navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })}
      actions={<button type="button">Favorite</button>} onFocus={() => {}} onClose={close} onChangeSession={change} />
  </SessionDockProvider></WindowLayoutContext.Provider></WorkspaceReady.Provider>);
  const menu = view.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!;
  expect(view.querySelectorAll('[aria-label="More session actions"]')).toHaveLength(1);
  expect(menu.hidden).toBe(true);
  const placementAction = menu.querySelector<HTMLButtonElement>(`[aria-label="${placement === 'dock' ? 'Float' : 'Dock'} ${bound ? 'Session' : 'Select session'}"]`)!;
  expect(placementAction).not.toBeNull();
  const closeAction = view.querySelector<HTMLButtonElement>(`[aria-label="Close ${bound ? 'Session' : 'Select session'}"]`)!;
  expect(closeAction.closest('.lab-session-heading-actions-panel')).toBeNull();
  expect([...view.querySelectorAll('button')].find(button => button.textContent === 'Favorite')?.closest('.lab-session-heading-actions-panel')).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!.click());
  expect(menu.hidden).toBe(false);
  await act(async () => placementAction.click());
  expect(operate).toHaveBeenCalledWith({ type: 'view.place', viewId: pane.id, placement: placement === 'dock' ? 'float' : 'dock' });
  const changeAction = bound ? menu.querySelector<HTMLButtonElement>('[aria-label="Change session"]')
    : [...view.querySelectorAll('button')].find(button => button.textContent === 'Open sidebar');
  expect(changeAction).toBeDefined();
  await act(async () => changeAction!.click());
  expect(change).toHaveBeenCalledOnce();
  await act(async () => closeAction.click());
  expect(close).toHaveBeenCalledOnce();
});

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
  const window = { schemaVersion: 3 as const, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: primary.id, selectedViewId: dock.id, views: [primary, dock] };
  const view = await render(<WorkspaceReady.Provider value={true}>
    <WindowLayoutContext.Provider value={shared ? { window, operate() {} } : undefined}>
      <WindowSessionBridgeContext.Provider value={{ slotForView: id => id === dock.id ? slot : undefined }}>
          <SessionWindow entry={{ id: dock.id, slotId: slot.id, target: session, managed: false }} baseUrl="http://fixture" visible compact={false} hostLabel="Host" offline={false}
            transport={transport} draftStore={new DraftStore('dock-test')} navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })} onFocus={focus} onClose={() => {}}
            onSessionBound={bound} sessionPresentation={context => { historical(context.operationBinding.historical); return { composerNotice: <p>{context.viewId} presentation</p> }; }}
            renderSessionFooter={context => <aside>{context.viewId} footer</aside>} />
      </WindowSessionBridgeContext.Provider>
    </WindowLayoutContext.Provider>
  </WorkspaceReady.Provider>);
  await vi.waitFor(() => expect(bound).toHaveBeenCalledWith(expect.objectContaining(session), slot.id, shared ? dock.id : undefined));
  const pane = view.querySelector('.lab-session-family-pane')!;
  expect(pane.textContent).toContain(`${slot.id} presentation`);
  expect(pane.textContent).toContain(`${slot.id} footer`);
  expect(bound.mock.calls.every(call => call[1] === slot.id)).toBe(true);
  expect(historical).toHaveBeenLastCalledWith(intent === 'history');
  focus.mockClear();
  await act(async () => {
    pane.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  expect(focus).toHaveBeenCalledTimes(shared ? 0 : 2);
});
