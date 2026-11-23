// The sidebar: Windows, shortcuts, the sessions panel on compact layouts and the footer.
import { WindowWorkspaces } from '../../features/windows/WindowWorkspaces.js';
import { SupportingRail } from '../../features/windows/SupportingRail.js';
import { SidebarHeader } from '../../kernel/SidebarHeader.js';
import { Menu } from '../../ui/Menu.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function ContextRail({ scope }: { readonly scope: Pick<AppScope, 'askSidebarSlot' | 'closePage' | 'compactLayout' | 'confirmBotRemoval' | 'contextFromSessions' | 'contextVisible' | 'createWindowFromMenu' | 'creatingWindow' | 'desktopContextVisible' | 'dispatchPanels' | 'favorites' | 'menuCurrentBinding' | 'openNewSessionPanel' | 'openPage' | 'pageOpen' | 'sessionPanel' | 'sessionPanelContent' | 'sessionsTriggerRef' | 'setSidebarViewTarget' | 'setWindowOverviewOpen' | 'shortcutSidebarSlot' | 'userScoped' | 'viewTriggerRef' | 'windowActions' | 'windowOverviewAvailable' | 'windowSessionStatus' | 'windowToolbarShown' | 'windowWorkspace'> }) {
  const t = useTranslate();
  const { askSidebarSlot, closePage, compactLayout, confirmBotRemoval, contextFromSessions, contextVisible, createWindowFromMenu, creatingWindow, desktopContextVisible, dispatchPanels, favorites, menuCurrentBinding, openNewSessionPanel, openPage, pageOpen, sessionPanel, sessionPanelContent, sessionsTriggerRef, setSidebarViewTarget, setWindowOverviewOpen, shortcutSidebarSlot, userScoped, viewTriggerRef, windowActions, windowOverviewAvailable, windowSessionStatus, windowToolbarShown, windowWorkspace } = scope;
  return <>
    <SupportingRail
      id="lab-context"
      label={t('navigation.rail.context')}
      className="lab-context-rail"
      compact={compactLayout}
      collapsible
      open={contextVisible}
      triggerRef={compactLayout && contextFromSessions ? sessionsTriggerRef : viewTriggerRef}
      onClose={() => dispatchPanels({ type: 'context.close', focusInPage: false })}
    >
      {!compactLayout ? <SidebarHeader title={t('navigation.windows')} actions={<Menu label={t('common.new')} icon="plus" items={[
        { label: t('navigation.newSession'), onSelect: openNewSessionPanel },
        { label: t('navigation.newWindow'), disabled: creatingWindow, onSelect: createWindowFromMenu },
      ]} />} /> : null}
      {/* View options has a place in the sidebar only while no Window toolbar shows (a desktop Window keeps it at its toolbar's start). */}
      {!compactLayout && !windowToolbarShown ? <div className="lab-rail-heading">
        <div ref={setSidebarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
      </div> : null}
      {compactLayout ? <nav className="lab-session-panel-actions" aria-label={t('navigation.rail.sections')}>
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => dispatchPanels({ type: 'sessionPanel.set', panel: 'list' })}>{t('navigation.sessions')}</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { dispatchPanels({ type: 'sessionPanel.set', panel: 'favorites' }); void favorites.refresh(); }}>{t('navigation.favorites')}</button> : null}
      </nav> : null}
      {compactLayout ? sessionPanelContent : <>
        <div className="lab-sidebar-scroll">
          <section className="lab-sidebar-section">
            <WindowWorkspaces workspace={windowWorkspace} actions={windowActions} current={menuCurrentBinding} active={desktopContextVisible} sessionStatus={windowSessionStatus} onRemoveView={confirmBotRemoval} onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} onNavigate={closePage} placement="sidebar" />
          </section>
          <nav className="lab-sidebar-section lab-sidebar-shortcuts" aria-label={t('navigation.shortcuts')}>
            <h2 className="lab-sidebar-section-title">{t('navigation.shortcuts')}</h2>
            <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'list' ? 'page' : undefined} onClick={() => openPage('list')}>{t('navigation.allSessions')}</button>
            {userScoped ? <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'favorites' ? 'page' : undefined} onClick={() => openPage('favorites')}>{t('navigation.favorites')}</button> : null}
            <div ref={shortcutSidebarSlot} className="lab-movable-slot" />
            <div ref={askSidebarSlot} className="lab-movable-slot" />
          </nav>
        </div>
      </>}
      {compactLayout && sessionPanel !== 'new' ? <footer className="lab-session-panel-footer"><button type="button" onClick={() => dispatchPanels({ type: 'sessionPanel.set', panel: 'new' })}><span aria-hidden="true">＋</span> {t('navigation.newSession')}</button></footer> : null}
    </SupportingRail>
  </>;
}
