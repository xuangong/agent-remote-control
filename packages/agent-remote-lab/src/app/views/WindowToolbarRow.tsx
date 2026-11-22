// The Window toolbar.
import { hasBotAppearance } from '@orchardworks/agent-remote-protocol';
import { windowSummary } from '../../features/windows/window-summary.js';
import { WindowToolbar } from '../../shell/WindowToolbar.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function WindowToolbarRow({ scope }: { readonly scope: Pick<AppScope, 'addSessionView' | 'askToolbarSlot' | 'shortcutToolbarSlot' | 'asleepBot' | 'createSessionView' | 'setAgentControlOpen' | 'setDeleteConfirmOpen' | 'setWindowToolbarViewTarget' | 'sharedWindow' | 'windowActions' | 'windowToolbarShown' | 'windowWorkspace'> }) {
  const { addSessionView, askToolbarSlot, shortcutToolbarSlot, asleepBot, createSessionView, setAgentControlOpen, setDeleteConfirmOpen, setWindowToolbarViewTarget, sharedWindow, windowActions, windowToolbarShown, windowWorkspace } = scope;
  const t = useTranslate();
  return <>
        {windowToolbarShown && sharedWindow ? <WindowToolbar windowId={sharedWindow.id} title={sharedWindow.title} summary={windowSummary(sharedWindow.views, viewId => asleepBot({ id: viewId }), t)}
          leading={<div ref={setWindowToolbarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />}
          launchers={<><div ref={shortcutToolbarSlot} className="lab-movable-slot" /><div ref={askToolbarSlot} className="lab-movable-slot" /></>}
          // The title is not disabled while another Window action runs: renaming does not wait for them, and focus returns to the title after a rename.
          readOnly={windowWorkspace.provisional} deleteDisabled={windowActions.busy}
          onRename={title => void windowActions.saveRename(sharedWindow.id, title)}
          onNewView={addSessionView} onOpenSession={createSessionView}
         
          botAppearance={windowWorkspace.group ? hasBotAppearance(windowWorkspace.group) : undefined} onBotAppearance={shown => void windowActions.setBotAppearance(shown)}
          onCopyLink={() => void windowActions.copyLink()} onAgentControl={windowWorkspace.client ? () => setAgentControlOpen(true) : undefined}
          onDelete={() => setDeleteConfirmOpen(true)} /> : null}
  </>;
}
