// The Agent control and Delete Window sheets.
import { AgentControl } from '../../components/AgentControl.js';
import { windowCatalog } from '../../hooks/useWindowActions.js';
import { Sheet } from '../../ui/Sheet.js';
import { Button } from '../../ui/Button.js';
import { message } from '../helpers.js';
import type { AppScope } from '../types.js';

export function WindowSheets({ scope }: { readonly scope: Pick<AppScope, 'agentControlOpen' | 'deleteConfirmOpen' | 'menuCurrentBinding' | 'setAgentControlOpen' | 'setDeleteConfirmOpen' | 'sharedWindow' | 'windowActions' | 'windowMode' | 'windowToolbarShown' | 'windowWorkspace'> }) {
  const { agentControlOpen, deleteConfirmOpen, menuCurrentBinding, setAgentControlOpen, setDeleteConfirmOpen, sharedWindow, windowActions, windowMode, windowToolbarShown, windowWorkspace } = scope;
  return <>
    {/* Mounted only while open, so other dialogs on the page stay the only ones there. */}
    {sharedWindow && windowToolbarShown && windowMode && agentControlOpen ? <Sheet open title="Agent control" onClose={() => setAgentControlOpen(false)}>
      <AgentControl client={windowWorkspace.client} windowId={sharedWindow.id} current={menuCurrentBinding} active />
    </Sheet> : null}
    {sharedWindow && windowToolbarShown && windowMode && deleteConfirmOpen ? <Sheet open title="Delete this Window?" onClose={() => setDeleteConfirmOpen(false)}>
      <p className="lab-sheet-message">{`“${sharedWindow.title}” and its layout are deleted. Its agent sessions keep running and stay in All sessions.`}
        {windowCatalog(windowWorkspace).every(window => window.id === sharedWindow.id) ? ' A new empty Window opens in its place.' : null}</p>
      <div className="lab-sheet-actions">
        <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
        <Button variant="destructive" disabled={windowActions.busy || windowWorkspace.provisional} onClick={() => { setDeleteConfirmOpen(false); void windowActions.deleteCurrent(); }}>Delete Window</Button>
      </div>
    </Sheet> : null}
  </>;
}
