import { useEffect, useRef } from 'react';
import type { AgentReplica, AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { OpenedSession } from '../directory-client.js';
import { isAskAttached, askParticipantKey, type useAskConversations } from '../hooks/useAskConversations.js';
import type { SessionObservation } from '../tracking-state.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { useSessionDocked } from './SessionDock.js';
import { AskButton } from './AskButton.js';
import { AskConversation } from './AskConversation.js';
import type { ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';

/** Each source view owns its Ask surface; the shared ledger owns native identities. */
export function SessionAsk({ source, state, ask, visible, surfaceVisible = visible, available, canRestore, storageScope, synchronize, onOpen, replicaFor, transport, observations, navigation, associationOwner, imageRecipient }: {
  source: OpenedSession; state?: AgentReplicaState; ask: ReturnType<typeof useAskConversations>;
  surfaceVisible?: boolean; visible: boolean; available: boolean; canRestore: boolean; storageScope: string;
  synchronize(): Promise<void>; onOpen(clean?: boolean): void;
  replicaFor(id: string): AgentReplica; transport: RemoteAgentTransport;
  observations: Record<string, SessionObservation>; navigation: SessionViewNavigationFactory;
  associationOwner: string; imageRecipient?: ImageDraftRecipient;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const key = associationOwner;
  const owner = ask.associationOwner(associationOwner);
  if (!owner) throw new Error('Ask owner unavailable.');
  const geometryScope = owner.geometryScope;
  const docked = useSessionDocked(`ask:${geometryScope}`);
  const shown = visible || docked && surfaceVisible;
  const entry = ask.entryFor(source, associationOwner);
  const attached = isAskAttached(entry);
  const participant = entry.record ? askParticipantKey(entry.record) : undefined;
  const enabled = ask.isEnabled(source, associationOwner);
  const expanded = ask.isOpen(source, associationOwner);
  useEffect(() => {
    if (!shown || !canRestore || !enabled || !expanded) return;
    return ask.restore(source, synchronize, associationOwner);
  }, [storageScope, ask.store, transport, key, source.agentId, shown, canRestore, enabled, expanded, synchronize]);
  if (!shown || !enabled) return null;
  return <>
    <AskButton triggerRef={trigger} storageScope={geometryScope} hidden={expanded} disabled={!available || (!state?.agent && !entry.record?.target)}
      observation={entry.record?.target ? observations[sessionKey(entry.record.target)] : undefined} onOpen={() => onOpen()} />
    {expanded ? <AskConversation entry={entry} storageScope={geometryScope}
      transport={transport} replica={attached && entry.record?.target ? replicaFor(entry.record.target.agentId) : undefined}
      triggerRef={trigger} navigation={navigation} onSendInput={(id, send) => ask.sendInput(key, id, send, participant)}
      onDiscardInput={id => ask.discardInput(key, id)}
      draftBinding={ask.draftBinding(owner.id)} imageDraftBinding={owner.image} displayBinding={owner.display} imageRecipient={imageRecipient}
      onClose={() => ask.close(source, associationOwner)} onToggleEnabled={() => ask.toggle(source, associationOwner)}
      onClean={() => onOpen(true)} onRetry={() => onOpen()} /> : null}
  </>;
}
