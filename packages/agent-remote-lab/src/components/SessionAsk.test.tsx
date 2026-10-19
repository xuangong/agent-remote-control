import { act, createRef, useState, type ComponentProps } from 'react';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { applyWindowOperation, createWindowView } from '@orchardworks/agent-remote-protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { DraftStore } from '../draft-store.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import { WindowLayoutContext, type WindowLayoutAuthority } from '../window-workspace-context.js';
import { windowSessionBinding } from '../window-workspace.js';
import { askParticipantKey, type AskEntry } from '../hooks/useAskConversations.js';
import { SessionAsk } from './SessionAsk.js';
import { SessionDockProvider, SessionDockRail } from './SessionDock.js';
import { WorkspaceReady } from '../workspace-access.js';

type AskProps = ComponentProps<typeof SessionAsk>;
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const sibling = { ...source, nativeSessionId: 'side', agentId: 'side-agent', title: 'Side' };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function fixture(entries: AskEntry[]) {
  const values = new Map(entries.map(entry => [sessionKey(entry.source), entry]));
  const restore = vi.fn<AskProps['ask']['restore']>(() => undefined);
  const ask = {
    sharedView: () => undefined,
    entryFor: (session: typeof source) => values.get(sessionKey(session))!, isEnabled: () => true, isOpen: () => true,
    restore, drafts: new DraftStore('session-ask-focus'), store: new ForkStore('session-ask-focus', sessionStorage),
    associationOwner: (id: string) => ({ id, sourceSlot: id, geometryScope: id, text: { scope: 'session-ask-focus', key: id }, input: { scope: 'session-ask-focus', key: id }, open: true }),
    draftBinding: (id: string) => ({ store: ask.drafts, key: id }),
    close: vi.fn(), minimize: vi.fn(), toggle: vi.fn(), sendInput: vi.fn(), discardInput: vi.fn(),
  } as unknown as AskProps['ask'];
  const props: Omit<AskProps, 'source'> = {
    associationOwner: sessionKey(source), ask, visible: true, canRestore: false, storageScope: 'session-ask-focus',
    synchronize: async () => {}, onOpen: vi.fn(), replicaFor: () => { throw new Error('A draft Ask has no native replica.'); },
    transport: {} as AskProps['transport'], navigation: () => ({} as ReturnType<AskProps['navigation']>),
    triggerRef: createRef<HTMLButtonElement>(), onToggleEnabled: vi.fn(),
  };
  return { ask, restore, props };
}

function sharedFixture(ask: AskProps['ask'], pending = false) {
  const primary = createWindowView('source-view', windowSessionBinding(source), 'primary');
  const other = createWindowView('sibling-view', windowSessionBinding(sibling), 'primary');
  const view = { ...createWindowView('shared-ask', { ...windowSessionBinding(sibling), nativeSessionId: 'ask-target' }, 'float'), feature: { kind: 'ask', id: 'feature-ask' } };
  const child = { ...createWindowView('ask-child', windowSessionBinding(sibling), 'attached'), attachedTo: view.id };
  const layout: WindowLayoutAuthority = { window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: primary.id, selectedViewId: primary.id, views: pending ? [primary, other] : [primary, other, view, child] }, operate: vi.fn() };
  ask.sharedView = () => layout.window.views.find(value => value.id === view.id);
  return { layout, view, child };
}

it('keeps draft Ask placement and cleanup in one menu while minimize stays visible', async () => {
  const { props } = fixture([{ source }]);
  const container = await render(<SessionDockProvider enabled><SessionDockRail>Main session</SessionDockRail>
    <SessionAsk {...props} source={source} />
  </SessionDockProvider>);
  const menu = container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!;
  expect(container.querySelectorAll('[aria-label="More session actions"]')).toHaveLength(1);
  expect(menu.hidden).toBe(true);
  expect(menu.querySelector('[aria-label="Dock Ask"]')).not.toBeNull();
  expect(menu.querySelector('[aria-label="Clean Ask"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Minimize Ask"]')?.closest('.lab-session-heading-actions-panel')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!.click());
  expect(menu.hidden).toBe(false);
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-label="Dock Ask"]')!.click());
  expect(container.querySelector('[aria-label="Docked Ask"]')).not.toBeNull();
  expect(menu.querySelector('[aria-label="Float Ask"]')).not.toBeNull();
  expect(container.querySelector('.lab-ask-heading > strong[data-session-title-draggable]')).not.toBeNull();
});

it('includes attached session widths in a docked Ask as its family changes', async () => {
  const entry: AskEntry = { source, attached: true };
  const { ask, props } = fixture([entry]);
  const { layout, view, child } = sharedFixture(ask);
  view.placement = 'dock'; view.width = 420; child.width = 360;
  layout.resolveViewId = id => id === `ask:${sessionKey(source)}` ? view.id : id;
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, nativeSessionId: 'ask-target', title: 'Ask' });
  entry.record = ask.store.get(record.id); entry.attachedParticipant = askParticipantKey(entry.record);
  const replica = new AgentReplica();
  const transport = { ...props.transport, connect: () => ({ close() {}, send() {} }),
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  let edit!: (operation: Parameters<typeof applyWindowOperation>[1]) => void;
  function Harness() {
    const [, update] = useState(0);
    edit = operation => { layout.window = applyWindowOperation(layout.window, operation); update(value => value + 1); };
    return <WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ ...layout, operate: edit }}>
      <SessionDockProvider enabled><SessionDockRail>Main session</SessionDockRail>
        <SessionAsk {...props} source={source} replicaFor={() => replica} transport={transport} />
      </SessionDockProvider>
    </WindowLayoutContext.Provider></WorkspaceReady.Provider>;
  }
  const container = await render(<Harness />);
  const dock = () => container.querySelector<HTMLElement>('[aria-label="Docked Ask"]')!;
  expect(dock().style.width).toBe('780px');
  expect(dock().querySelectorAll('.lab-session-family-pane')).toHaveLength(2);
  const menu = dock().querySelector<HTMLDivElement>('.lab-session-family-pane .lab-session-heading-actions-panel')!;
  expect(menu.hidden).toBe(true);
  expect(menu.querySelector('[aria-label="Float Ask"]')).not.toBeNull();
  expect(menu.querySelector('[aria-label="Clean Ask"]')).not.toBeNull();
  expect(dock().querySelector('[aria-label="Minimize Ask"]')?.closest('.lab-session-heading-actions-panel')).toBeNull();
  await act(async () => edit({ type: 'view.resize', viewId: child.id, width: 500 }));
  expect(dock().style.width).toBe('920px');
  await act(async () => { entry.attached = false; edit({ type: 'view.select', viewId: view.id }); });
  expect(dock().style.width).toBe('420px');
  expect(dock().querySelectorAll('.lab-session-family-pane')).toHaveLength(0);
  await act(async () => { entry.attached = true; edit({ type: 'view.select', viewId: view.id }); });
  expect(dock().style.width).toBe('920px');
  await act(async () => edit({ type: 'view.close', viewId: child.id }));
  expect(dock().style.width).toBe('420px');
  expect(dock().querySelectorAll('.lab-session-family-pane')).toHaveLength(1);
});

it('does not render a per-owner launcher when Ask is closed', async () => {
  const { ask, props } = fixture([{ source }]);
  ask.isOpen = () => false;
  const container = await render(<SessionAsk {...props} source={source} />);
  expect(container.querySelector('[aria-label="Ask about this session"]')).toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it.each(['pointer', 'keyboard'])('selects an Ask child directly through %s interaction', async interaction => {
  const entry: AskEntry = { source, attached: true, restoreOnly: true };
  const { ask, props } = fixture([entry]);
  const { layout, view, child } = sharedFixture(ask);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, nativeSessionId: 'ask-target', title: 'Ask' });
  entry.record = ask.store.get(record.id); entry.attachedParticipant = askParticipantKey(entry.record);
  const operate = vi.fn((operation: Parameters<typeof applyWindowOperation>[1]) => { layout.window = applyWindowOperation(layout.window, operation); });
  const transport = { ...props.transport, connect: () => ({ close() {}, send() {} }), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  const container = await render(<WorkspaceReady.Provider value={false}><WindowLayoutContext.Provider value={{ ...layout, readWindow: () => layout.window, operate }}>
    <SessionAsk {...props} source={source} replicaFor={() => new AgentReplica()} transport={transport} />
  </WindowLayoutContext.Provider></WorkspaceReady.Provider>);
  const pane = container.querySelectorAll('.lab-session-family-pane')[1]!;
  await act(async () => {
    if (interaction === 'pointer') pane.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  expect(operate).toHaveBeenCalledExactlyOnceWith({ type: 'view.select', viewId: child.id });
  expect(layout.window.selectedViewId).toBe(child.id);
  expect(layout.window.selectedViewId).not.toBe(view.id);
});

it('keeps an expanded Ask available independently of its old source launcher preference', async () => {
  const { ask, props, restore } = fixture([{ source, restoring: true }]);
  ask.isEnabled = () => false;
  ask.drafts.set(sessionKey(source), 'Retained Ask question');
  const container = await render(<SessionAsk {...props} source={source} canRestore />);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Ask draft"]')?.value).toBe('Retained Ask question');
  expect(restore).toHaveBeenCalledExactlyOnceWith(source, props.synchronize, sessionKey(source));
});

it('preserves a desktop Ask and its draft when selection moves to another source view', async () => {
  const { ask, props } = fixture([{ source, restoring: true, restoreOnly: true }]);
  const { layout, view } = sharedFixture(ask);
  layout.window.selectedViewId = view.id;
  ask.drafts.set(sessionKey(source), 'Question about Main');
  let selectOther!: () => void;
  function Harness() {
    const [, update] = useState(0);
    selectOther = () => { layout.window = { ...layout.window, selectedViewId: 'sibling-view' }; update(value => value + 1); };
    return <WindowLayoutContext.Provider value={{ ...layout }}><SessionAsk {...props} source={source} /></WindowLayoutContext.Provider>;
  }
  const container = await render(<Harness />);
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute('aria-current')).toBe('true');
  expect(container.querySelector<HTMLElement>('.lab-session-ask-surface')?.style.zIndex).toBe('2');
  await act(async () => selectOther());
  expect(container.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog?.hasAttribute('aria-current')).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Ask draft"]')?.value).toBe('Question about Main');
  expect(container.querySelector<HTMLElement>('.lab-session-ask-surface')?.style.zIndex).toBe('1');
  await act(async () => {
    const minimize = container.querySelector<HTMLButtonElement>('[aria-label="Minimize Ask"]')!;
    minimize.focus(); minimize.click();
  });
  expect(ask.minimize).toHaveBeenCalledExactlyOnceWith(source, sessionKey(source));
  expect(layout.operate).toHaveBeenCalledWith({ type: 'view.select', viewId: 'shared-ask' });
});

it('shows a compact Ask while its shared view is pending, then follows its selected family', async () => {
  const { ask, props } = fixture([{ source, restoring: true, restoreOnly: true }]);
  const { layout, view, child } = sharedFixture(ask, true);
  let publish!: (selectedViewId: string) => void;
  function Harness() {
    const [, update] = useState(0);
    publish = selectedViewId => {
      layout.window = { ...layout.window, views: [...layout.window.views.filter(item => item.id !== view.id && item.id !== child.id), view, child], selectedViewId };
      update(value => value + 1);
    };
    return <WindowLayoutContext.Provider value={{ ...layout }}><SessionAsk {...props} source={source} compact /></WindowLayoutContext.Provider>;
  }
  const container = await render(<Harness />);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => publish('source-view'));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => publish('shared-ask'));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => publish('ask-child'));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});

it('restores multiple expanded Ask windows without moving focus or cancelling their source composition', async () => {
  const existing = await render(<input aria-label="Existing focus" />);
  const input = existing.querySelector('input')!;
  input.focus();
  const entries = [source, sibling].map(value => ({ source: value, restoring: true, restoreOnly: true }));
  const { props, restore } = fixture(entries);
  const parentFocus = vi.fn();
  let finish!: () => void;
  function Harness() {
    const [restored, setRestored] = useState(false);
    finish = () => { for (const entry of entries) { entry.restoring = false; entry.restoreOnly = false; } setRestored(true); };
    return <>{[source, sibling].map(value => <div key={sessionKey(value)} onFocusCapture={parentFocus}>
      <SessionAsk {...props} source={value} associationOwner={sessionKey(value)} canRestore={restored} />
    </div>)}</>;
  }
  const container = await render(<Harness />);
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(restore).not.toHaveBeenCalled();
  expect(parentFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  await act(async () => { finish(); });
  expect(restore).toHaveBeenCalledTimes(2);
  expect(parentFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
});

it('focuses an explicitly opened Ask and only minimizes the Ask containing the Escape event', async () => {
  const { ask, props } = fixture([{ source }, { source: sibling, restoring: true, restoreOnly: true }]);
  let open = false;
  ask.isOpen = session => sessionKey(session) === sessionKey(sibling) || open;
  function Harness() {
    const [, changed] = useState(0);
    return <><button ref={props.triggerRef} aria-label="Global Ask" onClick={() => { open = true; changed(value => value + 1); }}>Ask</button>
      <div data-source="main"><SessionAsk {...props} source={source} /></div>
      <div data-source="side"><SessionAsk {...props} source={sibling} associationOwner={sessionKey(sibling)} /></div></>;
  }
  const container = await render(<Harness />);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Global Ask"]')!.click(); });
  const opened = container.querySelector('[data-source="main"] [role="dialog"]')!;
  expect(document.activeElement).toBe(opened);
  await act(async () => { opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(ask.minimize).toHaveBeenCalledExactlyOnceWith(source, sessionKey(source));
});

it.each(['Escape', 'Minimize'])('returns focus to the launcher after %s removes the Ask portal', async action => {
  const { ask, props } = fixture([{ source }]);
  function Harness() {
    const [open, setOpen] = useState(false);
    ask.isOpen = () => open;
    ask.minimize = () => setOpen(false);
    return <><button ref={props.triggerRef} onClick={() => setOpen(true)}>Open Ask</button>
      <SessionAsk {...props} source={source} /></>;
  }
  const container = await render(<Harness />);
  const launcher = container.querySelector('button')!;
  await act(async () => { launcher.focus(); launcher.click(); });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  await act(async () => {
    if (action === 'Escape') dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    else {
      const minimize = dialog.querySelector<HTMLButtonElement>('[aria-label="Minimize Ask"]')!;
      minimize.focus(); minimize.click();
    }
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});

it('preserves focus moved outside Ask while its close operation settles', async () => {
  const { ask, props } = fixture([{ source }]);
  function Harness() {
    const [open, setOpen] = useState(false);
    ask.isOpen = () => open;
    ask.minimize = () => setOpen(false);
    return <><button ref={props.triggerRef} onClick={() => setOpen(true)}>Open Ask</button><input aria-label="Other conversation" />
      <SessionAsk {...props} source={source} /></>;
  }
  const container = await render(<Harness />);
  await act(async () => { const launcher = container.querySelector('button')!; launcher.focus(); launcher.click(); });
  const other = container.querySelector('input')!;
  await act(async () => {
    container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    other.focus();
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(other);
});

it('retires the previous restoration when the owning workspace or transport changes', async () => {
  const { props, restore } = fixture([{ source, restoring: true, restoreOnly: true }]);
  const stop = vi.fn();
  restore.mockImplementation(() => stop);
  let switchScope!: () => void, switchTransport!: () => void;
  function Harness() {
    const [scope, setScope] = useState('first');
    const [transport, setTransport] = useState(props.transport);
    switchScope = () => setScope('second');
    switchTransport = () => setTransport({} as AskProps['transport']);
    return <SessionAsk {...props} source={source} canRestore storageScope={scope} transport={transport} />;
  }
  await render(<Harness />);
  expect(restore).toHaveBeenCalledTimes(1);
  await act(async () => { switchScope(); });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(2);
  await act(async () => { switchTransport(); });
  expect(stop).toHaveBeenCalledTimes(2);
  expect(restore).toHaveBeenCalledTimes(3);
});

it.each(['restoring', 'failed'])('does not subscribe to a saved Ask while its attachment is %s and preserves the draft', async phase => {
  const entry: AskEntry = { source, attached: false, restoring: phase === 'restoring',
    error: phase === 'failed' ? 'The native runtime could not find this session.' : undefined };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Ask' });
  entry.record = ask.store.get(record.id);
  ask.drafts.set(sessionKey(source), 'Keep this unsent question');
  const replicaFor = vi.fn(props.replicaFor);
  const connect = vi.fn();
  const container = await render(<SessionAsk {...props} source={source} replicaFor={replicaFor} transport={{ ...props.transport, connect }} />);
  expect(replicaFor).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Ask draft"]')?.value).toBe('Keep this unsent question');
  expect(container.textContent).not.toContain('Timeline synchronization');
  expect(container.querySelector('[aria-label="Clean Ask"]')).not.toBeNull();
  if (phase === 'failed') {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The native runtime could not find this session.');
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith();
  }
});

it('mounts the ordinary Ask session only after attachment succeeds', async () => {
  const entry: AskEntry = { source, attached: false, restoring: true };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Ask' });
  entry.record = ask.store.get(record.id);
  ask.drafts.set(sessionKey(source), 'Continue this question');
  const replica = new AgentReplica();
  const replicaFor = vi.fn(() => replica);
  const connect = vi.fn(() => ({ close: vi.fn(), send: vi.fn() }));
  const transport = { ...props.transport, connect, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  let attach!: () => void;
  function Harness() {
    const [, changed] = useState(0);
    attach = () => { entry.attached = true; entry.attachedParticipant = askParticipantKey(entry.record!); entry.restoring = false; changed(value => value + 1); };
    return <SessionAsk {...props} source={source} replicaFor={replicaFor} transport={transport} />;
  }
  const container = await render(<Harness />);
  expect(connect).not.toHaveBeenCalled();
  await act(async () => { attach(); });
  expect(replicaFor).toHaveBeenCalledWith(sibling.agentId);
  expect(connect).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Ask draft"]')).toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')?.value).toBe('Continue this question');
});

it('keeps a different target behind the attachment gate even when its record id matches the confirmed participant', async () => {
  const entry: AskEntry = { source, attached: true, attachedParticipant: JSON.stringify(['same-record', JSON.stringify(['local', 'codex', 'side'])]),
    record: { mode: 'reference', source, id: 'same-record', capturedAt: '2026-10-10T00:00:00.000Z', delivery: 'pending', options: {}, settings: [],
      target: { ...sibling, providerId: 'claude' } } };
  const { ask, props } = fixture([entry]);
  ask.drafts.set(sessionKey(source), 'Keep the replacement draft');
  const replicaFor = vi.fn(props.replicaFor);
  const connect = vi.fn();
  const container = await render(<SessionAsk {...props} source={source} replicaFor={replicaFor} transport={{ ...props.transport, connect }} />);
  expect(replicaFor).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Ask draft"]')?.value).toBe('Keep the replacement draft');
});

it('mounts the confirmed concrete Ask record instead of a refreshed store target with the same relation id', async () => {
  const entry: AskEntry = { source, attached: true };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Confirmed Ask' });
  entry.record = ask.store.get(record.id);
  entry.attachedParticipant = askParticipantKey(entry.record);
  const replacement = { ...sibling, agentId: 'replacement-agent', providerId: 'claude', title: 'Replacement Ask' };
  ask.store.get = () => ({ ...entry.record!, target: replacement });
  const connected: string[] = [];
  const transport = { ...props.transport, connect: (agentId: string) => { connected.push(agentId); return { close: () => {}, send: () => {} }; },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  const replicaFor = vi.fn(() => new AgentReplica());
  await render(<SessionAsk {...props} source={source} replicaFor={replicaFor} transport={transport} />);
  expect(connected).toEqual(['side-agent']);
  expect(replicaFor).toHaveBeenCalledWith('side-agent');
});


it('shows each blocked saved question and routes explicit discard to that source and selected input', async () => {
  const entry: AskEntry = { source, error: 'The original Ask recipient is unavailable.', inputs: [
    { id: 'first-question', text: 'First retained question' }, { id: 'second-question', text: 'Second retained question' },
  ] };
  const { ask, props } = fixture([entry]);
  const container = await render(<SessionAsk {...props} source={source} />);
  expect(container.textContent).toContain('First retained question');
  expect(container.textContent).toContain('Second retained question');
  const discard = container.querySelectorAll<HTMLButtonElement>('[aria-label="Discard saved question"]');
  expect(discard).toHaveLength(2);
  await act(async () => { discard[1]!.click(); });
  expect(ask.discardInput).toHaveBeenCalledExactlyOnceWith(sessionKey(source), 'second-question');
  expect(ask.sendInput).not.toHaveBeenCalled();
});

it('follows a replacement Agent for the same concrete Ask session without keeping its old connection', async () => {
  const entry: AskEntry = { source, attached: true };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Ask' });
  entry.record = ask.store.get(record.id); entry.attachedParticipant = askParticipantKey(entry.record);
  const connected: string[] = [], closed: string[] = [];
  const transport = { ...props.transport, connect: (agentId: string) => {
    connected.push(agentId); return { close: () => { closed.push(agentId); }, send: () => {} };
  }, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  let reconnect!: () => void;
  function Harness() {
    const [, update] = useState(0);
    reconnect = () => { entry.executionTarget = { ...sibling, agentId: 'reconnected-agent' }; update(value => value + 1); };
    return <SessionAsk {...props} source={source} replicaFor={() => new AgentReplica()} transport={transport} />;
  }
  await render(<Harness />);
  expect(connected).toEqual(['side-agent']);
  await act(async () => reconnect());
  expect(connected).toEqual(['side-agent', 'reconnected-agent']);
  expect(closed).toContain('side-agent');
});

it('retries an expanded shared Ask when its first native binding arrives from another page', async () => {
  const entry: AskEntry = { source, restoring: true };
  const { ask, props, restore } = fixture([entry]);
  let sharedView = { id: 'shared-ask', feature: { kind: 'ask', id: 'feature-ask' }, placement: 'float' as const,
    width: 440, collapsed: false, display: { mode: 'content' as const, lettersVisible: true } } as ReturnType<typeof ask.sharedView>;
  ask.sharedView = () => sharedView;
  let publish!: () => void;
  function Harness() {
    const [, update] = useState(0);
    publish = () => { sharedView = { ...sharedView!, binding: { hostId: 'local', providerId: 'codex', nativeSessionId: 'ask-target', title: 'Ask' } }; update(value => value + 1); };
    return <SessionAsk {...props} source={source} canRestore />;
  }
  await render(<Harness />);
  expect(restore).toHaveBeenCalledTimes(1);
  await act(async () => publish());
  expect(restore).toHaveBeenCalledTimes(2);
});
