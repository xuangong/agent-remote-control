import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, createCompositionSlot, createAskOwner } from '../../kernel/session-composition.js';
import { render } from '../../test/setup.js';
import { useAskConversations } from '../team/useAskConversations.js';

it('projects remote feature opening and closing through existing Ask owners', async () => {
  const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
  const document = createCompositionDocument('https://feature-window.test');
  const slot = createCompositionSlot('main', source, document.scope); document.slots.push(slot);
  const owner = createAskOwner(slot, document.scope); document.asks.push(owner);
  let ask!: ReturnType<typeof useAskConversations>, operate!: (op: WindowOperation) => void;
  let current!: WorkspaceWindow;
  function Harness() {
    const [window, setWindow] = useState<WorkspaceWindow>({ schemaVersion: 3, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId, title: source.title }, 'primary')] });
    current = window; operate = operation => setWindow(value => applyWindowOperation(value, operation));
    const authority = { window, operate };
    ask = useAskConversations(document, {} as never, undefined, 'host', undefined, undefined, authority);
    return null;
  }
  await render(<Harness />);
  await act(async () => operate({ type: 'view.create', view: { ...createWindowView('ask-view', undefined, 'float'), feature: { kind: 'ask', id: owner.id }, closeWith: 'main', bindingPolicy: 'managed' } }));
  expect(ask.isOpen(source, owner.id)).toBe(true);
  expect(owner.open).toBe(false);
  await act(async () => ask.close(source, owner.id));
  expect(ask.isOpen(source, owner.id)).toBe(false);
});
