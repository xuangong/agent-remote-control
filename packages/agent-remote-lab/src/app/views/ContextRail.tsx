// The sidebar: Windows, shortcuts, the sessions panel on compact layouts and the footer.
import { WindowWorkspaces } from '../../components/WindowWorkspaces.js';
import { SupportingRail } from '../../components/SupportingRail.js';
import { SidebarHeader } from '../../shell/SidebarHeader.js';
import { Menu } from '../../ui/Menu.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function ContextRail({ scope }: { readonly scope: Pick<AppScope, 'askSidebarSlot' | 'closePage' | 'compactLayout' | 'confirmBotRemoval' | 'contextFromSessions' | 'contextVisible' | 'createWindowFromMenu' | 'creatingWindow' | 'desktopContextVisible' | 'dispatchPanels' | 'favorites' | 'menuCurrentBinding' | 'openNewSessionPanel' | 'openPage' | 'pageOpen' | 'sessionPanel' | 'sessionPanelContent' | 'sessionsTriggerRef' | 'setSidebarViewTarget' | 'setWindowOverviewOpen' | 'shortcutSidebarSlot' | 'supportTeams' | 'userScoped' | 'viewTriggerRef' | 'windowActions' | 'windowOverviewAvailable' | 'windowSessionStatus' | 'windowToolbarShown' | 'windowWorkspace'> }) {
  const t = useTranslate();
  const { askSidebarSlot, closePage, compactLayout, confirmBotRemoval, contextFromSessions, contextVisible, createWindowFromMenu, creatingWindow, desktopContextVisible, dispatchPanels, favorites, menuCurrentBinding, openNewSessionPanel, openPage, pageOpen, sessionPanel, sessionPanelContent, sessionsTriggerRef, setSidebarViewTarget, setWindowOverviewOpen, shortcutSidebarSlot, supportTeams, userScoped, viewTriggerRef, windowActions, windowOverviewAvailable, windowSessionStatus, windowToolbarShown, windowWorkspace } = scope;
  return <>
    <SupportingRail
      id="lab-context"
      label="Context"
      className="lab-context-rail"
      compact={compactLayout}
      collapsible
      open={contextVisible}
      triggerRef={compactLayout && contextFromSessions ? sessionsTriggerRef : viewTriggerRef}
      onClose={() => dispatchPanels({ type: 'context.close', focusInPage: false })}
    >
      {!compactLayout ? <SidebarHeader title={t('navigation.windows')} actions={<Menu label="New" icon="plus" items={[
        { label: 'New session', onSelect: openNewSessionPanel },
        { label: 'New Window', disabled: creatingWindow, onSelect: createWindowFromMenu },
      ]} />} /> : null}
      {/* View options has a place in the sidebar only while no Window toolbar shows (a desktop Window keeps it at its toolbar's start). */}
      {!compactLayout && !windowToolbarShown ? <div className="lab-rail-heading">
        <div ref={setSidebarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
      </div> : null}
      {compactLayout ? <nav className="lab-session-panel-actions" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => dispatchPanels({ type: 'sessionPanel.set', panel: 'list' })}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { dispatchPanels({ type: 'sessionPanel.set', panel: 'favorites' }); void favorites.refresh(); }}>Favorites</button> : null}
      </nav> : null}
      {compactLayout ? sessionPanelContent : <>
        <div className="lab-sidebar-scroll">
          <section className="lab-sidebar-section">
            <WindowWorkspaces workspace={windowWorkspace} actions={windowActions} current={menuCurrentBinding} active={desktopContextVisible} sessionStatus={windowSessionStatus} onRemoveView={confirmBotRemoval}
              supportTeam={teamId => supportTeams.has(teamId)} onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} onNavigate={closePage} placement="sidebar" />
          </section>
          <nav className="lab-sidebar-section lab-sidebar-shortcuts" aria-label="Shortcuts">
            <h2 className="lab-sidebar-section-title">Shortcuts</h2>
            <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'list' ? 'page' : undefined} onClick={() => openPage('list')}>All sessions</button>
            {userScoped ? <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'favorites' ? 'page' : undefined} onClick={() => openPage('favorites')}>Favorites</button> : null}
            <div ref={shortcutSidebarSlot} className="lab-movable-slot" />
            <div ref={askSidebarSlot} className="lab-movable-slot" />
          </nav>
        </div>
      </>}
      {compactLayout && sessionPanel !== 'new' ? <footer className="lab-session-panel-footer"><button type="button" onClick={() => dispatchPanels({ type: 'sessionPanel.set', panel: 'new' })}><span aria-hidden="true">＋</span> New session</button></footer> : null}
    </SupportingRail>
  </>;
}
