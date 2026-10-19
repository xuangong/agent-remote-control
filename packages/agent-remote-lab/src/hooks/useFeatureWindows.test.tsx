import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow, type WindowOperation, type TpmWork } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, createCompositionSlot, createAskOwner } from '../session-composition.js';
import { render } from '../test/setup.js';
import { useTpmWork, type TpmService } from './useTpmWork.js';
import { useAskConversations } from './useAskConversations.js';

it('projects remote feature opening and closing through existing Ask owners and TPM catalog records', async () => {
  const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
  const document = createCompositionDocument('https://feature-window.test');
  const slot = createCompositionSlot('main', source, document.scope); document.slots.push(slot);
  const owner = createAskOwner(slot, document.scope); document.asks.push(owner);
  const work: TpmWork = { id: 'work', revision: 1, title: 'Work', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 100 };
  const service: TpmService = { tpmList: async () => ({ supported: true, works: [work] }), tpmWork: async () => work, tpmCreate: async () => work, tpmAction: async () => work };
  let tpm!: ReturnType<typeof useTpmWork>, ask!: ReturnType<typeof useAskConversations>, operate!: (op: WindowOperation) => void;
  let current!: WorkspaceWindow;
  function Harness() {
    const [window, setWindow] = useState<WorkspaceWindow>({ schemaVersion: 3, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId, title: source.title }, 'primary')] });
    current = window; operate = operation => setWindow(value => applyWindowOperation(value, operation));
    const authority = { window, operate };
    tpm = useTpmWork(service, [{ id: 'host', name: 'Host', online: true }], true, async value => ({ ...value, agentId: 'agent' }), true, document.scope, authority);
    ask = useAskConversations(document, {} as never, undefined, 'host', undefined, undefined, authority);
    return null;
  }
  await render(<Harness />);
  const key = JSON.stringify(['host', 'work']);
  await act(async () => tpm.open(key));
  expect(tpm.windows).toEqual([key]);
  expect(current.views.find(view => view.feature?.kind === 'tpm')?.closeWith).toBe('main');
  await act(async () => operate({ type: 'view.create', view: { ...createWindowView('ask-view', undefined, 'float'), feature: { kind: 'ask', id: owner.id }, closeWith: 'main', bindingPolicy: 'managed' } }));
  expect(ask.isOpen(source, owner.id)).toBe(true);
  expect(owner.open).toBe(false);
  await act(async () => ask.close(source, owner.id));
  expect(ask.isOpen(source, owner.id)).toBe(false);
  await act(async () => tpm.close(key));
  expect(tpm.windows).toEqual([]);
  expect(tpm.works).toHaveLength(1);
});
