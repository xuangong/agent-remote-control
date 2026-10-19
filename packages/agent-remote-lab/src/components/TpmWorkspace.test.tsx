import { act, useRef, useState } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { createWindowView, type WorkspaceWindow, type AgentSnapshot, type HistoryPage } from '@orchardworks/agent-remote-protocol';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';
import { DraftStore } from '../draft-store.js';
import type { TpmItem } from '../hooks/useTpmWork.js';
import { SessionDescriptionsContext } from '../session-description-context.js';
import { describeSession } from '../session-description.js';
import { TpmWorkspace } from './TpmWorkspace.js';
import { SessionDockProvider, SessionDockRail } from './SessionDock.js';
import { WindowLayoutContext, WindowPresentationContext } from '../window-workspace-context.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
const item: TpmItem = { key: '["host","work"]', hostId: 'host', hostName: 'Host', online: true, unread: false,
  work: { id: 'work', revision: 1, title: 'Search', providerId: 'codex', mainNativeSessionId: 'main', phase: 'implementing', waiting: 'main_session', paused: false, summary: 'Awaiting changes', nextAction: 'Review result', document: '# Search specification\n\nFind matching items.', acceptance: '- [ ] Search works', evidence: ['Acceptance receipt'], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 100,
    outbox: [{ id: 'uncertain', target: 'main', status: 'unknown', purpose: 'implementation', text: 'Build search', createdAt: '2026-10-09T00:00:00Z' }] } };

it('keeps TPM placement in a collapsed menu without hiding its work and minimize actions', async () => {
  const drafts = new DraftStore('tpm-menu');
  const close = vi.fn(), showList = vi.fn(), focus = vi.fn(), openView = vi.fn();
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <SessionDockProvider enabled leadingControls={<button type="button" data-pane-selection-ignore aria-label="Global View options" onClick={openView}>View</button>}><SessionDockRail>Main session</SessionDockRail><button ref={trigger}>TPM</button>
      <TpmWorkspace item={item} visible storageScope="tpm-menu" triggerRef={trigger} transport={{} as RemoteAgentTransport}
        draftBinding={{ store: drafts, key: item.key }} onFocus={focus} onClose={close} onShowList={showList} onOpenMain={() => {}}
        onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />
    </SessionDockProvider>;
  }
  const container = await render(<Harness />);
  const menu = container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!;
  expect(container.querySelectorAll('[aria-label="More session actions"]')).toHaveLength(1);
  expect(menu.hidden).toBe(true);
  expect(menu.querySelector('[aria-label="Dock Search"]')).not.toBeNull();
  const minimize = container.querySelector<HTMLButtonElement>('[aria-label="Minimize TPM"]')!;
  const list = container.querySelector<HTMLButtonElement>('[aria-label="Back to TPM works"]')!;
  expect(minimize.closest('.lab-session-heading-actions-panel')).toBeNull();
  expect(list.closest('.lab-session-heading-actions-panel')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!.click());
  expect(menu.hidden).toBe(false);
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-label="Dock Search"]')!.click());
  expect(container.querySelector('[aria-label="Docked Search"]')).not.toBeNull();
  expect(container.querySelector('.lab-tpm-heading > [data-session-title-draggable]')).not.toBeNull();
  const globalView = container.querySelector<HTMLButtonElement>('.lab-tpm-heading > [aria-label="Global View options"]')!;
  expect(globalView).not.toBeNull();
  focus.mockClear();
  await act(async () => {
    globalView.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    globalView.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    globalView.click();
  });
  expect(openView).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
  await act(async () => list.click());
  expect(showList).toHaveBeenCalledOnce();
  await act(async () => minimize.click());
  expect(close).toHaveBeenCalledOnce();
});

it('marks only the presented TPM pane when different works display the same native session', async () => {
  const second = { ...item, key: '["host","second"]', work: { ...item.work, id: 'second', title: 'Review' } };
  const binding = { hostId: 'host', providerId: 'codex', nativeSessionId: 'same-session', title: 'Shared native session' };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'second-pane',
    views: [createWindowView('main', undefined, 'primary'), ...[item, second].map((work, index) => ({
      ...createWindowView(index ? 'second-pane' : 'first-pane', binding), feature: { kind: 'tpm', id: work.key, metadata: { hostId: work.hostId } },
    }))] };
  const drafts = new DraftStore('tpm-pane-selection');
  let present!: (id: string) => void;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [presented, setPresented] = useState('main'); present = setPresented;
    return <WindowLayoutContext.Provider value={{ window: document, operate() {} }}><WindowPresentationContext.Provider value={presented}>
      {[item, second].map(work => <TpmWorkspace key={work.key} item={work} visible storageScope="tpm-pane-selection" triggerRef={trigger}
        transport={{} as RemoteAgentTransport} draftBinding={{ store: drafts, key: work.key }}
        onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}} onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />)}
    </WindowPresentationContext.Provider></WindowLayoutContext.Provider>;
  }
  const container = await render(<Harness />);
  expect(container.querySelectorAll('.lab-tpm-window[aria-current="true"]')).toHaveLength(0);
  await act(async () => present('first-pane'));
  let selected = container.querySelector<HTMLElement>('.lab-tpm-window[aria-current="true"]');
  expect(selected?.getAttribute('aria-label')).toBe('TPM: Search');
  expect(selected?.getAttribute('data-view-id')).toBe('first-pane');
  expect(selected?.classList.contains('lab-session-pane-selection')).toBe(true);
  expect(container.querySelectorAll('.lab-tpm-window[data-selected]')).toHaveLength(1);
  await act(async () => present('second-pane'));
  selected = container.querySelector<HTMLElement>('.lab-tpm-window[aria-current="true"]');
  expect(selected?.getAttribute('aria-label')).toBe('TPM: Review');
  expect(container.querySelectorAll('.lab-tpm-window[data-selected]')).toHaveLength(1);
});

it('preserves a draft when hidden, minimizes without pausing, and resolves uncertainty only through explicit controls', async () => {
  const drafts = new DraftStore('tpm-workspace');
  const actions: string[] = [], resolutions: unknown[] = [];
  let show!: (value: boolean) => void;
  let mainOpened = false;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [visible, setVisible] = useState(true); show = setVisible;
    return <><button ref={trigger}>TPM</button><TpmWorkspace item={{ ...item, work: { ...item.work, tpmNativeSessionId: 'tpm' } }} visible={visible} storageScope="tpm-workspace" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: drafts, key: item.key }} onClose={() => setVisible(false)} onShowList={() => setVisible(false)}
      onOpenMain={() => { mainOpened = true; }} onAction={async action => { actions.push(action); }} onResolve={async (id, resolution) => { resolutions.push({ id, resolution }); }} onRetry={() => {}} /></>;
  }
  const container = await render(<Harness />);
  const draft = container.querySelector<HTMLTextAreaElement>('[aria-label="TPM draft"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'Keep my question'); draft.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => show(false));
  expect(drafts.get(item.key)).toBe('Keep my question');
  expect(actions).toEqual([]);
  await act(async () => show(true));
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="TPM draft"]')!.value).toBe('Keep my question');
  expect(container.querySelector<HTMLElement>('article')!.hidden).toBe(true);
  expect(container.querySelector('[aria-label="Pause background follow-up"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Plan & acceptance"]')!.click());
  expect(container.querySelector('article')?.textContent).toContain('Find matching items.');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('table[aria-label="Session attributions"] td button')!.click());
  expect(mainOpened).toBe(true);
  expect(resolutions).toEqual([]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Mark uncertain as accepted"]')!.click());
  expect(resolutions).toEqual([{ id: 'uncertain', resolution: 'accepted' }]);
  expect(container.querySelector('[aria-label="More work actions"]')).toBeNull();
  expect(container.querySelector('[aria-label="Pause background follow-up"]')).toBeNull();
  expect(container.querySelector('[aria-label="Review progress now"]')).toBeNull();
  expect(container.querySelector('[aria-label="Resume work"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimize TPM"]')!.click());
  expect(actions).toEqual([]);
  expect(document.activeElement).toBe(container.querySelector('button'));
});
it('keeps the ordinary Session View connected and its full chatbox draft across hiding and minimizing', async () => {
  const closes: string[] = [];
  let connected = 0;
  const snapshot: AgentSnapshot = { protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'tpm-agent' } };
  const page: HistoryPage = { protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    agentId: 'tpm-agent', requestId: 'history', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 1 },
    entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-09T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'assistant_message', text: 'Review the delivery evidence.' } }],
    hasOlder: false, hasNewer: false, error: null,
  } };
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => snapshot, fetchTimeline: async () => page, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (id, listener) => {
      connected++;
      queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot); });
      return { close: () => { closes.push(id); }, send: message => {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated', sessionControl: true });
          listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        }
        if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
      } };
    },
  };
  const drafts = new DraftStore('tpm-session-retained');
  const attachedItem: TpmItem = { ...item, work: { ...item.work, providerId: 'recorded', tpmNativeSessionId: 'tpm' } };
  let show!: (value: boolean) => void;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [visible, setVisible] = useState(true); show = setVisible;
    return <><button ref={trigger}>TPM</button><TpmWorkspace item={attachedItem} visible={visible} storageScope="tpm-session-retained" triggerRef={trigger}
      session={{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'tpm', agentId: 'tpm-agent', title: 'Search' }}
      transport={transport} draftBinding={{ store: drafts, key: item.key }} onClose={() => setVisible(false)} onShowList={() => setVisible(false)}
      onOpenMain={() => {}} onAction={async () => { throw new Error('Presentation must not mutate work.'); }} onResolve={async () => {}} onRetry={() => {}} /></>;
  }
  const container = await render(<SessionDescriptionsContext.Provider value={{ describe: session => describeSession({ session, tpmWorks: [attachedItem] }), navigate: async () => {} }}><Harness /></SessionDescriptionsContext.Provider>);
  expect(container.textContent).toContain('Review the delivery evidence.');
  const timeline = container.querySelector('[data-testid="timeline"]');
  const attributionToggle = container.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!;
  expect(container.querySelectorAll('[aria-label="Show session attributions"]')).toHaveLength(1);
  await act(async () => attributionToggle.click());
  expect(container.querySelector('table[aria-label="Session attributions"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="timeline"]')).toBe(timeline);
  expect(connected).toBe(1);
  expect(closes).toEqual([]);
  await act(async () => attributionToggle.click());
  expect(container.querySelector<HTMLElement>('.lab-session-heading')!.hidden).toBe(true);
  expect(container.querySelector('[aria-label="Session view options"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"][value="preview"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[type="radio"][value="preview"]')!.checked).toBe(true);
  expect(container.querySelector('[aria-label="Show letters"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Verify this result'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => show(false));
  await act(async () => show(true));
  expect(connected).toBe(1);
  expect(closes).toEqual([]);
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Verify this result');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimize TPM"]')!.click());
  expect(closes).toEqual([]);
});
it('requires a verified native identity to resolve uncertain creation and provides explicit abandonment', async () => {
  const resolves: unknown[] = [];
  const uncertain: TpmItem = { ...item, work: { ...item.work, outbox: [], creationStatus: 'unknown', health: 'Creation receipt was lost.' } };
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <><button ref={trigger}>TPM</button><TpmWorkspace item={uncertain} visible storageScope="tpm-creation" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-creation'), key: item.key }} onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}}
      onAction={async () => {}} onResolve={async (id, resolution, nativeSessionId) => { resolves.push({ id, resolution, nativeSessionId }); }} onRetry={() => {}} /></>;
  }
  const container = await render(<Harness />);
  expect(container.textContent).toContain('Uncertain TPM creation');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Confirm TPM creation"]')!.disabled).toBe(true);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Verified TPM session ID"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'native-confirmed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Confirm TPM creation"]')!.click());
  expect(resolves).toEqual([{ id: 'creation', resolution: 'accepted', nativeSessionId: 'native-confirmed' }]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Abandon uncertain TPM creation"]')!.click());
  expect(resolves[1]).toEqual({ id: 'creation', resolution: 'rejected', nativeSessionId: undefined });
});
it('presents an unwritten plan honestly and leaves follow-up scheduling to the TPM', async () => {
  const empty: TpmItem = { ...item, work: { ...item.work, document: '', acceptance: '', evidence: [], outbox: [], paused: true } };
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <TpmWorkspace item={empty} visible storageScope="tpm-plan-empty" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-plan-empty'), key: item.key }} onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}}
      onAction={async () => { throw new Error('Scheduling is autonomous.'); }} onResolve={async () => {}} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Plan & acceptance"]')!.click());
  expect(container.querySelector('article')!.textContent).toContain('has not written a plan yet');
  const labels = [...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? button.textContent);
  expect(labels.some(label => /^pause|check|review progress/i.test(label ?? ''))).toBe(false);
  expect(container.querySelector('[aria-label="Resume work"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Reopen work"]')).toBeNull();
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).not.toContain('Waiting for main-session progress');
});
it('offers an explicit reopen for completed work', async () => {
  const completed: TpmItem = { ...item, work: { ...item.work, phase: 'completed', paused: true, outbox: [] } };
  const actions: string[] = [];
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <TpmWorkspace item={completed} visible storageScope="tpm-reopen" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-reopen'), key: item.key }} onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}}
      onAction={async action => { actions.push(action); }} onResolve={async () => {}} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).not.toContain('paused');
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).not.toContain('Waiting');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reopen work"]')!.click());
  expect(actions).toEqual(['reopen']);
});
it('renames inline, keeps failed edits and cancels without closing the conversation', async () => {
  const rename = vi.fn().mockRejectedValueOnce(new Error('Host disconnected')).mockResolvedValue(undefined);
  const close = vi.fn();
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <TpmWorkspace item={item} visible storageScope="tpm-rename" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-rename'), key: item.key }}
      onClose={close} onShowList={() => {}} onOpenMain={() => {}} onRename={rename} onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Rename TPM session"]')!.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="TPM session name"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  Mobile search  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const form = container.querySelector<HTMLFormElement>('.lab-tpm-name-editor')!;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(rename).toHaveBeenCalledWith('Mobile search');
  expect(form.textContent).toContain('Host disconnected');
  expect(input.value).toBe('  Mobile search  ');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(container.querySelector('.lab-tpm-name-editor')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Rename TPM session"]')!.click());
  await act(async () => container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('.lab-tpm-name-editor')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});
it.each([false, true])('archives or restores completed work without changing the native session (archived=%s)', async archived => {
  const actions: string[] = []; const showList = vi.fn();
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <TpmWorkspace item={{ ...item, work: { ...item.work, phase: 'completed', archived, outbox: [] } }} visible storageScope="tpm-archive" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-archive'), key: item.key }}
      onClose={() => {}} onShowList={showList} onOpenMain={() => {}} onAction={async action => { actions.push(action); }} onResolve={async () => {}} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${archived ? 'Restore' : 'Archive'} TPM session"]`)!.click());
  expect(actions).toEqual([archived ? 'unarchive' : 'archive']);
  expect(showList).toHaveBeenCalledTimes(archived ? 0 : 1);
});

it('lets the user stop unfinished work with unknown delivery and explicitly resume after restoring it', async () => {
  const actions: string[] = [];
  let shownList = 0;
  let fail = true;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [work, setWork] = useState(item.work);
    return <TpmWorkspace item={{ ...item, work }} visible storageScope="tpm-stop" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-stop'), key: item.key }}
      onClose={() => {}} onShowList={() => { shownList++; }} onOpenMain={() => {}} onAction={async action => {
        actions.push(action);
        if (fail) throw new Error('Host disconnected');
        setWork(current => ({ ...current, archived: action === 'archive', paused: action !== 'resume' }));
      }} onResolve={async () => { throw new Error('Stopping must not resolve unknown delivery.'); }} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop and archive TPM session"]');
  expect(stop).not.toBeNull();
  await act(async () => stop!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host disconnected');
  expect(shownList).toBe(0);
  fail = false;
  await act(async () => stop!.click());
  expect(shownList).toBe(1);
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).toContain('Stopped');
  expect(container.querySelector('.lab-tpm-work-status')?.textContent).not.toContain('Waiting for main');
  expect(container.querySelector('[aria-label="Mark uncertain as accepted"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Restore TPM session"]')!.click());
  expect(actions).toEqual(['archive', 'archive', 'unarchive']);
  const resume = container.querySelector<HTMLButtonElement>('[aria-label="Resume work"]');
  expect(resume).not.toBeNull();
  await act(async () => resume!.click());
  expect(actions.at(-1)).toBe('resume');
  expect(container.querySelector('[aria-label="Resume work"]')).toBeNull();
});
