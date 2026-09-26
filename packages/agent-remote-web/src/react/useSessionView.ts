import type { SessionHandoffState } from '../client/session-control-extension.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentReplica } from '../replica/store.js';
import { RemoteSessionClient, type RemoteSessionStatus } from '../client/remote-session-client.js';
import type { AgentReplicaState } from '../replica/types.js';
import type { RemoteAgentTransport } from '../client/transport.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import type { SessionViewActions } from './session-view-actions.js';

export interface SessionConnectionLease { client: RemoteSessionClient; replica: AgentReplica; release(): void }
/** The owner controls retention and persistence; a mounted view owns only its lease. */
export interface SessionConnectionSource { acquire(agentId: string, replica: AgentReplica): SessionConnectionLease }

export function useSessionView({ agentId, transport, source, cachedReplica, pending = false, enabled = true }: {
  agentId: string; transport: RemoteAgentTransport; source?: SessionConnectionSource; cachedReplica?: AgentReplica; pending?: boolean; enabled?: boolean;
}) {
  const connections = useMemo<SessionConnectionSource>(() => source ?? { acquire(id, replica) {
    const client = new RemoteSessionClient(id, transport, replica, { historyPageSize: 100, requireSessionControl: true, clientKind: 'web' });
    client.start();
    return { client, replica, release: () => client.stop() };
  } }, [source, transport]);
  const [state, setState] = useState<AgentReplicaState | undefined>(() => cachedReplica?.getState().agent ? cachedReplica.getState() : undefined);
  const [status, setStatus] = useState<RemoteSessionStatus>('connecting');
  const [handoff, setHandoff] = useState<SessionHandoffState>();
  const [questions, setQuestions] = useState<Record<string, QuestionDraft>>({});
  const client = useRef<RemoteSessionClient>();
  useEffect(() => {
    const lease = connections.acquire(agentId, cachedReplica ?? new AgentReplica());
    const { replica, client: connection } = lease;
    client.current = connection;
    setState(replica.getState().agent ? replica.getState() : undefined); setStatus('connecting'); setQuestions({});
    const unsubscribe = replica.subscribe(() => setState(replica.getState()));
    const unsubscribeStatus = connection.subscribeSessionState(next => { setStatus(next.connection); setHandoff(next.handoff); });
    return () => { unsubscribe(); unsubscribeStatus(); lease.release(); if (client.current === connection) client.current = undefined; };
  }, [agentId, connections, cachedReplica]);
  const active = client.current;
  const messageActions: SessionViewActions = {
    deleteMessage: id => active?.deleteMessage(id),
    ...(active && !pending ? {
      sendMessage: async (text, options) => { await active.sendMessage(text, options); },
      sendMessageContent: async (content, options) => { await active.sendMessageContent(content, options); },
    } satisfies SessionViewActions : {}),
  };
  const actions: SessionViewActions = active && enabled && status === 'ready' && !pending ? {
    ...messageActions,
    takeControl: options => active.takeControl(options),
    uploadImage: (file, uploadId, options) => active.uploadImage(file, uploadId, options),
    retryMessage: async id => { await active.retryMessage(id); },
    loadOlder: () => active.loadOlder(), cancel: async () => { await active.cancel(); },
    setPlanning: async value => { await active.setPlanning(value); }, setSessionSetting: async (id, value) => { await active.setSessionSetting(id, value); },
    listCommands: () => active.listCommands(), executeCommand: (id, args) => active.executeCommand(id, args),
    respondToInteraction: async (id, response) => { await active.respondToInteraction(id, response); }, requestResource: async binding => (await active.requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => active.resolveResource(locator, sourceLocator),
  } : messageActions;
  const sendQueuedInput = active && enabled && status === 'ready' && !pending
    ? (text: string, operationId: string) => active.sendMessage(text, { operationId }) : undefined;
  return { state, handoff, status: enabled ? status : 'connecting' as const, questions, setQuestions, actions, sendQueuedInput };
}
