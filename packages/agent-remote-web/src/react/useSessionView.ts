import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentReplica } from '../replica/store.js';
import { RemoteSessionClient } from '../client/remote-session-client.js';
import type { AgentReplicaState } from '../replica/types.js';
import type { RemoteAgentTransport } from '../client/transport.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import type { SessionViewActions } from './session-view-actions.js';
import type { ImageDraftRecipient } from '../image-drafts.js';

export interface SessionConnectionLease { client: RemoteSessionClient; replica: AgentReplica; release(): void }
/** The owner controls retention and persistence; a mounted view owns only its lease. */
export interface SessionConnectionSource { acquire(agentId: string, replica: AgentReplica): SessionConnectionLease }
/** Exact acquired view authority. Embedders supply operation policy and persistence. */
export interface SessionViewOperationScope {
  agentId: string; client: RemoteSessionClient; replica: AgentReplica; transport: RemoteAgentTransport;
  recipient?: ImageDraftRecipient; isCurrent(): boolean;
}

export function useSessionView({ agentId, transport, source, cachedReplica, pending = false, enabled = true }: {
  agentId: string; transport: RemoteAgentTransport; source?: SessionConnectionSource; cachedReplica?: AgentReplica; pending?: boolean; enabled?: boolean;
}) {
  const connections = useMemo<SessionConnectionSource>(() => source ?? { acquire(id, replica) {
    const client = new RemoteSessionClient(id, transport, replica, { historyPageSize: 100, requireSessionControl: true, clientKind: 'web' });
    client.start();
    return { client, replica, release: () => client.stop() };
  } }, [source, transport]);
  const [state, setState] = useState<AgentReplicaState | undefined>(() => cachedReplica?.getState().agent ? cachedReplica.getState() : undefined);
  const [observed, setSessionState] = useState<RemoteSessionState>(() => remoteSessionState(cachedReplica?.getState(), 'connecting'));
  const sessionState = enabled ? observed : { ...remoteSessionState(state, 'connecting'), handoff: observed.handoff };
  const status = sessionState.connection;
  const [questions, setQuestions] = useState<Record<string, QuestionDraft>>({});
  const client = useRef<RemoteSessionClient>();
  const acquired = useRef<SessionConnectionLease>();
  const access = useRef({ enabled, pending });
  if (access.current.enabled !== enabled || access.current.pending !== pending) access.current = { enabled, pending };
  const recipient = useRef<ImageDraftRecipient>();
  const selection = useRef({ agentId, connections, cachedReplica });
  selection.current = { agentId, connections, cachedReplica };
  useEffect(() => {
    const lease = connections.acquire(agentId, cachedReplica ?? new AgentReplica());
    const { replica, client: connection } = lease;
    acquired.current = lease;
    let mounted = true;
    client.current = connection;
    setState(replica.getState().agent ? replica.getState() : undefined); setSessionState(remoteSessionState(replica.getState(), 'connecting')); setQuestions({});
    const unsubscribe = replica.subscribe(() => setState(replica.getState()));
    const unsubscribeStatus = connection.subscribeSessionState(value => {
      if (!mounted) return;
      if (value.connection !== 'ready') recipient.current = undefined;
      else if (!recipient.current) {
        const lifetime = {};
        recipient.current = { identity: JSON.stringify([agentId, crypto.randomUUID()]), lifetime,
          isCurrent: () => mounted && client.current === connection && recipient.current?.lifetime === lifetime
            && selection.current.agentId === agentId && selection.current.connections === connections && selection.current.cachedReplica === cachedReplica };
      }
      setSessionState(value);
    });
    return () => {
      mounted = false; unsubscribe(); unsubscribeStatus(); lease.release();
      if (client.current === connection) { client.current = undefined; recipient.current = undefined; }
      if (acquired.current === lease) acquired.current = undefined;
    };
  }, [agentId, connections, cachedReplica]);
  const active = client.current;
  const authority = access.current, lease = acquired.current;
  const viewCurrent = () => !!active && !!lease && client.current === active && acquired.current === lease
    && access.current === authority && authority.enabled && !authority.pending
    && selection.current.agentId === agentId && selection.current.connections === connections && selection.current.cachedReplica === cachedReplica;
  function assertSendAuthority(): void {
    if (!viewCurrent()) throw new Error('The original session view is no longer current.');
  }
  const messageActions: SessionViewActions = {
    deleteMessage: id => active?.deleteMessage(id),
    ...(active && !pending ? {
      sendMessage: async (text, options) => { assertSendAuthority(); await active.sendMessage(text, options); },
      sendMessageContent: async (content, options) => { assertSendAuthority(); await active.sendMessageContent(content, options); },
    } satisfies SessionViewActions : {}),
  };
  const actions: SessionViewActions = active && enabled && status === 'ready' && !pending ? {
    ...messageActions,
    takeControl: options => active.takeControl(options),
    uploadResource: (file, name, uploadId, options) => active.uploadResource(file, name, uploadId, options),
    downloadResource: resourceId => active.downloadResource(resourceId),
    uploadImage: (file, uploadId, options) => active.uploadImage(file, uploadId, options),
    retryMessage: sessionState.operations.send_message.allowed ? async id => { await active.retryMessage(id); } : undefined,
    searchTimeline: (query, options) => active.searchTimeline(query, options),
    loadSearchMatch: (match, options) => active.loadSearchMatch(match, options),
    loadOlder: () => active.loadOlder(), cancel: sessionState.operations.cancel.allowed ? async () => { await active.cancel(); } : undefined,
    setPlanning: sessionState.operations.set_planning.allowed ? async value => { await active.setPlanning(value); } : undefined, setSessionSetting: sessionState.operations.set_session_setting.allowed ? async (id, value) => { await active.setSessionSetting(id, value); } : undefined,
    listCommands: () => active.listCommands(), executeCommand: sessionState.operations.execute_command.allowed ? (id, args) => active.executeCommand(id, args) : undefined,
    respondToInteraction: sessionState.operations.interaction_response.allowed ? async (id, response) => { await active.respondToInteraction(id, response); } : undefined, requestResource: async binding => (await active.requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => active.resolveResource(locator, sourceLocator),
  } : messageActions;
  const sendQueuedInput = active && enabled && sessionState.operations.send_message.allowed && !pending
    ? async (text: string, operationId: string) => { assertSendAuthority(); return active.sendMessage(text, { operationId }); } : undefined;
  const imageRecipient = recipient.current?.isCurrent() ? recipient.current : undefined;
  const operationScope: SessionViewOperationScope | undefined = enabled && !pending && status === 'ready' && active && lease && imageRecipient
    ? { agentId, client: active, replica: lease.replica, transport, recipient: imageRecipient,
      isCurrent: () => viewCurrent() && imageRecipient.isCurrent() }
    : undefined;
  return { state, sessionState, handoff: sessionState.handoff, status, questions, setQuestions, actions, sendQueuedInput, imageRecipient, operationScope };
}
