import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionWorkbench } from './SessionWorkbench.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionControlNotice } from './SessionControlNotice.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';

it('uses only the containing toolbar disclosure when heading actions move into the timeline', async () => {
  const change = vi.fn();
  let switchHeading!: (value: 'inline' | 'toolbar') => void;
  function Harness() {
    const [headingMode, setHeadingMode] = useState<'inline' | 'toolbar'>('inline'); switchHeading = setHeadingMode;
    return <SessionWorkbench state={replicaState} sessionStatus="ready" actions={{}} headingMode={headingMode}
      sessionManager={<SessionHeadingActions alwaysCollapsed><button type="button" onClick={change}>Change session</button></SessionHeadingActions>} />;
  }
  const container = await render(<Harness />);
  const inlineMenu = container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!;
  expect(inlineMenu.hidden).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!.click());
  expect(inlineMenu.hidden).toBe(false);
  await act(async () => switchHeading('toolbar'));
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Session actions"]')!;
  expect(toolbar.querySelector('[aria-label="More session actions"]')).toBeNull();
  expect(toolbar.querySelector('.lab-session-heading-actions-panel')).toBeNull();
  const action = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Change session')!;
  expect(action.closest('[inert]')).not.toBeNull();
  await act(async () => toolbar.querySelector<HTMLButtonElement>('[aria-label="Expand session actions"]')!.click());
  expect(action.closest('[inert], [hidden]')).toBeNull();
  await act(async () => action.click());
  expect(change).toHaveBeenCalledOnce();
  await act(async () => toolbar.querySelector<HTMLButtonElement>('[aria-label="Collapse session actions"]')!.click());
  expect(action.closest('[inert]')).not.toBeNull();
  await act(async () => switchHeading('inline'));
  expect(container.querySelectorAll('[aria-label="More session actions"]')).toHaveLength(1);
  expect(container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!.hidden).toBe(true);
});

it('keeps the original composer dock editable without native state in draft-only mode', async () => {
  const send = vi.fn();
  const container = await render(<LabWorkbench draftOnly sessionStatus="disconnected" messageDraft="Local owner" actions={{ sendMessage: send }} />);
  expect(container.querySelector<HTMLElement>('.lab-composer-dock')!.hidden).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({ value: 'Local owner', disabled: false });
  const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  expect(submit.disabled).toBe(true); await act(async () => submit.click()); expect(send).not.toHaveBeenCalled();
});

it('shows native ownership before the first snapshot while keeping the draft and mutations blocked', async () => {
  const send = vi.fn(), takeControl = vi.fn(async () => {});
  const container = await render(<LabWorkbench draftOnly sessionStatus="disconnected" messageDraft="Local owner" actions={{ sendMessage: send }}
    nativeTakeover={<SessionControlNotice connected control={{ access: 'read_only', available: false,
      nativeOwner: { kind: 'native_cli', generation: 'owner-1' } }} onTakeControl={takeControl} />} />);
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Interrupt and take control"]');
  expect(button).not.toBeNull();
  expect(button!.closest('[hidden]')).toBeNull();
  expect(button!.disabled).toBe(false);
  expect(container.textContent).toContain('Taking over interrupts its running work.');
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({ value: 'Local owner', readOnly: true });
  expect(container.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  expect(takeControl).not.toHaveBeenCalled();
  await act(async () => button!.click());
  expect(takeControl).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

it('does not infer native takeover from a disconnected draft without an owner', async () => {
  const takeControl = vi.fn(async () => {});
  const container = await render(<LabWorkbench draftOnly sessionStatus="disconnected" actions={{ takeControl }} />);
  expect(container.querySelector('.lab-session-control')).toBeNull();
  expect(takeControl).not.toHaveBeenCalled();
});

it('renders the same conversation and composer through product and standalone composition', async () => {
  const props = { state: replicaState, sessionStatus: 'ready' as const, actions: {}, messageDraft: 'Keep my draft' };
  const standalone = await render(<SessionWorkbench {...props} />);
  const product = await render(<LabWorkbench {...props} />);
  expect(standalone.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
  expect(standalone.querySelector('[aria-label="Agent timeline"]')!.textContent).toBe(product.querySelector('[aria-label="Agent timeline"]')!.textContent);
  expect(standalone.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Keep my draft');
  expect(product.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Keep my draft');
  expect(standalone.querySelector('a[href*="auth"]')).toBeNull();
});

it('keeps recordings read-only even when mutation and takeover actions are supplied', async () => {
  const sendMessage = vi.fn(), takeControl = vi.fn();
  const container = await render(<SessionWorkbench state={replicaState} sessionStatus="ready" readOnly actions={{ sendMessage, takeControl }} messageDraft="Recorded text" />);
  const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]');
  if (submit) { expect(submit.disabled).toBe(true); await act(async () => submit.click()); }
  expect(container.querySelector('[aria-label="Take control"]')).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(takeControl).not.toHaveBeenCalled();
});


it('renders authoritative idle activity even when retained turn metadata is present', async () => {
  const state = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle' as const,
    activeTurn: { turnId: 'retained', startedAt: '2026-09-26T00:00:00Z' } } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{}} />);
  expect(container.querySelector('.lab-conversation-status')!.textContent).toBe('Ready');
  expect(container.querySelector('[data-testid="agent-activity-label"]')!.textContent).toBe('Ready');
  expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
});

it('keeps session search in a visible heading instead of over the Timeline', async () => {
  let switchHeading!: (value: 'inline' | 'toolbar') => void;
  function Harness() {
    const [headingMode, setHeadingMode] = useState<'inline' | 'toolbar'>('inline'); switchHeading = setHeadingMode;
    return <SessionWorkbench state={replicaState} sessionStatus="ready" actions={{}} headingMode={headingMode} />;
  }
  const container = await render(<Harness />);
  const triggers = () => container.querySelectorAll<HTMLButtonElement>('[aria-label="Search this session"]');
  expect(triggers()).toHaveLength(1);
  expect(triggers()[0]!.closest('.lab-session-heading')).not.toBeNull();
  expect(container.querySelector('[role="toolbar"][aria-label="Session actions"]')).toBeNull();
  await act(async () => triggers()[0]!.click());
  expect(container.querySelector('[aria-label="Search session history"]')).not.toBeNull();
  expect(triggers()[0]!.hidden).toBe(false);
  expect(triggers()[0]!.getAttribute('aria-expanded')).toBe('true');
  await act(async () => triggers()[0]!.click());
  expect(container.querySelector('[aria-label="Search session history"]')).toBeNull();

  await act(async () => switchHeading('toolbar'));
  expect(triggers()).toHaveLength(1);
  expect(triggers()[0]!.closest('[role="toolbar"][aria-label="Session actions"]')).not.toBeNull();
});

it('does not open session search from an image portal but keeps the timeline shortcut', async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  const binding = { resourceId: 'image', locator: './image.png', status: 'available' as const };
  const image = { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'image', contentBase64: 'AA==' };
  const state: AgentReplicaState = { ...replicaState, resources: { image },
    timeline: { ...replicaState.timeline, entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-30T00:00:00Z',
    sourceSeqRanges: [], collapsed: [], resources: [binding], item: { type: 'assistant_message', text: '![Screenshot](./image.png)' },
  }] } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{
    resolveResource: async () => binding, requestResource: async () => image,
  }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open image: Screenshot"]')!.click());
  const dialog = document.querySelector('dialog[aria-label="Image preview"]')!;
  expect(dialog).not.toBeNull();
  const search = container.querySelector<HTMLButtonElement>('[aria-label="Search this session"]')!;
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })));
  expect(search.getAttribute('aria-expanded')).toBe('false');
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click());
  await act(async () => container.querySelector('[data-testid="timeline"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(search.getAttribute('aria-expanded')).toBe('true');
});

it('reopens a collapsed runtime notice group when the same search result is requested again', async () => {
  const state: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false,
    entries: ['First runtime notice', 'Second runtime notice'].map((message, index) => ({
      providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-03T00:00:00Z',
      sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'error', message },
    })),
  } };
  const container = await render(<SessionWorkbench state={state} sessionStatus="ready" actions={{}} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search this session"]')!.click());
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search session history"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Second runtime');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const scope = container.querySelector<HTMLSelectElement>('[aria-label="Search scope"]')!;
    scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const next = container.querySelector<HTMLButtonElement>('[aria-label="Next search result"]')!;
  expect(next.disabled).toBe(false);
  await act(async () => next.click());
  const toggle = container.querySelector<HTMLButtonElement>('.agent-notice-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const target = '.agent-timeline-entry[data-entry-key="epoch-1:recorded:2:error"]';
  expect(container.querySelector(target)?.getAttribute('data-inspected')).toBe('true');
  await act(async () => toggle.click());
  expect(container.querySelector(target)).toBeNull();
  await act(async () => next.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector(target)?.textContent).toContain('Second runtime notice');
});

it('retains an editable draft and history tools while handoff blocks native mutations', async () => {
  const sendMessage = vi.fn(), setSessionSetting = vi.fn(), executeCommand = vi.fn();
  const view = await render(<SessionWorkbench state={replicaState} sessionStatus="ready" mutationBlocked
    messageDraft="Keep working on this draft" composerStatus={<p>Handing off…</p>}
    actions={{ sendMessage, setSessionSetting, executeCommand }} />);
  expect(view.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({ value: 'Keep working on this draft', disabled: false });
  const send = view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  expect(send.disabled).toBe(true); await act(async () => send.click());
  expect(view.querySelector('[aria-label="Search this session"]')).not.toBeNull();
  expect(view.querySelector('[aria-label="Take control"]')).toBeNull();
  expect(view.textContent).toContain('Handing off…');
  expect(sendMessage).not.toHaveBeenCalled(); expect(setSessionSetting).not.toHaveBeenCalled(); expect(executeCommand).not.toHaveBeenCalled();
}, 5000);

it('keeps handoff recovery visible before a native session is available', async () => {
  const view = await render(<SessionWorkbench sessionStatus="disconnected" actions={{}} composerStatus={<p>Confirming the original handoff</p>} />);
  const notice = [...view.querySelectorAll('p')].find(item => item.textContent === 'Confirming the original handoff')!;
  expect(notice).toBeDefined(); expect(notice.closest('[hidden]')).toBeNull();
}, 5000);
