import type { WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { errorWords, type WindowWorkspaceClient } from '@orchardworks/agent-client';
import { useWindowManager } from '../hooks/useWindowManager.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/**
 * Assigns the session that arranges a Window (its manager). The Windows panel's Window options and the Window toolbar
 * both show it; it reads the manager only while active.
 */
export function AgentControl({ client, windowId, current, active }: {
  client: WindowWorkspaceClient | undefined; windowId: string | undefined;
  /** The session of the selected view, which "Use current session" assigns. */
  current?: WindowSessionBinding; active: boolean;
}) {
  const t = useTranslate();
  const manager = useWindowManager(client, windowId, active);
  const intro = t('sessions.agentControl.intro', { command: '\u0000' }).split('\u0000');
  return <>
    {/* The command is code: it stays as typed, in the code face. */}
    <p className="lab-window-note">{intro[0]}<code>agent-remote-controller window</code>{intro[1]}</p>
    {manager.status === 'loading' ? <p role="status">{t('sessions.agentControl.checking')}</p> : manager.status === 'error' ? <p role="alert">{errorWords(manager.error, t, 'sessions.agentControl.failed')} <button type="button" onClick={manager.refresh}>{t('common.retry')}</button></p>
      : <p className="lab-window-note">{t('sessions.agentControl.manager', { name: manager.manager?.title || manager.manager?.nativeSessionId || t('sessions.agentControl.unassigned') })}</p>}
    <div className="lab-window-actions">
      <button type="button" disabled={!current || manager.pending} onClick={() => void manager.assign(current!).catch(() => {})}>{t('sessions.agentControl.useCurrent')}</button>
      <button type="button" disabled={!manager.manager || manager.pending} onClick={() => void manager.assign(null).catch(() => {})}>{t('sessions.agentControl.clear')}</button>
    </div>
    {!current ? <p className="lab-window-note">{t('sessions.agentControl.selectView')}</p> : null}
    {manager.pending ? <p role="status">{t('sessions.agentControl.updating')}</p> : null}
    {manager.error !== undefined && manager.status !== 'error' ? <p role="alert">{errorWords(manager.error, t, 'sessions.agentControl.failed')}</p> : null}
  </>;
}
