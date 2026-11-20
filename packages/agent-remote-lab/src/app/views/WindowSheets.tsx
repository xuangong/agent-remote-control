// The Agent control and Delete Window sheets.
import { AgentControl } from '../../components/AgentControl.js';
import { windowCatalog } from '../../hooks/useWindowActions.js';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { Button } from '../../ui/Button.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function WindowSheets({ scope }: { readonly scope: Pick<AppScope, 'agentControlOpen' | 'deleteConfirmOpen' | 'menuCurrentBinding' | 'setAgentControlOpen' | 'setDeleteConfirmOpen' | 'sharedWindow' | 'windowActions' | 'windowMode' | 'windowToolbarShown' | 'windowWorkspace'> }) {
  const { agentControlOpen, deleteConfirmOpen, menuCurrentBinding, setAgentControlOpen, setDeleteConfirmOpen, sharedWindow, windowActions, windowMode, windowToolbarShown, windowWorkspace } = scope;
  const t = useTranslate();
  return <>
    {/* Mounted only while open, so other dialogs on the page stay the only ones there. */}
    {sharedWindow && windowToolbarShown && windowMode && agentControlOpen ? <Sheet open title={t('windows.agentControl')} onClose={() => setAgentControlOpen(false)}>
      <AgentControl client={windowWorkspace.client} windowId={sharedWindow.id} current={menuCurrentBinding} active />
    </Sheet> : null}
    {sharedWindow && windowToolbarShown && windowMode && deleteConfirmOpen ? <Sheet open title={t('windows.delete.title')} onClose={() => setDeleteConfirmOpen(false)}>
      <p className="lab-sheet-message">{t('windows.deleteCurrent.message', { title: sharedWindow.title })}
        {windowCatalog(windowWorkspace).every(window => window.id === sharedWindow.id) ? ` ${t('windows.deleteCurrent.replacement')}` : null}</p>
      <div className="lab-sheet-actions">
        <Button onClick={() => setDeleteConfirmOpen(false)}>{t('common.cancel')}</Button>
        <Button variant="destructive" disabled={windowActions.busy || windowWorkspace.provisional} onClick={() => { setDeleteConfirmOpen(false); void windowActions.deleteCurrent(); }}>{t('windows.delete.action')}</Button>
      </div>
    </Sheet> : null}
  </>;
}
