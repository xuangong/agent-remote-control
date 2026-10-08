import { act, useState, type ComponentProps } from 'react';
import { afterEach, expect, it } from 'vitest';
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
  expect(modeInput(second, 'preview').checked).toBe(true);
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
  expect(modeInput(container, 'preview').checked).toBe(true);
  expect(lettersInput(container).checked).toBe(true);
  await act(async () => switchView({ scope: 'relay-one', session: 'first', agentId: 'new-agent' }));
  await options(container);
  expect(modeInput(container, 'content').checked).toBe(true);
  expect(lettersInput(container).checked).toBe(false);
  await act(async () => switchView({ scope: 'relay-two', session: 'first' }));
  await options(container);
  expect(modeInput(container, 'preview').checked).toBe(true);
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
  expect(modeInput(second, 'preview').checked).toBe(true);
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
  localStorage.setItem('agent-remote:timeline-display', 'simple');
  localStorage.setItem('agent-remote:show-letters', 'false');
  const container = await render(<RecoveryScope.Provider value={new ReadingPositions('relay')}>
    <section data-view="main"><LabWorkbench {...props} draftSessionKey="main" /></section>
    <section data-view="ask"><LabWorkbench {...props} draftSessionKey="ask" defaultDisplayMode="content" /></section>
  </RecoveryScope.Provider>);
  const main = container.querySelector('[data-view="main"]')!;
  const ask = container.querySelector('[data-view="ask"]')!;
  await options(main);
  expect(modeInput(main, 'simple').checked).toBe(true);
  expect(lettersInput(main).checked).toBe(false);
  await options(ask);
  expect(modeInput(ask, 'content').checked).toBe(true);
  await act(async () => modeInput(ask, 'preview').click());
  await unmount(container);
  const restored = await render(<RecoveryScope.Provider value={new ReadingPositions('relay')}><LabWorkbench {...props} draftSessionKey="ask" defaultDisplayMode="content" /></RecoveryScope.Provider>);
  await options(restored);
  expect(modeInput(restored, 'preview').checked).toBe(true);
});
