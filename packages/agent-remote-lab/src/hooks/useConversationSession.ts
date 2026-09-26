import { useContext, useEffect, useMemo } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { useSessionView } from '@orchardworks/agent-remote-web/react';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { WorkspaceReady } from '../workspace-access.js';
import { RecoveryScope } from '../conversation-recovery.js';
import type { OpenedSession } from '../directory-client.js';

/** Product retention and account policy compose the neutral session consumer. */
export function useConversationSession(session: OpenedSession, transport: RemoteAgentTransport, cachedReplica?: AgentReplica, pending = false) {
  const enabled = useContext(WorkspaceReady);
  const recoveryScope = useContext(RecoveryScope)?.scope;
  const shared = useContext(ConversationConnectionScope);
  const connections = useMemo(() => shared ?? new ConversationConnections(transport, recoveryScope), [shared, transport, recoveryScope]);
  useEffect(() => () => { if (!shared) connections.clear(); }, [connections, shared]);
  const source = useMemo(() => ({ acquire: (agentId: string, replica: AgentReplica) => connections.acquire(agentId, replica, session) }), [connections, session.agentId, session.hostId, session.providerId, session.nativeSessionId]);
  return useSessionView({ agentId: session.agentId, transport, source, cachedReplica, pending, enabled });
}
