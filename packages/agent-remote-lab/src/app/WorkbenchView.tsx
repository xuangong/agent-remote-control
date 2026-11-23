// The Workbench screen: the context providers, the Window-mode shell and the Bot-mode surfaces, composed from the views of the views directory.
import { LiveConnectionsContext } from '../kernel/useLiveBudget.js';
import { WindowSessionBridgeContext } from '../kernel/window-session-bridge-context.js';
import { SharedDraftsContext } from '../conversation/useSharedDraft.js';
import { SessionConversationSurfaces } from '../conversation/SessionConversationSurfaces.js';
import { WindowLayoutContext, WindowPresentationContext } from '../kernel/window-workspace-context.js';
import { SharedFeedsContext } from '../kernel/shared-feeds.js';
import { SessionViewOperationsContext } from '../conversation/session-view-operations.js';
import { SessionDescriptionsContext } from '../kernel/session-description-context.js';
import { AskViewScope } from '../kernel/useAskVisibility.js';
import { ConversationConnectionScope } from '../conversation/conversation-connections.js';
import { TrackViewScope } from '../kernel/useSessionAttention.js';
import { TpmViewScope } from '../kernel/useTpmVisibility.js';
import { ToastActivity } from '../kernel/Toast.js';
import { useCallback, useMemo, type ReactNode } from 'react';
import { taskDirectory } from '../features/tasks/task-directory.js';
import { RemoteTeamClient } from '@orchardworks/agent-client';
import { workspaceFetch } from '../kernel/workspace-access.js';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { RecoveryScope } from '../kernel/conversation-recovery.js';
import type { RemoteHost } from '../kernel/remote-host.js';
import { PreviewProvider, PreviewWorkspace, SessionExcerptNavigation, TaskDirectoryContext } from '@orchardworks/agent-client-web/react';
import { SessionDockProvider } from '../kernel/SessionDock.js';
import { SidebarResize } from '../features/windows/SidebarResize.js';
import { VscodeTunnelScope } from '../kernel/vscode-tunnel.js';
import { CommandPalette } from '../shell/CommandPalette.js';
import { ShortcutsSheet } from '../shell/ShortcutsSheet.js';
import type { AppScope } from './types.js';
import { WindowRecovery } from './views/WindowRecovery.js';
import { WindowMenus } from './views/WindowMenus.js';
import { AskWorkspaces } from './views/AskWorkspaces.js';
import { TpmWorkspaces } from './views/TpmWorkspaces.js';
import { MobileNavigation } from './views/MobileNavigation.js';
import { NavigationChrome } from './views/NavigationChrome.js';
import { PageSurface } from './views/PageSurface.js';
import { usePhoneLayout } from '../kernel/usePhoneLayout.js';
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
import { AssistantNamesContext } from '../kernel/names-context.js';
import { DesktopFrame, useDetailsBeside } from '../shell/DesktopFrame.js';
import { shownAssistantName } from '../kernel/window-title.js';

/** Window mode's inspector column (app.css), which its stage keeps beside it. */
const WINDOW_INSPECTOR_WIDTH = 320;

export function WorkbenchView({ scope }: { readonly scope: AppScope }) {
  const { assistantNames, activated, activeAgentId, activeOpened, activeView, askView, attention, backgroundInert, baseUrl, commandItems, compactLayout, connections, contextOpen, contextVisible, desktopContextVisible, focusManagedWindow, headerHidden, inspectorOpen, liveConnections, nativeTakeover, navigation, openExcerptSource, pageOpen, presentedPrimaryViewId, presentedViewId, previewClient, previewHost, promptMigrations, readingPositions, searchOpen, sessionDescriptions, sessionNotice, sessionViewOperations, setSearchOpen, setShortcutsOpen, sharedDrafts, sharedFeeds, sharedWindow, shellRef, shortcutsOpen, sidebar, state, supportingRailOpen, tpmView, tracking, transport, userScoped, vscodeTunnelClient, windowMode, windowPageTitle, windowWorkspace, workbenchPanelRef , teamRoster , openSession , updateTaskRoster } = scope;
  const phone = usePhoneLayout();
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [setShortcutsOpen]);
  const pageShown = !!navigation.page;
  const detailsBeside = useDetailsBeside(phone);
  const tasks = teamRoster?.baseUrl === baseUrl ? teamRoster.tasks : undefined;
  const taskClient = useMemo(() => new RemoteTeamClient(baseUrl, workspaceFetch), [baseUrl]);
  const tasksDirectory = useMemo(() => taskDirectory(tasks, worker => void openSession(worker, undefined, undefined, false, undefined, undefined, undefined, undefined, compactLayout ? 'primary' : undefined),
    async (taskId, action) => { const team = await taskClient.action({ teamId: taskId, action }); updateTaskRoster(baseUrl, [...(tasks ?? []).filter(item => item.id !== team.id), team]); }, windowWorkspace.groups),
    [tasks, openSession, compactLayout, taskClient, updateTaskRoster, baseUrl, windowWorkspace.groups]);
  return <TaskDirectoryContext.Provider value={tasksDirectory}><AssistantNamesContext.Provider value={assistantNames}><SharedFeedsContext.Provider value={sharedFeeds}><SharedDraftsContext.Provider value={sharedDrafts}><LiveConnectionsContext.Provider value={liveConnections.stable}><SessionDescriptionsContext.Provider value={sessionDescriptions}><SessionExcerptNavigation.Provider value={openExcerptSource}><SessionViewOperationsContext.Provider value={sessionViewOperations}><AskViewScope.Provider value={askView.execute}><WindowSessionBridgeContext.Provider value={windowWorkspace.sessionBridge}><WindowLayoutContext.Provider value={windowWorkspace.authority}><SessionDockProvider key={baseUrl} storageScope={baseUrl} enabled={windowMode && !compactLayout && activeView === 'workbench'}><TpmViewScope.Provider value={tpmView.execute}><TrackViewScope.Provider value={userScoped ? attention.executeTrack : undefined}><ConversationConnectionScope.Provider value={connections}><VscodeTunnelScope service={vscodeTunnelClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><PreviewScope client={previewClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><RecoveryScope.Provider value={readingPositions}><SessionConversationSurfaces scope={baseUrl} transport={transport} mode={navigation.mode}>{/* The frame sizes the rail and Bot mode's panels, leaving Window mode's own sidebar and inspector the room they take; the window's
     title names the assistant on screen, or Window mode's own title. */}
  <DesktopFrame surface={pageShown ? 'page' : windowMode ? 'window' : 'bot'} phone={phone}
    windowBeside={compactLayout ? 0 : (desktopContextVisible ? sidebar.width : 0) + (inspectorOpen ? WINDOW_INSPECTOR_WIDTH : 0)}
    title={windowMode ? windowPageTitle : shownAssistantName(navigation.place, !phone || !navigation.rosterVisible, assistantNames)}><NavigationChrome scope={scope} /><ToastActivity.Provider value={windowMode}><main hidden={!windowMode || pageShown} {...(!windowMode || pageShown ? { inert: '' } : {})} data-workbench-mode="window" ref={shellRef} onPointerDownCapture={focusManagedWindow} onFocusCapture={focusManagedWindow} style={sidebar.style} className={`lab-shell lab-window-mode${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
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
    <BotModeSurfaces scope={scope} detailsBeside={detailsBeside} />
    <PageSurface scope={scope} />
    </DesktopFrame>
    {/* Mounted only while open (it closes its modal as it unmounts, returning focus), so a closed palette adds no dialog to the page. */}
    {searchOpen ? <CommandPalette open items={commandItems()} onClose={() => setSearchOpen(false)} /> : null}
    {shortcutsOpen ? <ShortcutsSheet windowMode={windowMode} onClose={closeShortcuts} /> : null}
  </SessionConversationSurfaces></RecoveryScope.Provider></PreviewScope></VscodeTunnelScope></ConversationConnectionScope.Provider></TrackViewScope.Provider></TpmViewScope.Provider></SessionDockProvider></WindowLayoutContext.Provider></WindowSessionBridgeContext.Provider></AskViewScope.Provider></SessionViewOperationsContext.Provider></SessionExcerptNavigation.Provider></SessionDescriptionsContext.Provider></LiveConnectionsContext.Provider></SharedDraftsContext.Provider></SharedFeedsContext.Provider></AssistantNamesContext.Provider></TaskDirectoryContext.Provider>;
}

function PreviewScope({ client, host, polling, children }: { readonly client: HttpPreviewClient; readonly host?: RemoteHost; readonly polling: boolean; readonly children: ReactNode }) {
  const enabled = !!host && host.access !== 'shared';
  return <PreviewProvider client={client} hostId={host?.id ?? ''} enabled={enabled} canManage={enabled} polling={polling}>{children}</PreviewProvider>;
}
