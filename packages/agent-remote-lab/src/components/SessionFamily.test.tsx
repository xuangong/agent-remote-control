import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { promptText, render, setPromptText } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import type { OpenedSession, SessionDirectoryClient as DirectoryClient } from '../directory-client.js';
import { DraftStore } from '../draft-store.js';
import { WorkspaceReady } from '../workspace-access.js';
import { SessionFamily, type FamilySessionPresentationContext } from './SessionFamily.js';
import { SessionDockProvider, SessionDockRail } from './SessionDock.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { WindowLayoutContext, WindowPresentationContext } from '../window-workspace-context.js';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

it('composes per-session presentation and footer from the native conversation and stable slot', async () => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Native title' };
  const presentation = vi.fn((context: FamilySessionPresentationContext) => ({
    conversationPath: <strong>Custom session heading</strong>, composerNotice: <p>Product notice</p>,
  }));
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><SessionFamily attachedSession={session} target={session}
    storageScope="family-presentation" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline
    viewId="composition-slot" transport={transport} draftStore={new DraftStore('family-presentation')} controls={<button>Native controls</button>}
    menuActions={<button>Placement action</button>}
    sessionPresentation={presentation} renderSessionFooter={context => <footer>{context.session.nativeSessionId} footer</footer>} />
  </WorkspaceReady.Provider>);
  expect(view.textContent).toContain('Custom session heading');
  expect(view.textContent).toContain('Product notice');
  expect(view.textContent).toContain('Native controls');
  expect(view.querySelector('footer')?.textContent).toBe('native footer');
  const context = presentation.mock.calls.at(-1)![0];
  expect(context.session).toEqual(session);
  expect(context.viewId).toBe('composition-slot');
  expect(context.offline).toBe(true);
  expect(context.pending).toBe(false);
  expect(context.actions).toBe(context.conversation.actions);
  expect(context.operationBinding.source).toEqual(session);
  expect(context.controls).toBeDefined();
  expect(context.menuActions).toBeDefined();
  expect(view.querySelector('.lab-session-heading-actions-panel')?.textContent).toContain('Placement action');
  expect([...view.querySelectorAll('button')].find(button => button.textContent === 'Native controls')?.closest('.lab-session-heading-actions-panel')).toBeNull();
});

it.each([false, true])('collapses the session actions into an edge toggle on a narrow screen, also without a presentation (compact: %s)', async compact => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Team leader' };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><SessionFamily attachedSession={session} target={session}
    storageScope={`family-toolbar-${compact}`} baseUrl="http://fixture" hostLabel="Local" compact={compact} active offline
    transport={transport} draftStore={new DraftStore(`family-toolbar-${compact}`)} controls={<button>Gather</button>} />
  </WorkspaceReady.Provider>);
  const gather = [...view.querySelectorAll('button')].find(button => button.textContent === 'Gather')!;
  const toggle = view.querySelector<HTMLButtonElement>('.lab-timeline-tools-toggle');
  if (!compact) {
    expect(toggle).toBeNull();
    expect(gather.closest('.lab-timeline-tools')).toBeNull();
    return;
  }
  expect(gather.closest('.lab-timeline-tools')?.hasAttribute('data-collapsed')).toBe(true);
  expect(toggle?.getAttribute('aria-label')).toBe('Expand session actions');
  await act(async () => toggle!.click());
  expect(gather.closest('.lab-timeline-tools')?.hasAttribute('data-collapsed')).toBe(false);
});

it.each(['primary', 'dock', 'float'] as const)('sizes a %s family within its placement alongside attached descendants', async placement => {
  const { WindowLayoutContext } = await import('../window-workspace-context.js');
  const { createWindowView } = await import('@orchardworks/agent-remote-protocol');
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Root' };
  const root = { ...createWindowView('primary', session, placement), width: 260 };
  const child = { ...createWindowView('child', { ...session, nativeSessionId: 'child', title: 'Child' }, 'attached'), attachedTo: root.id, width: 240 };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: root.id, selectedViewId: root.id, views: [root, child] }, operate() {} }}>
    <SessionTitleInteractionContext.Provider value={{ 'data-session-title-draggable': true }}>
      <SessionFamily attachedSession={session} target={session} viewId={root.id} storageScope="family-width" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline transport={transport} draftStore={new DraftStore('family-width')}
        menuActions={<button>Move root</button>} />
    </SessionTitleInteractionContext.Provider>
  </WindowLayoutContext.Provider></WorkspaceReady.Provider>);
  const panes = view.querySelectorAll<HTMLElement>('.lab-session-family-pane');
  expect(panes[0]?.style.width).toBe(placement === 'float' ? '100%' : '260px');
  expect(panes[1]?.style.width).toBe('240px');
  expect(panes[0]?.querySelector('[data-session-title-draggable]')).not.toBeNull();
  expect(panes[1]?.querySelector('[data-session-title-draggable]')).toBeNull();
  expect(panes[0]?.querySelector('.lab-session-heading-actions-panel')?.textContent).toContain('Move root');
  expect(panes[1]?.querySelector('.lab-session-heading-actions-panel')?.textContent).not.toContain('Move root');
});

it.each(['pointer', 'keyboard'])('selects a child directly within its primary group using %s without a redundant parent transition', async gesture => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Root' };
  const { agentId: _, ...binding } = session;
  const root = createWindowView('root', binding, 'primary');
  const child = { ...createWindowView('child', { ...binding, nativeSessionId: 'child', title: 'Child' }, 'attached'), attachedTo: root.id };
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'selection', title: 'Window', revision: 0, selectedPrimaryViewId: 'other', selectedViewId: 'other', views: [createWindowView('other', undefined, 'primary'), root, child] };
  const selections: Array<string | null> = [];
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const drafts = new DraftStore(`family-selection-${gesture}`);
  function Harness() {
    const [, renderAgain] = useState(0);
    const authority = { window, readWindow: () => window, operate(operation: Parameters<typeof applyWindowOperation>[1]) {
      window = applyWindowOperation(window, operation);
      selections.push(window.selectedViewId); renderAgain(value => value + 1);
    } };
    return <WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={authority}><SessionDockProvider enabled>
      <SessionDockRail onSelectPrimaryGroup={viewId => authority.operate({ type: 'view.select', viewId })} primaryGroups={[{
        id: root.id, title: 'Root', width: root.width, selected: window.selectedPrimaryViewId === root.id, collapsed: false,
        content: <SessionFamily attachedSession={session} target={session} viewId={root.id} storageScope="family-selection" baseUrl="http://fixture" hostLabel="Local"
          compact={false} active offline transport={transport} draftStore={drafts}
          renderSessionFooter={context => <><button data-session-action={context.session.nativeSessionId}>Session action</button>
            <button data-pane-selection-ignore data-global-action={context.session.nativeSessionId}>Global action</button></>} />,
      }]} />
    </SessionDockProvider></WindowLayoutContext.Provider></WorkspaceReady.Provider>;
  }
  const view = await render(<Harness />);
  expect(view.querySelectorAll('.lab-session-family-pane[aria-current="true"]')).toHaveLength(0);
  const action = view.querySelector<HTMLButtonElement>('[data-session-action="child"]')!;
  await act(async () => {
    if (gesture === 'pointer') action.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    action.focus();
  });
  expect(window.selectedViewId).toBe('child');
  expect(window.selectedPrimaryViewId).toBe('root');
  expect(selections).toEqual(['child']);
  expect(view.querySelectorAll('.lab-session-family-pane[data-selected]')).toHaveLength(1);
  expect(view.querySelector('.lab-session-family-pane[aria-current="true"]')?.getAttribute('aria-label')).toBe('Child');
  const global = view.querySelector<HTMLButtonElement>('[data-global-action="native"]')!;
  await act(async () => { global.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); global.focus(); });
  expect(window.selectedViewId).toBe('child');
  expect(selections).toEqual(['child']);
  expect(view.querySelector('.lab-session-family-pane[aria-current="true"]')?.getAttribute('aria-label')).toBe('Child');
  await act(async () => view.querySelector('.lab-primary-group-content')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(window.selectedViewId).toBe('root');
  expect(selections).toEqual(['child', 'root']);
  expect(view.querySelector('.lab-session-family-pane[aria-current="true"]')?.getAttribute('aria-label')).toBe('Root');
});

it('marks the presented compact pane without changing the shared selection', async () => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Root' };
  const root = createWindowView('root', session, 'primary');
  const child = { ...createWindowView('child', { ...session, nativeSessionId: 'child', title: 'Child' }, 'attached'), attachedTo: root.id };
  const operate = vi.fn();
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ window: {
    schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: root.id, selectedViewId: child.id, views: [root, child],
  }, operate }}><WindowPresentationContext.Provider value={root.id}>
    <SessionFamily attachedSession={session} target={session} viewId={root.id} storageScope="family-presented-selection" baseUrl="http://fixture"
      hostLabel="Local" compact active offline transport={transport} draftStore={new DraftStore('family-presented-selection')} />
  </WindowPresentationContext.Provider></WindowLayoutContext.Provider></WorkspaceReady.Provider>);
  const selected = view.querySelector<HTMLElement>('.lab-session-family-pane[aria-current="true"]');
  expect(selected?.getAttribute('aria-label')).toBe('Root');
  expect(selected?.hidden).toBe(false);
  expect(view.querySelectorAll('.lab-session-family-pane[data-selected]')).toHaveLength(1);
  expect(operate).not.toHaveBeenCalled();
});


it('shares the supplied replica and announces a binding once despite changing callbacks', async () => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Root' };
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'agent', runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'native' } } });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'history', agentId: 'agent', epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false, error: null, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
  const replicaFor = vi.fn(() => replica), bound = vi.fn(), presentation = vi.fn((_context: FamilySessionPresentationContext) => ({}));
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  let redraw!: () => void;
  const drafts = new DraftStore('family-binding');
  function Harness() {
    const [revision, setRevision] = useState(0); redraw = () => setRevision(value => value + 1);
    return <WorkspaceReady.Provider value={false}><div data-revision={revision}><SessionFamily attachedSession={session} target={session}
      viewId="slot" windowViewId="primary" storageScope="family-binding" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline
      transport={transport} draftStore={drafts} replicaFor={replicaFor} onSessionBound={(...args) => bound(...args)}
      sessionPresentation={presentation} /></div></WorkspaceReady.Provider>;
  }
  const view = await render(<Harness />);
  expect(replicaFor).toHaveBeenCalledWith('agent');
  expect(bound).toHaveBeenCalledExactlyOnceWith(session, 'slot', 'primary');
  expect(presentation.mock.calls.at(-1)?.[0].conversation.state?.agent?.id).toBe('agent');
  await act(async () => replica.reportDiagnostic('shared-replica', 'Shared replica update', true));
  expect(presentation.mock.calls.at(-1)?.[0].conversation.state).toBe(replica.getState());
  await act(async () => redraw());
  expect(bound).toHaveBeenCalledTimes(1);
  expect(view.querySelector('.lab-session-family-pane')?.classList.contains('lab-session-composition')).toBe(true);
});

it('keeps session sharing available before the native session attaches', async () => {
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'opening', title: 'Opening' };
  const view = await render(<WorkspaceReady.Provider value={false}><SessionFamily target={target}
    storageScope="family-opening" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline
    transport={{} as RemoteAgentTransport} draftStore={new DraftStore('family-opening')} /></WorkspaceReady.Provider>);
  expect(view.querySelector('[aria-label="Share session link"]')).not.toBeNull();
});

it('preserves attachment failures and retry alongside product notices without losing the draft', async () => {
  const { SessionDirectoryClient } = await import('../directory-client.js');
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach')
    .mockRejectedValueOnce(new Error('Host temporarily unavailable'))
    .mockResolvedValueOnce({ agentId: 'agent-1', nativeSessionId: 'recorded-session' });
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Retry session' };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  try {
    const view = await render(<WorkspaceReady.Provider value><SessionFamily target={target}
      storageScope="family-retry" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline={false}
      transport={transport} draftStore={new DraftStore('family-retry')}
      sessionPresentation={() => ({ composerNotice: <p>Product notice</p> })} /></WorkspaceReady.Provider>);
    await vi.waitFor(() => expect(view.querySelector('[role="alert"]')?.textContent).toContain('Host temporarily unavailable'));
    expect(view.textContent).toContain('Product notice');
    expect(view.querySelector('[aria-label="Share session link"]')).not.toBeNull();
    const input = view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    await act(async () => {
      setPromptText(input, 'Keep this draft while retrying');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const retry = [...view.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.textContent).toContain('Product notice');
    expect(promptText(view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!)).toBe('Keep this draft while retrying');
  } finally { attach.mockRestore(); }
});

it('keeps the latest observed messages ahead of the old disk preview while history resynchronizes', async () => {
  const { saveWorkspaceSnapshot } = await import('../workspace-cache.js');
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1', title: 'Working' };
  const entry = (text: string) => ({ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-17T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
    item: { type: 'assistant_message' as const, text } });
  saveWorkspaceSnapshot('http://fixture', session, { ...replicaState, timeline: { ...replicaState.timeline, entries: [entry('Previous turn on disk')] } });
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: replicaState.agent! });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'agent-1', epoch: 'epoch-1', direction: 'tail', reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false,
    entries: [entry('Latest visible working content')],
  } });
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><SessionFamily attachedSession={session} target={session}
    storageScope="family-display" baseUrl="http://fixture" hostLabel="Local" compact active offline replica={replica}
    transport={transport} draftStore={new DraftStore('family-display')} /></WorkspaceReady.Provider>);
  expect(view.textContent).toContain('Latest visible working content');
  await act(async () => replica.replaceTimeline('replacement-epoch'));
  expect(view.textContent).toContain('Latest visible working content');
  expect(view.textContent).not.toContain('Previous turn on disk');
});

it('addresses duplicate native sessions by their own composition slots when creating navigation', async () => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Duplicate' };
  const sources: Array<OpenedSession & { viewId?: string }> = [];
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const drafts = new DraftStore('family-navigation');
  await render(<WorkspaceReady.Provider value={false}>{['first-slot', 'second-slot'].map(viewId => <SessionFamily key={viewId} attachedSession={session} target={session}
    viewId={viewId} storageScope="family-navigation" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline
    transport={transport} draftStore={drafts} navigation={source => { sources.push(source); return { childrenFor: () => [], resolveSessionLink: () => undefined }; }} />)}</WorkspaceReady.Provider>);
  expect(new Set(sources.map(source => source.viewId))).toEqual(new Set(['first-slot', 'second-slot']));
  expect(sources.every(source => source.nativeSessionId === 'native')).toBe(true);
  expect('viewId' in session).toBe(false);
});

it.each([false, true])('offers native takeover while opening (preview %s) and restores after authorization', async preview => {
  const cache = await import('../workspace-cache.js');
  const cached = vi.spyOn(cache, 'readWorkspaceSnapshot').mockReturnValue(preview ? replicaState : undefined);
  const { SessionDirectoryClient, DirectoryError } = await import('../directory-client.js');
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach');
  const owner = { kind: 'native_cli' as const, generation: 'native-generation' };
  attach.mockRejectedValueOnce(new DirectoryError('Native CLI owns this session', 'native_owned', 409, undefined, owner));
  attach.mockResolvedValueOnce({ agentId: 'restored', nativeSessionId: 'native-takeover' });
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native-takeover', title: 'Native takeover' };
  try {
    const view = await render(<WorkspaceReady.Provider value><SessionFamily target={target} storageScope="native-takeover" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline={false} transport={transport} draftStore={new DraftStore('native-takeover')} /></WorkspaceReady.Provider>);
    await vi.waitFor(() => expect(view.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
    expect(view.querySelector('[aria-label="Share session link"]')).not.toBeNull();
    await act(async () => (view.querySelector('[aria-label="Interrupt and take control"]') as HTMLButtonElement).click());
    expect(attach.mock.calls[1]?.[3]).toBe(owner.generation);
    expect(view.querySelector('[aria-label="Interrupt and take control"]')).toBeNull();
  } finally { attach.mockRestore(); cached.mockRestore(); }
}, 10000);

it('retains uncertain native handoff across remount and checks without repeating interruption', async () => {
  const { SessionDirectoryClient, DirectoryError } = await import('../directory-client.js');
  const { unmount } = await import('../test/setup.js');
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach');
  const owner = { kind: 'native_cli' as const, generation: 'uncertain-generation' };
  const owned = () => new DirectoryError('Native CLI owns this session', 'native_owned', 409, undefined, owner);
  attach.mockRejectedValueOnce(owned()).mockRejectedValueOnce(new Error('Connection lost')).mockRejectedValueOnce(owned()).mockResolvedValueOnce({ agentId: 'restored', nativeSessionId: 'uncertain-native' });
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'uncertain-native', title: 'Uncertain' };
  const component = <WorkspaceReady.Provider value><SessionFamily target={target} storageScope="uncertain" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline={false} transport={transport} draftStore={new DraftStore('uncertain')} /></WorkspaceReady.Provider>;
  try {
    const first = await render(component);
    await vi.waitFor(() => expect(first.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
    await act(async () => (first.querySelector('[aria-label="Interrupt and take control"]') as HTMLButtonElement).click());
    expect(first.textContent).toContain('Handoff is not confirmed');
    await unmount(first);
    const next = await render(component);
    await vi.waitFor(() => expect(next.querySelector('[aria-label="Check session status"]')).not.toBeNull());
    await act(async () => (next.querySelector('[aria-label="Check session status"]') as HTMLButtonElement).click());
    expect(attach.mock.calls[1]?.[3]).toBe(owner.generation);
    expect(attach.mock.calls[3]?.[3]).toBeUndefined();
  } finally { attach.mockRestore(); }
}, 10000);

it('keeps native takeover available when a mounted slot changes to a pending native session', async () => {
  const { SessionDirectoryClient, DirectoryError } = await import('../directory-client.js');
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach');
  attach.mockRejectedValue(new DirectoryError('Native CLI owns replacement', 'native_owned', 409, undefined, { kind: 'native_cli', generation: 'replacement-owner' }));
  const initial = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'initial-native', agentId: 'initial-agent', title: 'Initial' };
  let replace!: () => void;
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  function Harness() {
    const [target, setTarget] = useState(initial);
    replace = () => setTarget({ ...initial, nativeSessionId: 'replacement-native', title: 'Replacement' });
    return <WorkspaceReady.Provider value><SessionFamily target={target} attachedSession={initial} storageScope="pending-takeover" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline={false} transport={transport} draftStore={new DraftStore('pending-takeover')} draftBinding={{ store: new DraftStore('pending-takeover'), key: 'pending-slot' }} /></WorkspaceReady.Provider>;
  }
  try {
    const view = await render(<Harness />);
    await act(async () => replace());
    await vi.waitFor(() => expect(view.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
    expect(view.querySelector('.lab-session-opening')).toBeNull();
    expect(view.textContent).not.toContain('Native CLI owns replacement');
    expect(view.textContent).toContain('Taking over interrupts its running work.');
  } finally { attach.mockRestore(); }
}, 10000);

it('reuses the supplied Host directory for native attachment and takeover without another attachment', async () => {
  const { SessionDirectoryClient, DirectoryError } = await import('../directory-client.js');
  const fallback = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockRejectedValue(new Error('Unexpected separate directory'));
  const owner = { kind: 'native_cli' as const, generation: 'injected-owner' };
  const attach = vi.fn().mockRejectedValueOnce(new DirectoryError('Native owns injected session', 'native_owned', 409, undefined, owner)).mockResolvedValueOnce({ agentId: 'injected-agent', nativeSessionId: 'injected-native' });
  const directory = { attach } as unknown as DirectoryClient;
  const directoryFor = vi.fn(() => directory);
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  try {
    const view = await render(<WorkspaceReady.Provider value><SessionFamily target={{ hostId: 'injected-host', providerId: 'recorded', nativeSessionId: 'injected-native', title: 'Injected' }} directoryFor={directoryFor}
      storageScope="injected" baseUrl="http://fixture" hostLabel="Injected" compact={false} active offline={false} transport={transport} draftStore={new DraftStore('injected')} /></WorkspaceReady.Provider>);
    await vi.waitFor(() => expect(view.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
    await act(async () => (view.querySelector('[aria-label="Interrupt and take control"]') as HTMLButtonElement).click());
    expect(directoryFor).toHaveBeenCalledWith('injected-host');
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[1]?.[3]).toBe(owner.generation);
    expect(fallback).not.toHaveBeenCalled();
  } finally { fallback.mockRestore(); }
}, 10000);

it('leaves managed native attachment to its coordinator and preserves an existing session when management changes', async () => {
  const { SessionDirectoryClient } = await import('../directory-client.js');
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockRejectedValue(new Error('Coordinator owns attachment'));
  const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'managed', agentId: 'managed-agent', title: 'Managed native' };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const drafts = new DraftStore('managed-family');
  let update!: (next: { managed: boolean; attached?: OpenedSession }) => void;
  function Harness() {
    const [value, setValue] = useState<{ managed: boolean; attached?: OpenedSession }>({ managed: true }); update = setValue;
    return <WorkspaceReady.Provider value><SessionFamily target={session} attachedSession={value.attached} attachmentManaged={value.managed} attachmentNotice={<p>Coordinator is restoring</p>}
      storageScope="managed-family" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false} transport={transport} draftStore={drafts} draftBinding={{ store: drafts, key: 'managed-slot' }} /></WorkspaceReady.Provider>;
  }
  try {
    const view = await render(<Harness />);
    expect(view.textContent).toContain('Coordinator is restoring');
    expect(attach).not.toHaveBeenCalled();
    const provisional = view.querySelector('[data-testid="prompt-input"]');
    await act(async () => update({ managed: true, attached: session }));
    const workbench = view.querySelector('[data-testid="prompt-input"]');
    expect(workbench).not.toBeNull();
    expect(workbench).toBe(provisional);
    await act(async () => update({ managed: false }));
    expect(view.querySelector('.lab-session-opening')).toBeNull();
    expect(view.querySelector('[data-testid="prompt-input"]')).toBe(workbench);
    expect(attach).not.toHaveBeenCalled();
  } finally { attach.mockRestore(); }
}, 10000);

it('does not announce or display a mismatched native replica as the requested session', async () => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'requested', agentId: 'identity-agent', title: 'Requested native' };
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: session.agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: 'wrong-native' } } });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'history', agentId: session.agentId, epoch: 'identity-epoch', direction: 'tail', reset: false, staleCursor: false, gap: false, error: null, window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false,
    entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [], timestamp: '2026-10-16T00:00:00Z', item: { type: 'assistant_message', text: 'Wrong native content' } }] } });
  const bound = vi.fn(), presentation = vi.fn((_context: FamilySessionPresentationContext) => ({}));
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><SessionFamily target={session} attachedSession={session} replica={replica} onSessionBound={bound} sessionPresentation={presentation}
    storageScope="identity-check" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline transport={transport} draftStore={new DraftStore('identity-check')} /></WorkspaceReady.Provider>);
  expect(view.textContent).not.toContain('Wrong native content');
  expect(bound).not.toHaveBeenCalled();
  expect(presentation.mock.calls.at(-1)?.[0].state).toBeUndefined();
  expect(presentation.mock.calls.at(-1)?.[0].actions.sendMessage).toBeUndefined();
}, 10000);

it('keeps the composer mounted while its managed target changes and fences the previous native session', async () => {
  const original = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'before', agentId: 'before-agent', title: 'Before' };
  const next = { ...original, nativeSessionId: 'after', agentId: 'after-agent', title: 'After' };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const drafts = new DraftStore('family-stable-carrier');
  const replica = new AgentReplica();
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: original.agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: original.nativeSessionId } } });
  const presentation = vi.fn((_context: FamilySessionPresentationContext) => ({}));
  let update!: (value: { target: typeof original; attached?: OpenedSession }) => void;
  function Harness() {
    const [value, setValue] = useState<{ target: typeof original; attached?: OpenedSession }>({ target: original, attached: original }); update = setValue;
    return <WorkspaceReady.Provider value><SessionFamily target={value.target} attachedSession={value.attached} attachmentManaged
      sessionIntent="history" sessionPresentation={presentation} storageScope="family-stable-carrier" baseUrl="http://fixture" hostLabel="Host" compact={false} active offline={false}
      transport={transport} replica={replica} draftStore={drafts} draftBinding={{ store: drafts, key: 'stable-slot' }} /></WorkspaceReady.Provider>;
  }
  const view = await render(<Harness />);
  const editor = view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
  editor.focus();
  expect(document.activeElement).toBe(editor);
  await act(async () => update({ target: next }));
  expect(view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(document.activeElement).toBe(editor);
  const context = presentation.mock.calls.at(-1)![0];
  expect(context.pending).toBe(true);
  expect(context.session.nativeSessionId).toBe('after');
  expect(context.state?.agent?.id).not.toBe('before-agent');
  expect(context.actions).toEqual({});
  expect(context.operationBinding.historical).toBe(true);
  await act(async () => update({ target: next, attached: next }));
  expect(view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(document.activeElement).toBe(editor);
});

it('keeps the selected child while primary heading navigation receives focus', async () => {
  const { WindowLayoutContext } = await import('../window-workspace-context.js');
  const { createWindowView } = await import('@orchardworks/agent-remote-protocol');
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'native', agentId: 'agent', title: 'Root' };
  const root = createWindowView('primary', session, 'primary');
  const child = { ...createWindowView('child', { ...session, nativeSessionId: 'child', title: 'Child' }, 'attached'), attachedTo: root.id };
  const operate = vi.fn();
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const view = await render(<WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: root.id, selectedViewId: child.id, views: [root, child] }, operate }}>
    <SessionFamily attachedSession={session} target={session} viewId={root.id} controls={<button className="lab-session-heading-actions-trigger">More session actions</button>}
      storageScope="family-heading-focus" baseUrl="http://fixture" hostLabel="Local" compact={false} active offline transport={transport} draftStore={new DraftStore('family-heading-focus')} />
  </WindowLayoutContext.Provider></WorkspaceReady.Provider>);
  const headingAction = view.querySelector<HTMLButtonElement>('.lab-session-heading-actions-trigger')!;
  await act(async () => { headingAction.focus(); headingAction.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(operate).not.toHaveBeenCalled();
  const editor = view.querySelector<HTMLElement>('.lab-primary-conversation [data-testid="prompt-input"]')!;
  await act(async () => editor.dispatchEvent(new Event('focusin', { bubbles: true })));
  expect(operate).toHaveBeenCalledExactlyOnceWith({ type: 'view.select', viewId: root.id });
});


it.each([false, true])('keeps the first draft editable between attachment and its native snapshot (rich: %s)', async rich => {
  const session = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'first-draft', agentId: 'first-draft-agent', title: 'New session' };
  const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
  const scope = `family-first-draft-${rich}`, key = 'first-draft-slot';
  const drafts = new DraftStore(scope), replica = new AgentReplica();
  let attach!: () => void;
  function Harness() {
    const [attached, setAttached] = useState(false); attach = () => setAttached(true);
    return <WorkspaceReady.Provider value><SessionFamily target={session} attachedSession={attached ? session : undefined} attachmentManaged
      storageScope={scope} baseUrl="http://fixture" hostLabel="Local" compact={false} active offline={false} transport={transport}
      replica={replica} draftStore={drafts} draftBinding={{ store: drafts, key }} imageDraftBinding={rich ? { scope, key } : undefined} /></WorkspaceReady.Provider>;
  }
  const view = await render(<Harness />);
  const editor = view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
  await act(async () => editor.focus());
  expect(editor.closest('[hidden]')).toBeNull();
  expect(document.activeElement).toBe(editor);
  await act(async () => attach());
  expect(view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(editor.closest('[hidden]')).toBeNull();
  if (editor instanceof HTMLTextAreaElement) expect(editor.disabled).toBe(false);
  else expect(editor.getAttribute('contenteditable')).toBe('true');
  expect(document.activeElement).toBe(editor);
  await act(async () => {
    setPromptText(editor, '/ask');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(drafts.get(key)).toBe('/ask');
  expect(view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await act(async () => {
    replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: session.agentId,
      runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: session.nativeSessionId } } });
    replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'history', agentId: session.agentId, epoch: 'first-draft', direction: 'tail', reset: false, staleCursor: false, gap: false, error: null,
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
  });
  expect(view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(editor.closest('[hidden]')).toBeNull();
  expect(promptText(editor)).toBe('/ask');
  expect(drafts.get(key)).toBe('/ask');
  expect(document.activeElement).toBe(editor);
});
