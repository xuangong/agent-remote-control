import { useEffect, useState } from 'react';
import type { RemoteAgentTransport, SessionStatesView } from '@orchardworks/agent-remote-web';

/** The session states the Relay shares, while enabled; undefined where the transport cannot watch them. */
export function useSessionStates(transport: Pick<RemoteAgentTransport, 'watchSessionStates'> | undefined, enabled: boolean): SessionStatesView | undefined {
  const [view, setView] = useState<SessionStatesView>();
  useEffect(() => {
    if (!enabled || !transport?.watchSessionStates) { setView(undefined); return; }
    return transport.watchSessionStates(setView);
  }, [transport, enabled]);
  return view;
}
