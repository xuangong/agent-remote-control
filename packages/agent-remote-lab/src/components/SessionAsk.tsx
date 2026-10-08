import { useEffect, useRef } from 'react';
import type { AgentReplica, AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { OpenedSession } from '../directory-client.js';
import type { useAskConversations } from '../hooks/useAskConversations.js';
import type { SessionObservation } from '../tracking-state.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { AskButton } from './AskButton.js';
import { AskConversation } from './AskConversation.js';

/** Each source view owns its Ask surface; the shared ledger owns native identities. */
export function SessionAsk({ source, state, ask, visible, available, canRestore, storageScope, synchronize, onOpen, replicaFor, transport, observations, navigation }: {
  source: OpenedSession; state?: AgentReplicaState; ask: ReturnType<typeof useAskConversations>;
  visible: boolean; available: boolean; canRestore: boolean; storageScope: string;
  synchronize(): Promise<void>; onOpen(clean?: boolean): void;
  replicaFor(id: string): AgentReplica; transport: RemoteAgentTransport;
  observations: Record<string, SessionObservation>; navigation: SessionViewNavigationFactory;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const key = sessionKey(source);
  const entry = ask.entryFor(source);
  const enabled = ask.isEnabled(source);
  const expanded = ask.isOpen(source);
  useEffect(() => {
    if (!visible || !canRestore || !enabled || !expanded) return;
    return ask.restore(source, synchronize);
  }, [storageScope, ask.store, transport, key, source.agentId, visible, canRestore, enabled, expanded, synchronize]);
  if (!visible || !enabled) return null;
  return <>
    <AskButton triggerRef={trigger} storageScope={JSON.stringify([storageScope, key])} hidden={expanded} disabled={!available || (!state?.agent && !entry.record?.target)}
      observation={entry.record?.target ? observations[sessionKey(entry.record.target)] : undefined} onOpen={() => onOpen()} />
    {expanded ? <AskConversation entry={entry} store={ask.store} storageScope={JSON.stringify([storageScope, key])}
      transport={transport} replica={entry.attached && entry.record?.target ? replicaFor(entry.record.target.agentId) : undefined}
      triggerRef={trigger} navigation={navigation} onSendInput={(id, send) => ask.sendInput(key, id, send)}
      draftBinding={{ store: ask.drafts, key }} onClose={() => ask.close(source)} onToggleEnabled={() => ask.toggle(source)}
      onClean={() => onOpen(true)} onRetry={() => onOpen()} /> : null}
  </>;
}
