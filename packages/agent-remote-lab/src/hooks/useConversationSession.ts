import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { WorkspaceReady } from '../workspace-access.js';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AgentReplica, RemoteSessionClient, type AgentReplicaState, type RemoteAgentTransport, type RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import type { QuestionDraft } from '@orchardworks/agent-remote-web/react';
import type { OpenedSession } from '../directory-client.js';
import type { LabWorkbenchActions } from '../components/LabWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';

/** Mounted views share the retained conversation subscription and its replica. */
export function useConversationSession(session: OpenedSession, transport: RemoteAgentTransport, cachedReplica?: AgentReplica, pending = false) {
  const accessReady = useContext(WorkspaceReady);
  const recoveryScope = useContext(RecoveryScope)?.scope;
  const sharedConnections = useContext(ConversationConnectionScope);
  const connections = useMemo(() => sharedConnections ?? new ConversationConnections(transport, recoveryScope), [sharedConnections, transport, recoveryScope]);
  useEffect(() => () => { if (!sharedConnections) connections.clear(); }, [connections, sharedConnections]);
  const [state, setState] = useState<AgentReplicaState | undefined>(() => cachedReplica?.getState().agent ? cachedReplica.getState() : undefined);
  const [status, setStatus] = useState<RemoteSessionStatus>('connecting');
  const [questions, setQuestions] = useState<Record<string, QuestionDraft>>({});
  const client = useRef<RemoteSessionClient>();
  useEffect(() => {
    const lease = connections.acquire(session.agentId, cachedReplica ?? new AgentReplica(), session);
    const { replica, client: connection } = lease;
    client.current = connection;
    setState(replica.getState().agent ? replica.getState() : undefined); setStatus('connecting'); setQuestions({});
    const unsubscribe = replica.subscribe(() => setState(replica.getState()));
    const unsubscribeStatus = connection.subscribeStatus(setStatus);
    return () => { unsubscribe(); unsubscribeStatus(); lease.release(); if (client.current === connection) client.current = undefined; };
  }, [session.agentId, connections, cachedReplica]);
  const active = client.current;
  const messageActions: LabWorkbenchActions = {
    deleteMessage: id => active?.deleteMessage(id),
    ...(active && !pending ? {
      sendMessage: async (text, options) => { await active.sendMessage(text, options); },
      sendMessageContent: async (content, options) => { await active.sendMessageContent(content, options); },
    } satisfies LabWorkbenchActions : {}),
  };
  const actions: LabWorkbenchActions = accessReady && active && status === 'ready' && !pending ? {
    ...messageActions,
    uploadImage: (file, uploadId, options) => active.uploadImage(file, uploadId, options),
    retryMessage: async id => { await active.retryMessage(id); },
    loadOlder: () => active.loadOlder(), cancel: async () => { await active.cancel(); },
    setPlanning: async value => { await active.setPlanning(value); }, setSessionSetting: async (id, value) => { await active.setSessionSetting(id, value); },
    listCommands: () => active.listCommands(), executeCommand: (id, args) => active.executeCommand(id, args),
    respondToInteraction: async (id, response) => { await active.respondToInteraction(id, response); }, requestResource: async binding => (await active.requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => active.resolveResource(locator, sourceLocator),
  } : messageActions;
  const sendQueuedInput = accessReady && active && status === 'ready' && !pending
    ? (text: string, operationId: string) => active.sendMessage(text, { operationId }) : undefined;
  return { state, status: accessReady ? status : 'connecting' as const, questions, setQuestions, actions, sendQueuedInput };
}
