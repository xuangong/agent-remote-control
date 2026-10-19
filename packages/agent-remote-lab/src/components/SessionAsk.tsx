import { useWindowLayout } from '../window-workspace-context.js';
import { useEffect, type RefObject } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { FilePreviewScope } from '@orchardworks/agent-remote-web/react';
import type { OpenedSession } from '../directory-client.js';
import { isAskAttached, askParticipantKey, type useAskConversations } from '../hooks/useAskConversations.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { AskConversation } from './AskConversation.js';
import type { ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import { resolveAskPresentation } from '../ask-presentation.js';

/** Each source association retains its Ask conversation in the global surface. */
export function SessionAsk({ source, ask, visible, canRestore, storageScope, synchronize, onOpen, onToggleEnabled, triggerRef, replicaFor, transport, navigation, associationOwner, imageRecipient, compact = false }: {
  source: OpenedSession; ask: ReturnType<typeof useAskConversations>;
  visible: boolean; canRestore: boolean; storageScope: string;
  synchronize(): Promise<void>; onOpen(clean?: boolean): void; onToggleEnabled(): void;
  triggerRef: RefObject<HTMLButtonElement>;
  replicaFor(id: string): AgentReplica; transport: RemoteAgentTransport;
  navigation: SessionViewNavigationFactory;
  compact?: boolean; associationOwner: string; imageRecipient?: ImageDraftRecipient;
}) {
  const shared = useWindowLayout();
  const sharedView = ask.sharedView(associationOwner);
  const sharedTarget = sharedView?.binding && sessionKey(sharedView.binding);
  const key = associationOwner;
  const owner = ask.associationOwner(associationOwner);
  if (!owner) throw new Error('Ask owner unavailable.');
  const geometryScope = owner.geometryScope;
  const entry = ask.entryFor(source, associationOwner);
  const attached = isAskAttached(entry);
  const participant = entry.record ? askParticipantKey(entry.record) : undefined;
  const expanded = ask.isOpen(source, associationOwner);
  const { shown, selected } = resolveAskPresentation({ window: shared?.window, view: sharedView, visible, expanded, compact });
  const focus = (event: { target: EventTarget }) => {
    if (!shared || !sharedView || event.target instanceof Element && event.target.closest('[data-pane-selection-ignore],.lab-session-family-pane')) return;
    if ((shared.readWindow?.() ?? shared.window).selectedViewId !== sharedView.id) shared.operate({ type: 'view.select', viewId: sharedView.id });
  };
  useEffect(() => {
    if (!shown || !canRestore) return;
    return ask.restore(source, synchronize, associationOwner);
  }, [storageScope, ask.store, transport, key, source.agentId, shown, canRestore, synchronize, sharedTarget]);
  if (!shown) return null;
  return <div className="lab-session-ask-surface" data-ask-source={sessionKey(source)} data-ask-owner={associationOwner}
    style={{ zIndex: selected ? 2 : 1 }} onPointerDownCapture={focus} onFocusCapture={focus}>
    <FilePreviewScope resourceScope={JSON.stringify([associationOwner, participant])}><AskConversation baseUrl={storageScope} viewId={sharedView?.id} compact={compact} entry={entry} storageScope={geometryScope}
      transport={transport} replica={attached && entry.record?.target ? replicaFor(entry.record.target.agentId) : undefined}
      triggerRef={triggerRef} navigation={navigation} onSendInput={(id, send) => ask.sendInput(key, id, send, participant)}
      onDiscardInput={id => ask.discardInput(key, id)}
      draftBinding={ask.draftBinding(owner.id)} imageDraftBinding={owner.image} displayBinding={sharedView ? { scope: owner.display?.scope ?? storageScope, key: sharedView.id } : owner.display} imageRecipient={imageRecipient}
      onClose={() => ask.minimize(source, associationOwner)} onToggleEnabled={onToggleEnabled}
      onClean={() => onOpen(true)} onRetry={() => onOpen()} /></FilePreviewScope>
  </div>;
}
