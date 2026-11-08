import 'fake-indexeddb/auto';
import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { render, promptText } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { DraftStore } from '../draft-store.js';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { LabWorkbench } from './LabWorkbench.js';

const state: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false, entries: [
  { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'user_message', text: 'Keep this request visible' } },
  { providerId: 'recorded', seqStart: 2, seqEnd: 2, timestamp: 'now', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'reasoning', text: 'Hidden reasoning' } },
  { providerId: 'recorded', seqStart: 3, seqEnd: 3, timestamp: 'now', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'error', message: 'A visible failure' } },
] } };
it('locks Bot content without changing the Window display or text/image editor owners', async () => {
  const store = new DraftStore('fixed-display'); store.set('text-owner', 'Keep my draft');
  const draftBinding = { store, key: 'text-owner' }, imageDraftBinding = { scope: 'fixed-display', key: 'image-owner' };
  const windowView = { ...createWindowView('view', undefined, 'primary'), display: { mode: 'preview' as const, lettersVisible: true } };
  const operate = vi.fn(); let toggle!: (fixed: boolean) => void;
  function Harness() {
    const [fixed, set] = useState(false); toggle = set;
    return <WindowLayoutContext.Provider value={{ window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, views: [windowView], selectedPrimaryViewId: 'view', selectedViewId: 'view' }, operate }}>
      <LabWorkbench state={state} sessionStatus="ready" actions={{}} draftSessionKey="native" draftBinding={draftBinding} imageDraftBinding={imageDraftBinding}
        displayBinding={{ scope: 'fixed-display', key: 'view' }} fixedDisplayMode={fixed ? 'content' : undefined}
        revealEntry={fixed ? { key: 'epoch-1:recorded:2:reasoning', requestId: 1 } : undefined} />
    </WindowLayoutContext.Provider>;
  }
  const container = await render(<Harness />), prompt = container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
  const openOptions = async () => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  await openOptions();
  expect(container.querySelector<HTMLInputElement>('input[value="preview"]')?.checked).toBe(true);
  await act(async () => toggle(true));
  expect(container.textContent).toContain('Keep this request visible');
  expect(container.textContent).toContain('A visible failure');
  expect(container.querySelector('[data-entry-key="epoch-1:recorded:2:reasoning"]')).toBeNull();
  expect(container.querySelector('[aria-label="Session view options"]')).toBeNull();
  expect(container.querySelector('[data-testid="prompt-input"]')).toBe(prompt);
  expect(promptText(prompt)).toBe('Keep my draft');
  expect(operate).not.toHaveBeenCalled();
  expect(store.get('text-owner')).toBe('Keep my draft');
  await act(async () => toggle(false));
  await openOptions();
  expect(container.querySelector<HTMLInputElement>('input[value="preview"]')?.checked).toBe(true);
  expect(container.querySelector('[data-testid="prompt-input"]')).toBe(prompt);
  expect(operate).not.toHaveBeenCalled();
});

it('keeps approval, settings, interrupt and failed delivery controls available in fixed content', async () => {
  const pending = { kind: 'plan_approval' as const, requestId: 'approval', plan: 'Review the proposed change.', allowedActions: ['approve' as const] };
  const active = { ...state, pendingInteractions: [pending], agent: { ...state.agent!, status: 'running' as const,
    activeTurn: { turnId: 'turn', startedAt: '2026-11-08T00:00:00Z' }, capabilities: { ...state.agent!.capabilities, cancel: true, sessionSettings: true },
    runtimeInfo: { ...state.agent!.runtimeInfo, settings: [{ id: 'model', category: 'model' as const, label: 'Model', value: 'first', mutable: true, scope: 'session' as const,
      options: [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }] }] } } };
  const approve = vi.fn(async () => {}), cancel = vi.fn(async () => {}), setting = vi.fn(async () => {});
  const container = await render(<LabWorkbench fixedDisplayMode="content" state={active} sessionStatus="ready" messageDraft="A useful draft"
    actions={{ respondToInteraction: approve, cancel, setSessionSetting: setting, sendMessage: async () => { throw new Error('Delivery could not be confirmed.'); } }} />);
  expect(container.querySelector('[aria-label="Session view options"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click());
  expect(approve).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="cancel-submit"]')!.click());
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!.click());
  await act(async () => { const select = container.querySelector<HTMLSelectElement>('[data-testid="session-setting-model"]')!; select.value = 'second'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(setting).toHaveBeenCalledWith('model', 'second');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.textContent).toContain('Delivery could not be confirmed.');
  expect(container.textContent).toContain('A visible failure');
  expect(promptText(container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!)).toBe('A useful draft');
});
