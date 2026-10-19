import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { PrimarySessionFamily } from './PrimarySessionFamily.js';
import { DraftStore } from '../draft-store.js';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import * as workbenchComponents from './LabWorkbench.js';

const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
function result(nativeSessionId: string, state: string) {
  const target = { controllerId: 'controller', providerId: 'recorded', nativeSessionId };
  const source = { ...target, nativeSessionId: 'old' };
  return { record: { operationId: nativeSessionId, roleId: `role-${nativeSessionId}`, expectedRevision: 1, from: source, to: target, phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now' },
    role: { id: `role-${nativeSessionId}`, revision: 2, origin: source, current: target, workspace: { controllerId: 'controller', canonicalCwd: '/work' } },
    context: { operationId: nativeSessionId, target, state } };
}
it('keeps each group first-input context independent while preserving its presentation and footer', async () => {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const operation = JSON.parse(String(init.body)).operationId;
    return Response.json(result(operation, operation === 'A' ? 'pending' : 'materialized'));
  });
  const drafts = new DraftStore('primary-context');
  const ready = vi.fn();
  const view = await render(<>{['A', 'B'].map(id => {
    const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: id, agentId: id, title: id };
    return <PrimarySessionFamily key={id} attachedSession={session} target={session} viewId={`slot-${id}`} storageScope="primary-context" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false}
      transport={transport} draftStore={drafts} onSessionReady={ready}
      successionContext={{ operationId: id, target: { controllerId: 'controller', providerId: 'recorded', nativeSessionId: id } }}
      sessionPresentation={() => ({ composerNotice: <p>{id} product notice</p> })} renderSessionFooter={() => <footer>{id} footer</footer>} />;
  })}</>);
  const groups = view.querySelectorAll('.lab-session-family');
  expect(groups[0]?.textContent).toContain('History from the previous session will be included with your first message.');
  expect(groups[1]?.textContent).not.toContain('History from the previous session will be included with your first message.');
  expect(groups[0]?.textContent).toContain('A product notice');
  expect(groups[1]?.textContent).toContain('B footer');
  expect(ready.mock.calls.some(call => call[0]?.operationBinding.source.nativeSessionId === 'A')).toBe(true);
});

it('refreshes a group context after its own timeline advances without asking App to observe tokens', async () => {
  vi.useFakeTimers();
  let contextState = 'pending';
  vi.stubGlobal('fetch', async () => Response.json(result('A', contextState)));
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'A', runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'A' } } });
  const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', agentId: 'A', title: 'A' };
  const view = await render(<PrimarySessionFamily attachedSession={session} target={session} viewId="slot-A" storageScope="primary-refresh" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false}
    transport={transport} draftStore={new DraftStore('primary-refresh')} replica={replica}
    successionContext={{ operationId: 'A', target: { controllerId: 'controller', providerId: 'recorded', nativeSessionId: 'A' } }} />);
  expect(view.textContent).toContain('History from the previous session will be included with your first message.');
  contextState = 'materialized';
  await act(async () => replica.replaceTimeline('new-epoch'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(view.textContent).not.toContain('History from the previous session will be included with your first message.');
});

it('applies root handoff context without replacing a descendant own presentation', async () => {
  const { WindowLayoutContext } = await import('../window-workspace-context.js');
  const { createWindowView } = await import('@orchardworks/agent-remote-protocol');
  vi.stubGlobal('fetch', async (url: URL) => url.pathname.endsWith('/succession/status') ? Response.json(result('A', 'pending')) : Response.json({ agentId: 'child-agent', nativeSessionId: 'child' }));
  const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', agentId: 'A', title: 'Root' };
  const root = createWindowView('primary', session, 'primary');
  const child = { ...createWindowView('child', { ...session, nativeSessionId: 'child', title: 'Child' }, 'attached'), attachedTo: root.id };
  const view = await render(<WindowLayoutContext.Provider value={{ window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: root.id, selectedViewId: root.id, views: [root, child] }, operate() {} }}>
    <PrimarySessionFamily attachedSession={session} target={session} viewId={root.id} storageScope="primary-child-context" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false}
      transport={transport} draftStore={new DraftStore('primary-child-context')}
      successionContext={{ operationId: 'A', target: { controllerId: 'controller', providerId: 'recorded', nativeSessionId: 'A' } }}
      sessionPresentation={context => context.isRoot ? {} : { pendingFirstInputContext: { state: 'unavailable' } }} />
  </WindowLayoutContext.Provider>);
  const panes = view.querySelectorAll('.lab-session-family-pane');
  expect(panes[0]?.textContent).toContain('History from the previous session will be included with your first message.');
  expect(panes[1]?.textContent).toContain('History delivery could not be checked. Images remain paused until it is confirmed.');
  expect(panes[1]?.textContent).not.toContain('History from the previous session will be included with your first message.');
});


it('refreshes root first-input evidence after pending delivery settles without a timeline echo', async () => {
  vi.useFakeTimers();
  let contextState = 'pending';
  const fetcher = vi.fn(async () => Response.json(result('A', contextState)));
  vi.stubGlobal('fetch', fetcher);
  const realWorkbench = workbenchComponents.LabWorkbench;
  let pendingChanged: ((count: number) => void) | undefined;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { pendingChanged = props.onPendingInputChange; return realWorkbench(props); });
  const forwarded = vi.fn();
  const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', agentId: 'A', title: 'A' };
  const view = await render(<PrimarySessionFamily attachedSession={session} target={session} viewId="slot-A" storageScope="primary-delivery" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false}
    transport={transport} draftStore={new DraftStore('primary-delivery')}
    successionContext={{ operationId: 'A', target: { controllerId: 'controller', providerId: 'recorded', nativeSessionId: 'A' } }}
    sessionPresentation={() => ({ onPendingInputChange: forwarded })} />);
  expect(view.textContent).toContain('History from the previous session will be included with your first message.');
  const initialReads = fetcher.mock.calls.length;
  await act(async () => pendingChanged!(0));
  expect(fetcher).toHaveBeenCalledTimes(initialReads);
  await act(async () => pendingChanged!(1));
  contextState = 'materialized';
  await act(async () => pendingChanged!(0));
  expect(forwarded.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([1, 0]));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(fetcher.mock.calls.length).toBeGreaterThan(initialReads);
  expect(view.textContent).not.toContain('History from the previous session will be included with your first message.');
});
