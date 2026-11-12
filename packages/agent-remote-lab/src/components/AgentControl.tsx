import type { WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { useWindowManager } from '../hooks/useWindowManager.js';

/**
 * Assigns the session that arranges a Window (its manager). The Windows panel's Window options and the Window toolbar
 * both show it; it reads the manager only while active.
 */
export function AgentControl({ client, windowId, current, active }: {
  client: WindowWorkspaceClient | undefined; windowId: string | undefined;
  /** The session of the selected view, which "Use current session" assigns. */
  current?: WindowSessionBinding; active: boolean;
}) {
  const manager = useWindowManager(client, windowId, active);
  return <>
    <p className="lab-window-note">Name the session that arranges this Window. Agents arrange Windows with agent-remote-controller window, signed in as you.</p>
    {manager.status === 'loading' ? <p role="status">Checking manager…</p> : manager.status === 'error' ? <p role="alert">{manager.error} <button type="button" onClick={manager.refresh}>Retry</button></p>
      : <p className="lab-window-note">Manager: {manager.manager?.title || manager.manager?.nativeSessionId || 'Unassigned'}</p>}
    <div className="lab-window-actions">
      <button type="button" disabled={!current || manager.pending} onClick={() => void manager.assign(current!).catch(() => {})}>Use current session</button>
      <button type="button" disabled={!manager.manager || manager.pending} onClick={() => void manager.assign(null).catch(() => {})}>Clear manager</button>
    </div>
    {!current ? <p className="lab-window-note">Select a bound session view to assign its Agent.</p> : null}
    {manager.pending ? <p role="status">Updating manager…</p> : null}
    {manager.error && manager.status !== 'error' ? <p role="alert">{manager.error}</p> : null}
  </>;
}
