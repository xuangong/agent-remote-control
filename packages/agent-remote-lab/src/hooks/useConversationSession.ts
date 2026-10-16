import { useContext, useEffect, useMemo, useState } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { useSessionView } from '@orchardworks/agent-remote-web/react';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { WorkspaceReady } from '../workspace-access.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';
import { sessionKey } from '../session-tree.js';

/** Product retention and account policy compose the neutral session consumer. */
export function useConversationSession(session: OpenedSession, transport: RemoteAgentTransport, cachedReplica?: AgentReplica, pending = false, following?: { nativePrefixOnly?: boolean; viewId?: string; externalAttachment?: boolean; sessionIntent?: 'history'; attachmentAvailable?: boolean }) {
  const enabled = useContext(WorkspaceReady);
  const operations = useContext(SessionViewOperationsContext);
  let resolved = session, resolving = false, historical = following?.sessionIntent === 'history';
  try {
    const target = operations?.resolveTarget(session, following);
    if (target) { resolved = { ...session, ...target.target }; historical ||= !!target.historyRoleId; }
  } catch { resolving = true; }
  const targetKey = sessionKey(resolved);
  const [attachment, setAttachment] = useState<{ session: OpenedSession; transport: RemoteAgentTransport; scope: string }>();
  const attached = attachment?.transport === transport && attachment.scope === operations?.storageScope ? attachment.session : undefined;
  const needsAttach = targetKey !== sessionKey(session);
  const current = needsAttach ? attached && sessionKey(attached) === targetKey ? attached : undefined : session;
  useEffect(() => {
    if (!operations || !enabled || resolving || !needsAttach || current || following?.externalAttachment) return;
    const abort = new AbortController();
    const directory = new SessionDirectoryClient(operations.storageScope, undefined, resolved.hostId);
    void directory.attach(resolved.providerId, resolved.nativeSessionId, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      if (value.nativeSessionId !== undefined && value.nativeSessionId !== resolved.nativeSessionId) throw new Error('The Host returned a different native session.');
      setAttachment({ session: { ...resolved, agentId: value.agentId }, transport, scope: operations.storageScope });
    }).catch(() => { /* The unresolved current view remains fenced until replay or explicit recovery retries. */ });
    return () => abort.abort();
  }, [operations?.storageScope, transport, enabled, resolving, targetKey, needsAttach, current?.agentId, following?.externalAttachment]);
  const bound = current ?? session;
  const recoveryScope = useContext(RecoveryScope)?.scope;
  const shared = useContext(ConversationConnectionScope);
  const connections = useMemo(() => shared ?? new ConversationConnections(transport, recoveryScope), [shared, transport, recoveryScope]);
  useEffect(() => () => { if (!shared) connections.clear(); }, [connections, shared]);
  const source = useMemo(() => ({ acquire: (agentId: string, replica: AgentReplica) => connections.acquire(agentId, replica, bound) }), [connections, bound.agentId, bound.hostId, bound.providerId, bound.nativeSessionId]);
  const view = useSessionView({ agentId: bound.agentId, transport, source, cachedReplica: needsAttach ? undefined : cachedReplica, pending: pending || resolving || !current, enabled, connect: following?.attachmentAvailable !== false });
  return { ...view, boundSession: bound, operationBinding: { source: bound, scope: view.operationScope, historical } };
}
