import { useState, type ReactNode } from 'react';
import type { AgentReplicaState, RemoteSessionState } from '@orchardworks/agent-client';
import { AgentSessionSettings, type SessionControlView } from '@orchardworks/agent-client-web/react';

/**
 * The assistant's model and settings in its details: the session's model, permissions and status (with planning and usage),
 * moved out of the composer so it holds only the message.
 */
export function ModelSettings({ state, sessionState, readOnly, onSelect, renderError, planning }: {
  state: AgentReplicaState; sessionState: RemoteSessionState; readOnly: boolean;
  onSelect?(id: string, value: string): Promise<void>; renderError?(error: unknown): ReactNode; planning?: ReactNode;
}) {
  const [view, setView] = useState<SessionControlView>();
  const [busy, setBusy] = useState(false);
  return <AgentSessionSettings state={state} sessionState={sessionState} disabled={false} readOnly={readOnly} view={view} busy={busy}
    onView={setView} onPendingChange={setBusy} {...(onSelect ? { onSelect } : {})} {...(renderError ? { renderError } : {})}>{planning}</AgentSessionSettings>;
}
