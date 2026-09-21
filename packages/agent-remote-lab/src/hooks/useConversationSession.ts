import { useContext, useEffect, useRef, useState } from 'react';
import { AgentReplica, RemoteSessionClient, type AgentReplicaState, type RemoteAgentTransport, type RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import type { QuestionDraft } from '@orchardworks/agent-remote-web/react';
import type { OpenedSession } from '../directory-client.js';
import type { LabWorkbenchActions } from '../components/LabWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { recoverMessages } from '../message-recovery.js';
import { sessionKey } from '../session-tree.js';

/** Each visible conversation owns an independent subscription on the shared transport. */
export function useConversationSession(session: OpenedSession, transport: RemoteAgentTransport, cachedReplica?: AgentReplica, pending = false) {
  const recoveryScope = useContext(RecoveryScope)?.scope;
  const [state, setState] = useState<AgentReplicaState | undefined>(() => cachedReplica?.getState().agent ? cachedReplica.getState() : undefined);
  const [status, setStatus] = useState<RemoteSessionStatus>('connecting');
  const [questions, setQuestions] = useState<Record<string, QuestionDraft>>({});
  const client = useRef<RemoteSessionClient>();
  useEffect(() => {
    const replica = cachedReplica ?? new AgentReplica();
    const stopRecovery = recoveryScope ? recoverMessages(replica, recoveryScope, sessionKey(session), session.agentId) : () => undefined;
    const connection = new RemoteSessionClient(session.agentId, transport, replica, { historyPageSize: 100 });
    client.current = connection;
    setState(replica.getState().agent ? replica.getState() : undefined); setStatus('connecting'); setQuestions({});
    const unsubscribe = replica.subscribe(() => setState(replica.getState()));
    const unsubscribeStatus = connection.subscribeStatus(setStatus);
    connection.start();
    return () => { unsubscribe(); unsubscribeStatus(); connection.stop(); stopRecovery(); if (client.current === connection) client.current = undefined; };
  }, [session.agentId, transport, recoveryScope, cachedReplica]);
  const active = client.current;
  const actions: LabWorkbenchActions = active && status === 'ready' && !pending ? {
    sendMessageContent: async (content, options) => { await active.sendMessageContent(content, options); },
    uploadImage: (file, uploadId, options) => active.uploadImage(file, uploadId, options),
    retryMessage: async id => { await active.retryMessage(id); }, deleteMessage: id => active.deleteMessage(id),
    loadOlder: () => active.loadOlder(), sendMessage: async (text, options) => { await active.sendMessage(text, options); }, cancel: async () => { await active.cancel(); },
    setPlanning: async value => { await active.setPlanning(value); }, setSessionSetting: async (id, value) => { await active.setSessionSetting(id, value); },
    listCommands: () => active.listCommands(), executeCommand: (id, args) => active.executeCommand(id, args),
    respondToInteraction: async (id, response) => { await active.respondToInteraction(id, response); }, requestResource: async binding => (await active.requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => active.resolveResource(locator, sourceLocator),
  } : { deleteMessage: id => active?.deleteMessage(id) };
  const sendQueuedInput = active && status === 'ready' && !pending
    ? (text: string, operationId: string) => active.sendMessage(text, { operationId }) : undefined;
  return { state, status, questions, setQuestions, actions, sendQueuedInput };
}
