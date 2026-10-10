import { act, useRef, useState } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { AgentSnapshot, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';
import { DraftStore } from '../draft-store.js';
import type { TpmItem } from '../hooks/useTpmWork.js';
import { TpmWorkspace } from './TpmWorkspace.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
const item: TpmItem = { key: '["host","work"]', hostId: 'host', hostName: 'Host', online: true, unread: false,
  work: { id: 'work', revision: 1, title: 'Search', providerId: 'codex', mainNativeSessionId: 'main', phase: 'implementing', waiting: 'main_session', paused: false, summary: 'Awaiting changes', nextAction: 'Review result', document: '# Search specification\n\nFind matching items.', acceptance: '- [ ] Search works', evidence: ['Acceptance receipt'], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 100,
    outbox: [{ id: 'uncertain', target: 'main', status: 'unknown', purpose: 'implementation', text: 'Build search', createdAt: '2026-10-09T00:00:00Z' }] } };
it('preserves a draft when hidden, minimizes without pausing, and resolves uncertainty only through explicit controls', async () => {
  const drafts = new DraftStore('tpm-workspace');
  const actions: string[] = [], resolutions: unknown[] = [];
  let show!: (value: boolean) => void;
  let mainOpened = false;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [visible, setVisible] = useState(true); show = setVisible;
    return <><button ref={trigger}>TPM</button><TpmWorkspace item={item} visible={visible} storageScope="tpm-workspace" triggerRef={trigger}
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
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open main session"]')!.click());
  expect(mainOpened).toBe(true);
  expect(resolutions).toEqual([]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Mark uncertain as accepted"]')!.click());
  expect(resolutions).toEqual([{ id: 'uncertain', resolution: 'accepted' }]);
  expect(container.querySelector('[aria-label="More work actions"]')).toBeNull();
  expect(container.querySelector('[aria-label="Pause background follow-up"]')).toBeNull();
  expect(container.querySelector('[aria-label="Review progress now"]')).toBeNull();
  expect(container.querySelector('[aria-label="Resume background follow-up"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimize TPM"]')!.click());
  expect(actions).toEqual([]);
  expect(document.activeElement).toBe(container.querySelector('button'));
});
it('keeps the ordinary Session View connected and its full chatbox draft across hiding and minimizing', async () => {
  const closes: string[] = [];
  let connected = 0;
  const snapshot: AgentSnapshot = { protocolVersion: '1.7.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'tpm-agent' } };
  const page: HistoryPage = { protocolVersion: '1.7.0', type: 'timeline_page', payload: {
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
          listener.onMessage({ protocolVersion: '1.7.0', type: 'negotiated', sessionControl: true });
          listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        }
        if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.7.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
      } };
    },
  };
  const drafts = new DraftStore('tpm-session-retained');
  let show!: (value: boolean) => void;
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [visible, setVisible] = useState(true); show = setVisible;
    return <><button ref={trigger}>TPM</button><TpmWorkspace item={item} visible={visible} storageScope="tpm-session-retained" triggerRef={trigger}
      session={{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'tpm', agentId: 'tpm-agent', title: 'Search' }}
      transport={transport} draftBinding={{ store: drafts, key: item.key }} onClose={() => setVisible(false)} onShowList={() => setVisible(false)}
      onOpenMain={() => {}} onAction={async () => { throw new Error('Presentation must not mutate work.'); }} onResolve={async () => {}} onRetry={() => {}} /></>;
  }
  const container = await render(<Harness />);
  expect(container.textContent).toContain('Review the delivery evidence.');
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
  expect(labels.some(label => /pause|resume|check|review progress/i.test(label ?? ''))).toBe(false);
  expect(container.querySelector('[aria-label="Reopen work"]')).toBeNull();
});
it('offers an explicit reopen for completed work', async () => {
  const completed: TpmItem = { ...item, work: { ...item.work, phase: 'completed', outbox: [] } };
  const actions: string[] = [];
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    return <TpmWorkspace item={completed} visible storageScope="tpm-reopen" triggerRef={trigger}
      transport={{} as RemoteAgentTransport} draftBinding={{ store: new DraftStore('tpm-reopen'), key: item.key }} onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}}
      onAction={async action => { actions.push(action); }} onResolve={async () => {}} onRetry={() => {}} />;
  }
  const container = await render(<Harness />);
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
