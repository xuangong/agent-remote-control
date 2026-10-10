import { useEffect, useRef } from 'react';
import type { AgentReplica, AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { OpenedSession } from '../directory-client.js';
import { isAskAttached, askParticipantKey, type useAskConversations } from '../hooks/useAskConversations.js';
import type { SessionObservation } from '../tracking-state.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { AskButton } from './AskButton.js';
import { AskConversation } from './AskConversation.js';
import type { ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';

/** Each source view owns its Ask surface; the shared ledger owns native identities. */
export function SessionAsk({ source, state, ask, visible, available, canRestore, storageScope, synchronize, onOpen, replicaFor, transport, observations, navigation, associationOwner, imageRecipient }: {
  source: OpenedSession; state?: AgentReplicaState; ask: ReturnType<typeof useAskConversations>;
  visible: boolean; available: boolean; canRestore: boolean; storageScope: string;
  synchronize(): Promise<void>; onOpen(clean?: boolean): void;
  replicaFor(id: string): AgentReplica; transport: RemoteAgentTransport;
  observations: Record<string, SessionObservation>; navigation: SessionViewNavigationFactory;
  associationOwner?: string; imageRecipient?: ImageDraftRecipient;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const key = associationOwner ?? sessionKey(source);
  const owner = associationOwner ? ask.associationOwner(associationOwner) : undefined;
  const geometryScope = owner?.geometryScope ?? JSON.stringify([storageScope, key]);
  const entry = ask.entryFor(source, associationOwner);
  const attached = isAskAttached(entry);
  const participant = entry.record ? askParticipantKey(entry.record) : undefined;
  const enabled = ask.isEnabled(source, associationOwner);
  const expanded = ask.isOpen(source, associationOwner);
  useEffect(() => {
    if (!visible || !canRestore || !enabled || !expanded) return;
    return associationOwner ? ask.restore(source, synchronize, associationOwner) : ask.restore(source, synchronize);
  }, [storageScope, ask.store, transport, key, source.agentId, visible, canRestore, enabled, expanded, synchronize]);
  if (!visible || !enabled) return null;
  return <>
    <AskButton triggerRef={trigger} storageScope={geometryScope} hidden={expanded} disabled={!available || (!state?.agent && !entry.record?.target)}
      observation={entry.record?.target ? observations[sessionKey(entry.record.target)] : undefined} onOpen={() => onOpen()} />
    {expanded ? <AskConversation entry={entry} storageScope={geometryScope}
      transport={transport} replica={attached && entry.record?.target ? replicaFor(entry.record.target.agentId) : undefined}
      triggerRef={trigger} navigation={navigation} onSendInput={(id, send) => ask.sendInput(key, id, send, participant)}
      onDiscardInput={id => ask.discardInput(key, id)}
      draftBinding={owner ? ask.draftBinding(owner.id) : { store: ask.drafts, key }} imageDraftBinding={owner?.image} displayBinding={owner?.display} imageRecipient={imageRecipient}
      onClose={() => associationOwner ? ask.close(source, associationOwner) : ask.close(source)} onToggleEnabled={() => associationOwner ? ask.toggle(source, associationOwner) : ask.toggle(source)}
      onClean={() => onOpen(true)} onRetry={() => onOpen()} /> : null}
  </>;
}
