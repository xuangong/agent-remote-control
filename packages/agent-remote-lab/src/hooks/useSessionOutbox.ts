import { useEffect, useState } from 'react';
import type { RemoteAgentTransport, SessionOutboxView } from '@orchardworks/agent-remote-web';

/** The account's outbox, shared by every device, while enabled; undefined where the transport has none. */
export function useSessionOutbox(transport: Pick<RemoteAgentTransport, 'watchSessionOutbox'> | undefined, enabled: boolean): SessionOutboxView | undefined {
  const [view, setView] = useState<SessionOutboxView>();
  useEffect(() => {
    if (!enabled || !transport?.watchSessionOutbox) { setView(undefined); return; }
    return transport.watchSessionOutbox(setView);
  }, [transport, enabled]);
  return view;
}
