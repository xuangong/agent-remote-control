import { useEffect, useState } from 'react';
import type { RemoteAgentTransport, SessionReadsView } from '@orchardworks/agent-remote-web';

/** The account's read positions, shared by every device, while enabled; undefined where the transport has none. */
export function useSessionReads(transport: Pick<RemoteAgentTransport, 'watchSessionReads'> | undefined, enabled: boolean): SessionReadsView | undefined {
  const [view, setView] = useState<SessionReadsView>();
  useEffect(() => {
    if (!enabled || !transport?.watchSessionReads) { setView(undefined); return; }
    return transport.watchSessionReads(setView);
  }, [transport, enabled]);
  return view;
}
