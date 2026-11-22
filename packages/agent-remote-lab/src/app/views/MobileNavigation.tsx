// The compact layout's session navigation bar.
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { FavoritesMenu } from '../../features/sessions/SessionFavorites.js';
import { viewKey } from '../helpers.js';
import type { AppScope } from '../types.js';

export function MobileNavigation({ scope }: { readonly scope: Pick<AppScope, 'addressSession' | 'askBarSlot' | 'backgroundInert' | 'compactLayout' | 'contextOpen' | 'directory' | 'familyPath' | 'favorites' | 'focusedFamilyIndex' | 'focusedFamilyWindow' | 'focusedMenuSession' | 'focusedMenuStatus' | 'focusedSessionKey' | 'openContext' | 'openDirectorySession' | 'revealSession' | 'sessionEntries' | 'sessionsTriggerRef' | 'setMobileViewTarget' | 'setScanOpen' | 'sharedWindow' | 'shortcutBarSlot' | 'sidebarWindow' | 'tracking' | 'transitioning' | 'userScoped'> }) {
  const { addressSession, askBarSlot, backgroundInert, compactLayout, contextOpen, directory, familyPath, favorites, focusedFamilyIndex, focusedFamilyWindow, focusedMenuSession, focusedMenuStatus, focusedSessionKey, openContext, openDirectorySession, revealSession, sessionEntries, sessionsTriggerRef, setMobileViewTarget, setScanOpen, sharedWindow, shortcutBarSlot, sidebarWindow, tracking, transitioning, userScoped } = scope;
  const t = useTranslate();
  const sideLabel = (index: number) => index === 0 ? t('navigation.mobile.root') : t('navigation.mobile.side', { index });
  return <>
    {compactLayout ? <nav className="lab-mobile-navigation" aria-label={t('navigation.mobile.navigation')} {...backgroundInert}>
      <button ref={sessionsTriggerRef} type="button" aria-label={t('navigation.mobile.openSessions')} aria-haspopup="dialog" aria-expanded={contextOpen} aria-controls="lab-context" onClick={() => { openContext(true); }}>{t('navigation.sessions')}</button>
      <div ref={setMobileViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
      {userScoped ? <FavoritesMenu onScan={directory ? () => setScanOpen(true) : undefined} status={focusedMenuStatus} currentSession={focusedMenuSession} title={focusedMenuSession?.title || (sharedWindow ? t('navigation.mobile.selectSession') : 'Orchard')} favorites={favorites} tracking={tracking} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /> : familyPath.length > 1 ? <select className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === focusedFamilyWindow?.agentId)?.status} aria-label={t('navigation.mobile.sidePath')} value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={(event) => { const session = familyPath.find((entry) => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {familyPath.map((session, index) => <option className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === session.agentId)?.status} key={viewKey(session)} value={viewKey(session)}>{sideLabel(index)} · {session.title}</option>)}
      </select> : <span className="lab-mobile-session-title agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === addressSession?.agentId)?.status}>{addressSession?.title || 'Orchard'}</span>}
      {userScoped && familyPath.length > 1 ? <div className="lab-mobile-side-path">
        <span aria-hidden="true">{sideLabel(focusedFamilyIndex)}</span><span className="lab-mobile-side-chevron" aria-hidden="true">▾</span>
        <select aria-label={t('navigation.mobile.sidePath')} value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={event => { const session = familyPath.find(entry => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
          {familyPath.map((session, index) => <option key={viewKey(session)} value={viewKey(session)}>{sideLabel(index)} · {session.title}</option>)}
        </select>
      </div> : null}
      {/* A row of the navigation, so the entries take their own space and never cover the conversation. */}
      <div className="lab-launcher-bar" role="group" aria-label={t('navigation.shortcuts')}>
        <div ref={shortcutBarSlot} className="lab-movable-slot" />
        <div ref={askBarSlot} className="lab-movable-slot" />
      </div>
    </nav> : null}
  </>;
}
