// The compact layout's session navigation bar.
import { FavoritesMenu } from '../../components/SessionFavorites.js';
import { viewKey } from '../helpers.js';
import type { AppScope } from '../types.js';

export function MobileNavigation({ scope }: { readonly scope: Pick<AppScope, 'addressSession' | 'backgroundInert' | 'compactLayout' | 'contextOpen' | 'directory' | 'familyPath' | 'favorites' | 'focusedFamilyIndex' | 'focusedFamilyWindow' | 'focusedMenuSession' | 'focusedMenuStatus' | 'focusedSessionKey' | 'openContext' | 'openDirectorySession' | 'revealSession' | 'sessionEntries' | 'sessionsTriggerRef' | 'setMobileViewTarget' | 'setScanOpen' | 'sharedWindow' | 'sidebarWindow' | 'tracking' | 'transitioning' | 'userScoped'> }) {
  const { addressSession, backgroundInert, compactLayout, contextOpen, directory, familyPath, favorites, focusedFamilyIndex, focusedFamilyWindow, focusedMenuSession, focusedMenuStatus, focusedSessionKey, openContext, openDirectorySession, revealSession, sessionEntries, sessionsTriggerRef, setMobileViewTarget, setScanOpen, sharedWindow, sidebarWindow, tracking, transitioning, userScoped } = scope;
  return <>
    {compactLayout ? <nav className="lab-mobile-navigation" aria-label="Session navigation" {...backgroundInert}>
      <button ref={sessionsTriggerRef} type="button" aria-label="Open sessions" aria-haspopup="dialog" aria-expanded={contextOpen} aria-controls="lab-context" onClick={() => { openContext(true); }}>Sessions</button>
      <div ref={setMobileViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
      {userScoped ? <FavoritesMenu onScan={directory ? () => setScanOpen(true) : undefined} status={focusedMenuStatus} currentSession={focusedMenuSession} title={focusedMenuSession?.title || (sharedWindow ? 'Select session' : 'Agent Remote')} favorites={favorites} tracking={tracking} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /> : familyPath.length > 1 ? <select className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === focusedFamilyWindow?.agentId)?.status} aria-label="Side path" value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={(event) => { const session = familyPath.find((entry) => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {familyPath.map((session, index) => <option className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === session.agentId)?.status} key={viewKey(session)} value={viewKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
      </select> : <span className="lab-mobile-session-title agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === addressSession?.agentId)?.status}>{addressSession?.title || 'Agent Remote'}</span>}
      {userScoped && familyPath.length > 1 ? <div className="lab-mobile-side-path">
        <span aria-hidden="true">{focusedFamilyIndex === 0 ? 'Root' : `Side ${focusedFamilyIndex}`}</span><span className="lab-mobile-side-chevron" aria-hidden="true">▾</span>
        <select aria-label="Side path" value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={event => { const session = familyPath.find(entry => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
          {familyPath.map((session, index) => <option key={viewKey(session)} value={viewKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
        </select>
      </div> : null}
    </nav> : null}
  </>;
}
