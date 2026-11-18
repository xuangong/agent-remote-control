// The All sessions, Favorites, Hosts and Settings page.
import { FavoritesHeading } from '../../components/SessionFavorites.js';
import { Toolbar } from '../../ui/Toolbar.js';
import { IconButton } from '../../ui/IconButton.js';
import { keepsEscape } from '../helpers.js';
import type { AppScope } from '../types.js';

export function SessionsPage({ scope }: { readonly scope: Pick<AppScope, 'closePage' | 'compactLayout' | 'directoryView' | 'favorites' | 'pageOpen' | 'sessionPanel' | 'sessionPanelContent' | 'sessionsPageTitle' | 'sessionsPageTitleRef' | 'setPageActionsTarget' | 'setPageViewTarget' | 'sidebarWindow' | 'userScoped'> }) {
  const { closePage, compactLayout, directoryView, favorites, pageOpen, sessionPanel, sessionPanelContent, sessionsPageTitle, sessionsPageTitleRef, setPageActionsTarget, setPageViewTarget, sidebarWindow, userScoped } = scope;
  return <>
      {!compactLayout ? <section id="lab-sessions-page" className="lab-sessions-page" aria-label={sessionsPageTitle} hidden={!pageOpen}
        onKeyDown={event => {
          // Text fields keep Escape for themselves (a search field clears on Escape); checkboxes, radios and buttons leave the page.
          if (event.key !== 'Escape' || event.defaultPrevented || keepsEscape(event.target as Element)) return;
          event.preventDefault(); closePage();
        }}>
        {/* On the Favorites page the toolbar heading is the Favorites heading, with its loading mark; the panel shows none. */}
        <Toolbar className="lab-sessions-page-toolbar" title={userScoped && sessionPanel === 'favorites' ? <FavoritesHeading loading={favorites.loading} /> : sessionsPageTitle} titleRef={sessionsPageTitleRef} titleFocusable
          leading={<><div ref={setPageViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /><IconButton icon="chevron-left" label="Back to Window" onClick={closePage} /></>}
          trailing={<div ref={setPageActionsTarget} className="lab-page-actions" />} />
        {sessionPanel !== 'settings' && sessionPanel !== 'hosts' ? <div className="lab-session-open-target" role="status">Open in: <strong>{directoryView?.binding?.title ?? (directoryView ? 'Empty session view' : sidebarWindow?.target?.title ?? (sidebarWindow ? 'Empty session view' : 'Main session'))}</strong></div> : null}
        <div className="lab-sessions-page-body">{sessionPanelContent}</div>
      </section> : null}
  </>;
}
