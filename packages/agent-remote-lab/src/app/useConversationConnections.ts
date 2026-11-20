// Catch-up, replicas, live connections and the refs that follow the attached conversation.
import { SessionHandoffRejectedError, AgentReplica, RemoteSessionClient } from '@orchardworks/agent-client';
import { ConversationConnections } from '../conversation-connections.js';
import { ReplicaCache } from '../replica-cache.js';
import { DraftStore } from '../draft-store.js';
import { useSessionCatchUp } from '../hooks/useSessionCatchUp.js';
import type { TrackedSessionView } from '../tracked-session-views.js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { SessionDirectoryClient } from '../directory-client.js';
import type { LabTransport } from './types.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { AppInputs } from './types.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useConversationConnections(scope: Pick<AppInputs & WorkbenchShellSlice & RequestedSessionSlice, 'accessReadyRef' | 'baseUrl' | 'directory' | 'selectedHost' | 'transport'>) {
  const t = useTranslate();
  const { accessReadyRef, baseUrl, directory, selectedHost, transport } = scope;

  const { value: catchUp, begin: beginCatchUp, focus: focusCatchUp } = useSessionCatchUp();

  useEffect(() => beginCatchUp(), [baseUrl, transport, beginCatchUp]);

  const replicas = useMemo(() => new ReplicaCache(), [baseUrl, transport]);

  /** Earlier-session elements by chain, so a bot's conversation keeps the same element across renders. */
  const earlierConversations = useRef(new Map<string, ReactElement>());

  const earlierDirectory = useRef<(hostId: string) => SessionDirectoryClient>(undefined!);

  earlierDirectory.current = hostId => hostId === selectedHost.id && directory ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);

  const connections = useMemo(() => new ConversationConnections(transport, baseUrl, (agentId, session) => session ? {
    async resumeNative(owner, options) {
      if (!accessReadyRef.current) throw new SessionHandoffRejectedError(t('sessions.relations.accessRestoring'));
      const target = new SessionDirectoryClient(baseUrl, undefined, session.hostId ?? 'local');
      const result = await target.attach(session.providerId, session.nativeSessionId, options.signal, options.checkOnly ? undefined : owner.generation);
      if (result.agentId !== agentId) throw new Error(t('sessions.connections.differentBinding'));
    },
  } : undefined), [baseUrl, transport]);

  useEffect(() => () => connections.clear(), [connections]);

  const replicaFor = useCallback((agentId: string) => {
    return replicas.obtain(agentId);
  }, [replicas]);

  const [uncertainMutation, setUncertainMutation] = useState(false);

  const messageDrafts = useMemo(() => new DraftStore(baseUrl), [baseUrl]);

  const clientRef = useRef<RemoteSessionClient>();

  const primaryBinding = useRef<{ baseUrl: string; transport: LabTransport; agentId: string }>();

  const replicaRef = useRef<AgentReplica>();

  const unsubscribeReplicaRef = useRef<() => void>();

  const transitionRef = useRef(false);

  const navigationGeneration = useRef(0);

  const pendingViewRestore = useRef<{ scope: string; transport: LabTransport; slotId: string; read(): TrackedSessionView | undefined }>();

  const providerRequestGenerationRef = useRef(0);
  return { catchUp, beginCatchUp, focusCatchUp, replicas, earlierConversations, earlierDirectory, connections, replicaFor, uncertainMutation, setUncertainMutation, messageDrafts, clientRef, primaryBinding, replicaRef, unsubscribeReplicaRef, transitionRef, navigationGeneration, pendingViewRestore, providerRequestGenerationRef };
}

export type ConversationConnectionsSlice = ReturnType<typeof useConversationConnections>;
