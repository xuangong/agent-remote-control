// The Workbench screen: the context providers, the Window-mode shell and the Bot-mode surfaces, composed from the views of the views directory.
import { LiveConnectionsContext } from '../hooks/useLiveBudget.js';
import { WindowSessionBridgeContext } from '../window-session-bridge-context.js';
import { SharedDraftsContext } from '../hooks/useSharedDraft.js';
import { SessionConversationSurfaces } from '../components/SessionConversationSurfaces.js';
import { WindowLayoutContext, WindowPresentationContext } from '../window-workspace-context.js';
import { SharedFeedsContext } from '../shared-feeds.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';
import { SessionDescriptionsContext } from '../session-description-context.js';
import { TeamViewScope } from '../hooks/useTeamVisibility.js';
import { AskViewScope } from '../hooks/useAskVisibility.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { TrackViewScope } from '../hooks/useSessionAttention.js';
import { TpmViewScope } from '../hooks/useTpmVisibility.js';
import { ToastActivity } from '../components/Toast.js';
import type { ReactNode } from 'react';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { RecoveryScope } from '../conversation-recovery.js';
import type { RemoteHost } from '../kernel/remote-host.js';
import { PreviewProvider, PreviewWorkspace, SessionExcerptNavigation } from '@orchardworks/agent-client-web/react';
import { SessionDockProvider } from '../components/SessionDock.js';
import { SidebarResize } from '../components/SidebarResize.js';
import { VscodeTunnelScope } from '../vscode-tunnel.js';
import { CommandPalette } from '../shell/CommandPalette.js';
import type { AppScope } from './types.js';
import { WindowRecovery } from './views/WindowRecovery.js';
import { WindowMenus } from './views/WindowMenus.js';
import { AskWorkspaces } from './views/AskWorkspaces.js';
import { TpmWorkspaces } from './views/TpmWorkspaces.js';
import { MobileNavigation } from './views/MobileNavigation.js';
import { NavigationChrome } from './views/NavigationChrome.js';
import { PageSurface } from './views/PageSurface.js';
import { usePhoneLayout } from '../hooks/usePhoneLayout.js';
import { GlobalViewOptions } from './views/GlobalViewOptions.js';
import { AppBar } from './views/AppBar.js';
import { ContextRail } from './views/ContextRail.js';
import { ShortcutSlots } from './views/ShortcutSlots.js';
import { SessionsPage } from './views/SessionsPage.js';
import { WindowToolbarRow } from './views/WindowToolbarRow.js';
import { SessionWindows } from './views/SessionWindows.js';
import { EmptyWindow } from './views/EmptyWindow.js';
import { WorkspaceNotices } from './views/WorkspaceNotices.js';
import { SessionDocks } from './views/SessionDocks.js';
import { TraceSection } from './views/TraceSection.js';
import { SessionDialogs } from './views/SessionDialogs.js';
import { InspectorRail } from './views/InspectorRail.js';
import { WindowSheets } from './views/WindowSheets.js';
import { BotModeSurfaces } from './views/BotModeSurfaces.js';
import { AssistantNamesContext } from '../components/assistant/names-context.js';
export function WorkbenchView({ scope }: { readonly scope: AppScope }) {
  const { assistantNames, activated, activeAgentId, activeOpened, activeView, askView, attention, backgroundInert, baseUrl, commandItems, compactLayout, connections, contextOpen, contextVisible, desktopContextVisible, focusManagedWindow, headerHidden, inspectorOpen, liveConnections, nativeTakeover, navigation, openExcerptSource, pageOpen, presentedPrimaryViewId, presentedViewId, previewClient, previewHost, promptMigrations, readingPositions, searchOpen, sessionDescriptions, sessionNotice, sessionViewOperations, setSearchOpen, sharedDrafts, sharedFeeds, sharedWindow, shellRef, sidebar, state, supportingRailOpen, teamView, tpmView, tracking, transport, userScoped, vscodeTunnelClient, windowMode, windowWorkspace, workbenchPanelRef } = scope;
  const phone = usePhoneLayout();
  const pageShown = !!navigation.page;
  return <AssistantNamesContext.Provider value={assistantNames}><SharedFeedsContext.Provider value={sharedFeeds}><SharedDraftsContext.Provider value={sharedDrafts}><LiveConnectionsContext.Provider value={liveConnections.stable}><SessionDescriptionsContext.Provider value={sessionDescriptions}><SessionExcerptNavigation.Provider value={openExcerptSource}><SessionViewOperationsContext.Provider value={sessionViewOperations}><AskViewScope.Provider value={askView.execute}><WindowSessionBridgeContext.Provider value={windowWorkspace.sessionBridge}><WindowLayoutContext.Provider value={windowWorkspace.authority}><SessionDockProvider key={baseUrl} storageScope={baseUrl} enabled={windowMode && !compactLayout && activeView === 'workbench'}><TeamViewScope.Provider value={teamView.execute}><TpmViewScope.Provider value={tpmView.execute}><TrackViewScope.Provider value={userScoped ? attention.executeTrack : undefined}><ConversationConnectionScope.Provider value={connections}><VscodeTunnelScope service={vscodeTunnelClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><PreviewScope client={previewClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><RecoveryScope.Provider value={readingPositions}><SessionConversationSurfaces scope={baseUrl} transport={transport} mode={navigation.mode}><div className="lab-frame" data-rail={!phone || undefined} data-tab-bar={phone || undefined}><NavigationChrome scope={scope} /><ToastActivity.Provider value={windowMode}><main hidden={!windowMode || pageShown} {...(!windowMode || pageShown ? { inert: '' } : {})} data-workbench-mode="window" ref={shellRef} onPointerDownCapture={focusManagedWindow} onFocusCapture={focusManagedWindow} style={sidebar.style} className={`lab-shell lab-window-mode${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    <WindowRecovery scope={scope} />
    {activated ? tracking.observers : null}
    {!windowWorkspace.unavailable ? <>
    <WindowMenus scope={scope} />
    <AskWorkspaces scope={scope} />
    <WindowPresentationContext.Provider value={presentedViewId}>
    <TpmWorkspaces scope={scope} />
    <MobileNavigation scope={scope} />
    <GlobalViewOptions scope={scope} />
    <AppBar scope={scope} />
    <ContextRail scope={scope} />
    <ShortcutSlots scope={scope} />
    {!compactLayout && contextVisible ? <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} /> : null}
    <PreviewWorkspace resourceScope={JSON.stringify([activeOpened?.hostId, activeAgentId])} className="lab-main-stage" {...backgroundInert}>
      <SessionsPage scope={scope} />
      <section
        ref={workbenchPanelRef}
        className={sharedWindow ? 'lab-window-workbench' : (sessionNotice && !nativeTakeover && !(compactLayout && contextOpen)) || promptMigrations.notice ? 'lab-workbench-with-notice' : undefined}
        id="lab-workbench"
        data-testid="workbench"
        data-window-provisional={windowWorkspace.provisional || undefined}
        aria-busy={windowWorkspace.provisional || undefined}
        role="tabpanel"
        aria-labelledby="lab-workbench-tab"
        tabIndex={-1}
        hidden={activeView !== 'workbench' || pageOpen}
      >
        <WindowToolbarRow scope={scope} />
        <SessionWindows scope={scope} />
        <EmptyWindow scope={scope} />
        {/* While the address names a Window that is still opening, the ordinary workspace waits rather than saying it is empty. */}
        <div className="lab-ordinary-workspace" hidden={!!sharedWindow && (!sharedWindow.views.length || compactLayout && !presentedPrimaryViewId)
          || !sharedWindow && windowMode && !windowWorkspace.unavailable && typeof location !== 'undefined' && new URLSearchParams(location.search).has('window')}>
        <WorkspaceNotices scope={scope} />
        <SessionDocks scope={scope} />
      </div>
      </section>
      <TraceSection scope={scope} />
    </PreviewWorkspace>
    <SessionDialogs scope={scope} />
    <InspectorRail scope={scope} />
    </WindowPresentationContext.Provider>
    </> : null}
    <WindowSheets scope={scope} />
  </main></ToastActivity.Provider>
    <BotModeSurfaces scope={scope} />
    <PageSurface scope={scope} />
    </div>
    {/* Mounted only while open (it closes its modal as it unmounts, returning focus), so a closed palette adds no dialog to the page. */}
    {searchOpen ? <CommandPalette open items={commandItems()} onClose={() => setSearchOpen(false)} /> : null}
  </SessionConversationSurfaces></RecoveryScope.Provider></PreviewScope></VscodeTunnelScope></ConversationConnectionScope.Provider></TrackViewScope.Provider></TpmViewScope.Provider></TeamViewScope.Provider></SessionDockProvider></WindowLayoutContext.Provider></WindowSessionBridgeContext.Provider></AskViewScope.Provider></SessionViewOperationsContext.Provider></SessionExcerptNavigation.Provider></SessionDescriptionsContext.Provider></LiveConnectionsContext.Provider></SharedDraftsContext.Provider></SharedFeedsContext.Provider></AssistantNamesContext.Provider>;
}

function PreviewScope({ client, host, polling, children }: { readonly client: HttpPreviewClient; readonly host?: RemoteHost; readonly polling: boolean; readonly children: ReactNode }) {
  const enabled = !!host && host.access !== 'shared';
  return <PreviewProvider client={client} hostId={host?.id ?? ''} enabled={enabled} canManage={enabled} polling={polling}>{children}</PreviewProvider>;
}
