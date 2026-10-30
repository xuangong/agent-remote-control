import { act, useState, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { ReadingPositions, RecoveryScope } from '../conversation-recovery.js';
import { replicaState } from '../test/fixtures.js';
import { render, unmount } from '../test/setup.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionWorkbench } from './SessionWorkbench.js';

const state: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false,
  entries: [
    { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-08T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'user_message', text: 'User request' } },
    { providerId: 'recorded', seqStart: 2, seqEnd: 2, timestamp: '2026-10-08T00:00:01Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'reasoning', text: 'Private reasoning detail' } },
    { providerId: 'recorded', seqStart: 3, seqEnd: 3, timestamp: '2026-10-08T00:00:02Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'agent_communication', messageId: 'letter', sender: '/root', recipient: '/root/review', text: 'Review this change.' } },
  ],
} };
const props = { state, sessionStatus: 'ready' as const, actions: {} };
const modeInput = (container: ParentNode, mode: string) => container.querySelector<HTMLInputElement>(`input[name^="session-display-"][value="${mode}"]`)!;
const lettersInput = (container: ParentNode) => container.querySelector<HTMLInputElement>('input[aria-label="Show letters"]')!;
async function options(container: ParentNode) {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Session view options"]');
  expect(button, 'Every session has its own display control').not.toBeNull();
  if (button!.getAttribute('aria-expanded') !== 'true') await act(async () => button!.click());
}
afterEach(() => {
  localStorage.removeItem('agent-remote:timeline-display');
  localStorage.removeItem('agent-remote:show-letters');
});

it('changes one view without filtering its neighboring conversation or letters', async () => {
  const container = await render(<RecoveryScope.Provider value={new ReadingPositions('relay')}>
    <section data-view="first"><LabWorkbench {...props} draftSessionKey="first" /></section>
    <section data-view="second"><LabWorkbench {...props} draftSessionKey="second" /></section>
  </RecoveryScope.Provider>);
  const first = container.querySelector('[data-view="first"]')!;
  const second = container.querySelector('[data-view="second"]')!;
  await options(first);
  await act(async () => modeInput(first, 'content').click());
  await act(async () => lettersInput(first).click());
  expect(first.querySelector('[data-entry-key="epoch-1:recorded:2:reasoning"]')).toBeNull();
  expect(first.querySelector('[data-entry-key="epoch-1:recorded:3:letter"]')).toBeNull();
  expect(second.querySelector('[data-entry-key="epoch-1:recorded:2:reasoning"]')).not.toBeNull();
  expect(second.querySelector('[data-entry-key="epoch-1:recorded:3:letter"]')).not.toBeNull();
  await options(second);
  expect(modeInput(second, 'simple').checked).toBe(true);
  expect(lettersInput(second).checked).toBe(true);
});

it('restores native-session preferences without carrying them into another session or relay', async () => {
  let switchView!: (next: { scope: string; session: string; agentId?: string }) => void;
  function Harness() {
    const [view, setView] = useState({ scope: 'relay-one', session: 'first', agentId: 'old-agent' });
    switchView = next => setView(current => ({ ...current, ...next }));
    return <RecoveryScope.Provider value={new ReadingPositions(view.scope)}><LabWorkbench {...props} state={{ ...state, agent: { ...state.agent!, id: view.agentId } }} draftSessionKey={view.session} /></RecoveryScope.Provider>;
  }
  const container = await render(<Harness />);
  await options(container);
  await act(async () => { modeInput(container, 'content').click(); lettersInput(container).click(); });
  await act(async () => switchView({ scope: 'relay-one', session: 'second' }));
  await options(container);
  expect(modeInput(container, 'simple').checked).toBe(true);
  expect(lettersInput(container).checked).toBe(true);
  await act(async () => switchView({ scope: 'relay-one', session: 'first', agentId: 'new-agent' }));
  await options(container);
  expect(modeInput(container, 'content').checked).toBe(true);
  expect(lettersInput(container).checked).toBe(false);
  await act(async () => switchView({ scope: 'relay-two', session: 'first' }));
  await options(container);
  expect(modeInput(container, 'simple').checked).toBe(true);
  await unmount(container);
  const restored = await render(<RecoveryScope.Provider value={new ReadingPositions('relay-one')}><LabWorkbench {...props} draftSessionKey="first" /></RecoveryScope.Provider>);
  await options(restored);
  expect(modeInput(restored, 'content').checked).toBe(true);
  expect(lettersInput(restored).checked).toBe(false);
});

it('reveals filtered trace entries only in their owning view and preserves the letters choice afterward', async () => {
  let reveal!: (request: ComponentProps<typeof LabWorkbench>['revealEntry']) => void;
  function Harness() {
    const [request, setRequest] = useState<ComponentProps<typeof LabWorkbench>['revealEntry']>();
    reveal = setRequest;
    return <RecoveryScope.Provider value={new ReadingPositions('relay')}>
      <section data-view="first"><LabWorkbench {...props} draftSessionKey="first" revealEntry={request} /></section>
      <section data-view="second"><LabWorkbench {...props} draftSessionKey="second" /></section>
    </RecoveryScope.Provider>;
  }
  const container = await render(<Harness />);
  const first = container.querySelector('[data-view="first"]')!;
  const second = container.querySelector('[data-view="second"]')!;
  await options(first);
  await act(async () => { modeInput(first, 'content').click(); lettersInput(first).click(); });
  await act(async () => reveal({ key: 'epoch-1:recorded:3:letter', requestId: 1 }));
  expect(first.querySelector('[data-entry-key="epoch-1:recorded:3:letter"]')).not.toBeNull();
  expect(modeInput(first, 'content').checked).toBe(true);
  await act(async () => lettersInput(first).click());
  expect(first.querySelector('[data-entry-key="epoch-1:recorded:3:letter"]')).toBeNull();
  await act(async () => reveal({ key: 'epoch-1:recorded:2:reasoning', requestId: 2 }));
  expect(first.querySelector('[data-entry-key="epoch-1:recorded:2:reasoning"]')).not.toBeNull();
  expect(modeInput(first, 'simple').checked).toBe(true);
  await options(second);
  expect(modeInput(second, 'simple').checked).toBe(true);
});

it('uses the same display controls in a standalone session view', async () => {
  const container = await render(<SessionWorkbench {...props} />);
  await options(container);
  await act(async () => modeInput(container, 'content').click());
  expect(container.querySelector('[data-entry-key="epoch-1:recorded:2:reasoning"]')).toBeNull();
  await act(async () => container.querySelector('section[aria-label="Session view options"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(container.querySelector('section[aria-label="Session view options"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button[aria-label="Session view options"]'));
});

it('migrates existing display choices while honoring a new view default', async () => {
  localStorage.setItem('agent-remote:timeline-display', 'content');
  localStorage.setItem('agent-remote:show-letters', 'false');
  const container = await render(<RecoveryScope.Provider value={new ReadingPositions('relay')}>
    <section data-view="main"><LabWorkbench {...props} draftSessionKey="main" /></section>
    <section data-view="ask"><LabWorkbench {...props} draftSessionKey="ask" defaultDisplayMode="content" /></section>
  </RecoveryScope.Provider>);
  const main = container.querySelector('[data-view="main"]')!;
  const ask = container.querySelector('[data-view="ask"]')!;
  await options(main);
  expect(modeInput(main, 'content').checked).toBe(true);
  expect(lettersInput(main).checked).toBe(false);
  await options(ask);
  expect(modeInput(ask, 'content').checked).toBe(true);
  await act(async () => modeInput(ask, 'preview').click());
  await unmount(container);
  const restored = await render(<RecoveryScope.Provider value={new ReadingPositions('relay')}><LabWorkbench {...props} draftSessionKey="ask" defaultDisplayMode="content" /></RecoveryScope.Provider>);
  await options(restored);
  expect(modeInput(restored, 'preview').checked).toBe(true);
});
import { inspectSessionDisplayPreferences, flushSessionDisplayPreferences } from '../hooks/useSessionDisplayPreferences.js';
afterEach(() => vi.restoreAllMocks());

it('retains independent display owners across native replacements and checks failed unmounted writes', async () => {
  const binding = { scope: 'display-owner-scope', key: 'display-owner-A' };
  let replace!: () => void;
  function Harness() {
    const [native, setNative] = useState('A'); replace = () => setNative('B');
    return <RecoveryScope.Provider value={new ReadingPositions('native-scope')}><LabWorkbench {...props} draftSessionKey={native} displayBinding={binding} /></RecoveryScope.Provider>;
  }
  const container = await render(<Harness />); await options(container);
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  await act(async () => modeInput(container, 'content').click());
  await act(async () => replace());
  await options(container);
  expect(modeInput(container, 'content').checked).toBe(true);
  const saved = inspectSessionDisplayPreferences(binding);
  expect(saved).toMatchObject({ status: 'failed', preferences: { mode: 'content' }, retention: 'page' });
  await unmount(container); denied.mockRestore();
  expect(flushSessionDisplayPreferences(binding, saved.revision, () => true)).toMatchObject({ status: 'ready', retention: 'local', preferences: { mode: 'content' } });
  expect(localStorage.getItem('agent-remote:recovery:display-owner-scope:view:display-owner-A')).toContain('content');
  expect(localStorage.getItem('agent-remote:recovery:native-scope:view:B')).toBeNull();
});

it('treats damaged display storage as unknown and refuses stale retention', () => {
  const binding = { scope: 'damaged-display', key: 'owner' };
  localStorage.setItem('agent-remote:recovery:damaged-display:view:owner', '{bad');
  expect(inspectSessionDisplayPreferences(binding).status).toBe('failed');
  expect(flushSessionDisplayPreferences(binding, 0, () => true).status).toBe('failed');
  expect(flushSessionDisplayPreferences(binding, 0, () => false).status).toBe('cancelled');
  expect(localStorage.getItem('agent-remote:recovery:damaged-display:view:owner')).toBe('{bad');
});


it.each(['simple', 'content'])('retains an unmounted absent Ask display without choosing its later content default over global %s', async legacy => {
  if (legacy === 'content') localStorage.setItem('agent-remote:timeline-display', legacy);
  const scope = `unmounted-display-${legacy}`, binding = { scope, key: 'ask-owner' };
  const { useAskConversations } = await import('../hooks/useAskConversations.js');
  const { sessionKey } = await import('../session-tree.js');
  const source = { agentId: 'source', providerId: 'codex', nativeSessionId: 'native', hostId: 'local', title: 'Source' };
  const key = sessionKey(source), transport = {} as import('@orchardworks/agent-remote-web').RemoteAgentTransport;
  let ask!: ReturnType<typeof useAskConversations>;
  const { createCompositionDocument, createCompositionSlot, createAskOwner } = await import('../session-composition.js');
  const slot = createCompositionSlot('A', source, scope);
  const document = createCompositionDocument(scope, [slot]);
  function OwnerHarness() { ask = useAskConversations(document, transport); return null; }
  const owner = { ...createAskOwner(slot, scope), image: undefined, display: binding };
  document.asks.push(owner);
  const ownerContainer = await render(<OwnerHarness />);
  await act(async () => {
    expect((await ask.retainAssociationOwners([owner.id], () => true)).status).toBe('applied');
  });
  const storageKey = `agent-remote:recovery:${scope}:view:${binding.key}`;
  expect(localStorage.getItem(storageKey)).toBeNull();
  await unmount(ownerContainer);
  const mainBinding = { scope, key: 'main-owner' };
  const main = inspectSessionDisplayPreferences(mainBinding);
  expect(flushSessionDisplayPreferences(mainBinding, main.revision, () => true).status).toBe('ready');
  let container = await render(<RecoveryScope.Provider value={new ReadingPositions(scope)}>
    <section data-view="ask"><LabWorkbench {...props} draftSessionKey="ask" displayBinding={binding} defaultDisplayMode="content" /></section>
    <section data-view="main"><LabWorkbench {...props} draftSessionKey="main" displayBinding={mainBinding} /></section>
  </RecoveryScope.Provider>);
  const askView = container.querySelector('[data-view="ask"]')!, mainView = container.querySelector('[data-view="main"]')!;
  await options(askView); await options(mainView);
  expect(modeInput(askView, 'content').checked).toBe(true);
  expect(modeInput(mainView, legacy).checked).toBe(true);
  expect(localStorage.getItem(storageKey)).toBeNull();
  await act(async () => modeInput(askView, 'preview').click());
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ mode: 'preview' });
  await unmount(container);
  container = await render(<LabWorkbench {...props} displayBinding={binding} defaultDisplayMode="content" />);
  await options(container); expect(modeInput(container, 'preview').checked).toBe(true);
});

it('recovers an absent display read without persisting an inspection default', async () => {
  const binding = { scope: 'unread-absent-display', key: 'owner' }, key = `agent-remote:recovery:unread-absent-display:view:owner`;
  const original = Storage.prototype.getItem;
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
    if (name === key) throw new Error('Unavailable'); return original.call(this, name);
  });
  const inspected = inspectSessionDisplayPreferences(binding);
  expect(inspected.status).toBe('failed');
  expect(flushSessionDisplayPreferences(binding, inspected.revision, () => true).status).toBe('failed');
  denied.mockRestore();
  expect(flushSessionDisplayPreferences(binding, inspected.revision, () => true).status).toBe('ready');
  expect(localStorage.getItem(key)).toBeNull();
  const container = await render(<LabWorkbench {...props} displayBinding={binding} defaultDisplayMode="content" />);
  await options(container); expect(modeInput(container, 'content').checked).toBe(true);
});

it('preserves an explicit unmounted display preference over a later content default', async () => {
  const binding = { scope: 'explicit-unmounted-display', key: 'owner' }, key = `agent-remote:recovery:explicit-unmounted-display:view:owner`;
  localStorage.setItem(key, JSON.stringify({ mode: 'simple', lettersVisible: false }));
  const inspected = inspectSessionDisplayPreferences(binding);
  expect(flushSessionDisplayPreferences(binding, inspected.revision, () => true).status).toBe('ready');
  const container = await render(<LabWorkbench {...props} displayBinding={binding} defaultDisplayMode="content" />);
  await options(container);
  expect(modeInput(container, 'simple').checked).toBe(true); expect(lettersInput(container).checked).toBe(false);
});
