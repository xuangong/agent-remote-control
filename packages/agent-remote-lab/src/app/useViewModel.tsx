// View descriptions, shortcuts, panel content and the operations contexts.
import { requestedHostUnavailableReason } from '../features/sessions/creation-choice.js';
import { paneFolding } from '../features/windows/pane-folding.js';
import { hasBotAppearance, type WindowView, type Team, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../kernel/window-workspace.js';
import type { BotPlace } from '../kernel/workbench-mode.js';
import { windowBindingKey } from '../kernel/window-composition.js';
import type { BotInfo } from '../features/chats/BotActions.js';
import type { SessionSurfaceDescriptor } from '../conversation/SessionConversationSurfaces.js';
import { teamViewTarget } from '../features/team/team-view-binding.js';
import { SessionViewOperationsContext } from '../conversation/session-view-operations.js';
import { SessionDescriptionsContext } from '../kernel/session-description-context.js';
import { describeSession } from '../kernel/session-description.js';
import { labSessionSuccessionDirectory } from '../kernel/session-succession-directory.js';
import { TeamMenu } from '../features/team/TeamMenu.js';
import { AskButton } from '../features/team/AskButton.js';
import { CachePrivacySettings } from '../features/settings/CachePrivacySettings.js';
import { LayoutDiagnosticsSettings } from '../features/settings/LayoutDiagnosticsSettings.js';
import { ControllerUpdates } from '../features/computers/ControllerUpdates.js';
import { TpmMenu } from '../features/team/TpmMenu.js';
import { FavoritesHeading, FavoritesList } from '../features/sessions/SessionFavorites.js';
import { SessionTrackingMenu } from '../features/sessions/SessionTrackingMenu.js';
import { SessionConnectionNotice } from '../kernel/SessionConnectionNotice.js';
import { MobileDisplaySettings } from '../features/settings/MobileDisplaySettings.js';
import { useMemo, useRef, type ContextType } from 'react';
import { keyedError } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { HostPairing } from '../features/computers/HostPairing.js';
import { HostOverview } from '../features/computers/HostOverview.js';
import { SessionDirectoryClient, type OpenedSession } from '../kernel/directory-client.js';
import { SessionConfiguration, SessionDirectory } from '../features/sessions/SessionDirectory.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { FoldedBot } from '../kernel/SessionDock.js';
import { ProviderSessionControls } from '../features/sessions/ProviderSessionControls.js';
import { RecordedPlaybackControls } from '../features/diagnostics/RecordedPlaybackControls.js';
import { HostPreviewGroups } from '../features/computers/HostPreviewGroups.js';
import { HostVscodeTunnel } from '../features/computers/HostVscodeTunnel.js';
import { VscodeTunnelScope } from '../kernel/vscode-tunnel.js';
import { viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SessionViewPresentationSlice } from './useSessionViewPresentation.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SendingAndSuccessionSlice } from './useSendingAndSuccession.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { AppInputs } from './types.js';

export function useViewModel(scope: Pick<AppInputs & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ProviderStateSlice & SessionViewPresentationSlice & WorkbenchRecordsSlice & RemoteHostStateSlice & DocksAndBotSelectionSlice & WorkbenchShellSlice & ConversationConnectionsSlice & RequestedSessionSlice & ViewSessionStateSlice & SendingAndSuccessionSlice & ActiveSessionSlice & AttentionAndRosterSlice & SharedFeedsAndTpmSlice & HostAndStackSlice & FocusedAskSlice & SessionOpeningSlice & ViewTargetsSlice & WindowViewActionsSlice & ProviderCreationSlice & SideSelectionSlice & WindowModeActionsSlice, 'accessReady' | 'activated' | 'activeOpened' | 'activeRemoteSession' | 'ask' | 'askSurfaceVisible' | 'askTriggerRef' | 'attention' | 'baseUrl' | 'botPresentation' | 'canOpenFocusedAsk' | 'catalogError' | 'catalogStatus' | 'catchUp' | 'clientActions' | 'closeInspector' | 'closeView' | 'compactLayout' | 'contextOpen' | 'createAgent' | 'createPlanning' | 'creationFacts' | 'creationLocked' | 'creationUnavailableReason' | 'currentGroupBinding' | 'currentSession' | 'desktopContextVisible' | 'directory' | 'directoryRevision' | 'directoryView' | 'dispatchPanels' | 'draftOwnerBinding' | 'failure' | 'favorites' | 'featureSource' | 'focusedAskEntry' | 'focusedAskSession' | 'focusedAskState' | 'focusedAskUnavailable' | 'focusedMenuSession' | 'focusedSessionKey' | 'foldedBot' | 'foldsOnClose' | 'forkStore' | 'hostClient' | 'hostError' | 'loadProviders' | 'messageDrafts' | 'missingSessions' | 'nativeTakeover' | 'navigateAttribution' | 'navigation' | 'openAsk' | 'openDirectorySession' | 'openPage' | 'openPreviewSource' | 'openSession' | 'openTeamLayout' | 'openTrackedSession' | 'openedSessions' | 'pageActionsTarget' | 'pageOpen' | 'presentSessionView' | 'presentedViewId' | 'previewClient' | 'previewHost' | 'providerChoiceList' | 'providerId' | 'providers' | 'refusedOffline' | 'remoteHosts' | 'replicaFor' | 'restoreView' | 'resumeAgent' | 'retryHosts' | 'selectHost' | 'selectProvider' | 'selectableHosts' | 'selectedBot' | 'selectedHost' | 'selectedPrimaryMissing' | 'selectedProviderChoice' | 'selectedRemoteHost' | 'sessionEntries' | 'sessionNotice' | 'sessionOptions' | 'sessionPanel' | 'setCreatePlanning' | 'setOpenedSessions' | 'setRemovingBot' | 'setScanOpen' | 'setSessionOptions' | 'setTpmListOpen' | 'setTrackedOnly' | 'sharedWindow' | 'sidebarWindow' | 'state' | 'succession' | 'successionDialog' | 'supportingRailOpen' | 'teamConversationsOpen' | 'teamReveal' | 'teamRoster' | 'teamRosterRef' | 'teamView' | 'tpm' | 'tpmListOpen' | 'tpmMainSessions' | 'tpmTriggerRef' | 'tpmView' | 'trackedOnly' | 'tracking' | 'transitioning' | 'transport' | 'updateTaskRoster' | 'updateTeamRoster' | 'userScoped' | 'vscodeTunnelClient' | 'windowMode' | 'windowToolbarShown' | 'windowWorkspace'>) {
  const { accessReady, activated, activeOpened, activeRemoteSession, ask, askSurfaceVisible, askTriggerRef, attention, baseUrl, botPresentation, canOpenFocusedAsk, catalogError, catalogStatus, catchUp, clientActions, closeInspector, closeView, compactLayout, contextOpen, createAgent, createPlanning, creationFacts, creationLocked, creationUnavailableReason, currentGroupBinding, currentSession, desktopContextVisible, directory, directoryRevision, directoryView, dispatchPanels, draftOwnerBinding, failure, favorites, featureSource, focusedAskEntry, focusedAskSession, focusedAskState, focusedAskUnavailable, focusedMenuSession, focusedSessionKey, foldedBot, foldsOnClose, forkStore, hostClient, hostError, loadProviders, messageDrafts, missingSessions, nativeTakeover, navigateAttribution, navigation, openAsk, openDirectorySession, openPage, openPreviewSource, openSession, openTeamLayout, openTrackedSession, openedSessions, pageActionsTarget, pageOpen, presentSessionView, presentedViewId, previewClient, previewHost, providerChoiceList, providerId, providers, refusedOffline, remoteHosts, replicaFor, restoreView, resumeAgent, retryHosts, selectHost, selectProvider, selectableHosts, selectedBot, selectedHost, selectedPrimaryMissing, selectedProviderChoice, selectedRemoteHost, sessionEntries, sessionNotice, sessionOptions, sessionPanel, setCreatePlanning, setOpenedSessions, setRemovingBot, setScanOpen, setSessionOptions, setTpmListOpen, setTrackedOnly, sharedWindow, sidebarWindow, state, succession, successionDialog, supportingRailOpen, teamConversationsOpen, teamReveal, teamRoster, teamRosterRef, teamView, tpm, tpmListOpen, tpmMainSessions, tpmTriggerRef, tpmView, trackedOnly, tracking, transitioning, transport, updateTaskRoster, updateTeamRoster, userScoped, vscodeTunnelClient, windowMode, windowToolbarShown, windowWorkspace } = scope;
  const t = useTranslate();

  /**
   * How a dock or float of the shown Window folds: a bot's × folds it where it stands, and folded or asleep it is a slim
   * card on desktop (compact layouts show one view at a time and do not fold).
   */
  function windowPaneFolding(viewId: string): { fold?: FoldedBot; asleep?: boolean; onWake?(): void; onFold?(): void; onRestore?(): void; onRemove?(): void; onCloseView?(viewId: string): void } {
    if (!sharedWindow) return {};
    const view = sharedWindow.views.find(item => item.id === viewId);
    const folding = paneFolding(view, windowWorkspace.readGroup(sharedWindow.id), { compact: compactLayout, sessionMissing: !!view?.binding && missingSessions.has(sessionKey(view.binding)) });
    return { onCloseView: closeView, ...(foldsOnClose(view) ? { onFold: () => closeView(viewId) } : {}),
      ...(folding.kind === 'asleep' ? { asleep: true, onWake: () => restoreView(viewId) } : {}),
      ...(folding.kind === 'folded' ? { fold: foldedBot(view as WindowView & { binding: WindowSessionBinding }), onRestore: () => restoreView(viewId), onRemove: () => setRemovingBot({ windowId: sharedWindow.id, viewId }) } : {}) };
  }

  function providerDisplayName(hostId: string, id: string): string {
    return remoteHosts.find(host => host.id === hostId)?.providers?.find(provider => provider.providerId === id)?.displayName
      ?? (hostId === 'local' ? providers.find(provider => provider.providerId === id)?.displayName : undefined) ?? id;
  }

  /** Where a bot runs, and the providers of its earlier sessions (oldest first) when its handoff chain is known, for its Info sheet. */
  function describeBot(place: { groupId: string; viewId: string }): BotInfo | undefined {
    const binding = windowWorkspace.readGroup(place.groupId)?.window.views.find(view => view.id === place.viewId)?.binding;
    if (!binding) return;
    const hostId = binding.hostId ?? 'local', host = remoteHosts.find(candidate => candidate.id === hostId);
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === place.groupId && entry.viewId === place.viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const chain = slotId ? succession.historyNavigationFor({ hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId, title: binding.title, viewId: slotId }) : undefined;
    const earlier = chain?.predecessor && !chain.history ? [...chain.ancestors].reverse().concat(chain.predecessor) : [];
    return { host: host?.name ?? hostId, ...(host ? { online: host.online } : {}), provider: providerDisplayName(hostId, binding.providerId),
      earlier: earlier.map(session => providerDisplayName(session.hostId ?? hostId, session.providerId)) };
  }

  function describeBotConversation(place: BotPlace, capturedSource?: OpenedSession): SessionSurfaceDescriptor | undefined {
    if (place.kind === 'section') return;
    const group = place.kind === 'bot' ? windowWorkspace.readGroup(place.groupId) : undefined;
    const view = place.kind === 'bot' ? group?.window.views.find(view => view.id === place.viewId) : undefined;
    const target = capturedSource ? { ...capturedSource, hostId: capturedSource.hostId ?? 'local' } : place.kind === 'session' ? { ...place.session, hostId: place.session.hostId ?? 'local' } : view?.binding;
    const confirmed = place.kind !== 'bot' || selectedBot.group?.window.id === place.groupId && selectedBot.view?.id === place.viewId && !!selectedBot.slot;
    const retained = botPresentation.recovering && place.kind === 'bot' && botPresentation.confirmed?.groupId === place.groupId && botPresentation.confirmed.viewId === place.viewId
      ? botPresentation.confirmed : undefined;
    if (!target || !capturedSource && place.kind === 'bot' && (!group || !hasBotAppearance(group) || group.bots?.members[place.viewId]?.hidden || !confirmed && !retained)) return;
    const mappedSlot = capturedSource ? viewKey(capturedSource) : place.kind === 'bot' && view?.binding ? succession.document.windowBindings?.find(entry => entry.windowId === place.groupId && entry.viewId === place.viewId && entry.bindingKey === windowBindingKey(view.binding!))?.slotId : undefined;
    const slot = place.kind === 'bot' ? succession.document.slots.find(slot => slot.id === mappedSlot) : succession.ensureView(target);
    if (!slot || retained && !confirmed && retained.slotId !== slot.id) return;
    const host = remoteHosts.find(host => host.id === target.hostId);
    return { slotId: slot.id, titleInteraction: undefined, props: {
      storageScope: baseUrl, baseUrl, target, viewId: slot.id, windowViewId: view?.id,
      hostLabel: host?.name ?? target.hostId, compact: compactLayout, active: !windowMode, visible: !windowMode,
      attachmentEnabled: accessReady && confirmed, mutationBlocked: !confirmed,
      offline: host?.online === false || (refusedOffline !== undefined && host?.id === refusedOffline), familyRoot: false, entries: [target], transport, replicaFor,
      directoryFor: hostId => hostId === selectedHost.id ? directory : undefined,
      draftStore: messageDrafts, draftBinding: draftOwnerBinding(slot.owners.text), imageDraftBinding: slot.owners.image,
      displayBinding: view ? { scope: baseUrl, key: view.id } : undefined,
      successionContext: succession.successionContextFor(slot.id),
      sessionPresentation: context => presentSessionView(context, place.kind === 'bot' ? { bot: { groupId: place.groupId, viewId: place.viewId } } : { fallback: true }),
      onNavigate: async (destination, _children, source) => { navigation.select({ kind: 'session', session: { ...destination, hostId: 'hostId' in destination ? destination.hostId ?? source.hostId : source.hostId, providerId: 'providerId' in destination ? destination.providerId : source.providerId } }); },
    } };
  }

  const handoffSource = successionDialog?.source as (OpenedSession & { bot?: { groupId: string; viewId: string }; fallback?: boolean }) | undefined;

  const handoffPlace: BotPlace | undefined = handoffSource?.bot ? { kind: 'bot', ...handoffSource.bot } : handoffSource?.fallback ? { kind: 'session', session: handoffSource } : undefined;

  const retainedHandoff = handoffPlace && handoffSource ? describeBotConversation(handoffPlace, handoffSource) : undefined;

  const successionFailure = succession.error && succession.error !== nativeTakeover?.message && !selectedPrimaryMissing ? succession.error : undefined;

  const successionRetry = successionFailure && !nativeTakeover ? <button type="button" onClick={succession.retry}>{succession.result?.status === 'applied' ? t('navigation.retrySession') : t('navigation.retrySynchronization')}</button> : undefined;

  // One failure gets one notice; the connection notice already explains this succession failure.
  const successionNotice = !!successionFailure && !nativeTakeover && sessionNotice?.successionError === successionFailure;

  // While the desktop sidebar is visible, the Window, Team, TPM, Track and Ask capsules give way to its Windows section and Shortcuts rows.
  const sidebarShortcuts = windowMode && !compactLayout && desktopContextVisible;

  const menuCurrentBinding = sharedWindow ? directoryView?.binding : currentSession ? windowSessionBinding(currentSession) : undefined;

  // Track, Team and TPM; Ask has its own host because its capsule floats inside .lab-ask-workspaces.
  const trackTeamTpmEntries = <>
    {windowMode && userScoped && attention.trackVisible ? <SessionTrackingMenu catchUp={catchUp} tracking={tracking} teams={teamRoster?.baseUrl === baseUrl ? teamRoster.teams : []} knownSessions={[...favorites.stars, ...sessionEntries]} busy={transitioning} inert={supportingRailOpen} onOpen={item => void openTrackedSession(item)} /> : null}
    <TeamMenu visible={windowMode && teamView.visible} baseUrl={baseUrl} enabled={accessReady && !!directory} following={teamConversationsOpen} hosts={remoteHosts} source={featureSource} sourceViewId={sharedWindow && presentedViewId ? `${sharedWindow.id}/${presentedViewId}` : undefined}
      compact={compactLayout} currentSession={focusedMenuSession} onTeamsChange={updateTeamRoster} onTasksChange={updateTaskRoster} reveal={teamReveal?.baseUrl === baseUrl ? teamReveal : undefined}
      onOpen={openTeamLayout} onOpenSession={target => openSession(target, undefined, undefined, false, undefined, undefined, undefined, undefined, compactLayout ? 'primary' : undefined)} />
    <TpmMenu tpm={tpm} open={tpmListOpen} onOpenChange={setTpmListOpen} mainSessions={tpmMainSessions} main={featureSource} visible={windowMode && tpmView.visible} triggerRef={tpmTriggerRef} inert={supportingRailOpen} />
  </>;

  const askEntry = askSurfaceVisible ? <AskButton triggerRef={askTriggerRef}
        disabled={!canOpenFocusedAsk} sourceTitle={focusedAskSession?.title} unavailable={focusedAskUnavailable}
        observation={focusedAskEntry?.record?.target ? tracking.observations[sessionKey(focusedAskEntry.record.target)] : undefined}
        onOpen={() => { if (canOpenFocusedAsk && focusedAskSession) openAsk(focusedAskSession, focusedAskState); }} /> : null;

  // A compact screen keeps the entries in its launcher bar, which the layout reserves; a wide one without the sidebar keeps them in the
  // Window's toolbar, where tiles that fill the width cannot be covered. Only a wide screen without either floats them, beside the reading column.
  const shortcutPlacement: 'sidebar' | 'bar' | 'toolbar' | 'floating' = sidebarShortcuts ? 'sidebar' : compactLayout ? 'bar' : windowMode && windowToolbarShown ? 'toolbar' : 'floating';

  // The Host, provider, directory and new-session panels: written once, placed in the compact drawer or on the desktop page.
  // On desktop the page itself is the Favorites region, and its toolbar the Favorites heading: the section inside it carries no second name or heading.
  const sessionPanelContent = <div className="lab-sidebar-content">
      {userScoped && sessionPanel === 'favorites' ? <section className="lab-session-directory lab-favorites-section" aria-label={compactLayout ? t('navigation.favorites') : undefined}>{compactLayout ? <div className="lab-directory-heading"><h2><FavoritesHeading loading={favorites.loading} /></h2></div> : null}<FavoritesList favorites={favorites} tracking={tracking} trackedOnly={trackedOnly} onFilterChange={setTrackedOnly} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /></section> : null}
      {directory ? <HostPairing compact={sessionPanel === 'list'} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning && !sidebarWindow} hosts={selectableHosts} hostError={hostError ?? requestedHostUnavailableReason(creationFacts, t)} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      <div className="lab-directory-panel" hidden={sessionPanel !== 'list'}>
      {directory || providerChoiceList.length > 1 ? <label className="lab-browse-provider">{t('navigation.browse.provider')}<select aria-label={t('navigation.browse.provider')} value={selectedProviderChoice?.selectionId ?? ''} disabled={creationLocked || transitioning && !sidebarWindow || providerChoiceList.length === 0} onChange={(event) => selectProvider(event.target.value)}>{providerChoiceList.length === 0 ? <option value="">{t('navigation.browse.noProviders')}</option> : null}{providerChoiceList.map((provider) => <option key={provider.selectionId} value={provider.selectionId}>{provider.displayName}</option>)}</select></label> : null}
      {directory ? <SessionDirectory quickOpen={<button type="button" className="lab-session-scan-trigger" aria-label={t('navigation.browse.scanQr')} onClick={() => setScanOpen(true)}>{t('navigation.browse.scan')}</button>} favorites={favorites} searchable directory={directory} providerId={providerId} activeAgentId={focusedMenuSession?.agentId} opened={openedSessions} known={sessionEntries} sideStore={forkStore} askStore={ask.store} hostId={selectedHost.id} onOpenRelated={(item) => void openDirectorySession(item)} busy={!sidebarWindow && (transitioning || remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openDirectorySession(item)} onSelect={(item) => void openDirectorySession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
      </div>
      <div hidden={sessionPanel !== 'new'}>
      <ProviderSessionControls
        providers={providerChoiceList}
        selectedProviderId={selectedProviderChoice?.selectionId ?? ''}
        catalogStatus={selectedHost.id !== 'local' || (catalogStatus === 'empty' && providerChoiceList.length > 0) ? 'ready' : catalogStatus}
        catalogError={catalogError}
        creating={transitioning}
        unavailableReason={creationUnavailableReason}
        planning={createPlanning}
        configurationLocked={creationLocked}
        onPlanningChange={providerId !== 'dsh' && !creationLocked ? setCreatePlanning : undefined}
        onRetryProviders={() => void loadProviders()}
        persistence={activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : state?.agent?.persistence}
        onSelectedProviderChange={selectProvider}
        onCreateSession={() => void createAgent()}
        onResumeSession={activeRemoteSession || activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : () => void resumeAgent()}
      >{directory ? <SessionConfiguration directory={directory} providerId={providerId} canBrowse={remoteHosts.find(host => host.id === selectedHost.id)?.access !== 'shared'} value={sessionOptions} disabled={transitioning || creationLocked || !!creationUnavailableReason} onChange={setSessionOptions} /> : null}</ProviderSessionControls>
      </div>
      {sessionNotice && !nativeTakeover && compactLayout && contextOpen ? <SessionConnectionNotice notice={sessionNotice} action={successionNotice ? successionRetry : undefined} /> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      </div>;

  // Conversations read these during render; their values keep their identity so a render of App does not reach every
  // mounted conversation through context (stage 6). Shown conversations render with App and read the latest state.
  const contextValues: { descriptions: NonNullable<ContextType<typeof SessionDescriptionsContext>>; operations: NonNullable<ContextType<typeof SessionViewOperationsContext>> } = { descriptions: { describe: session => describeSession({ session,
    sessions: [...favorites.stars, ...sessionEntries, ...tpmMainSessions.values()], forks: forkStore.all(), asks: ask.store.all(),
    tpmWorks: tpm.works, teams: teamRoster?.baseUrl === baseUrl ? teamRoster.teams : [],
    hostNames: new Map([['local', t('team.host.labServer')], ...remoteHosts.map(host => [host.id, host.name] as const)]),
  }), hostName: id => remoteHosts.find(host => host.id === id)?.name, navigate: navigateAttribution }, operations: { storageScope: baseUrl, transport, enabled: accessReady && activated, resolveTarget: (source, requested) => {
    const mapped = currentGroupBinding(requested?.viewId);
    if (mapped && sessionKey(mapped.binding) !== sessionKey(source)) throw keyedError('navigation.view.bindingChanged');
    const roster = teamRosterRef.current;
    const member = teamViewTarget(succession.document, roster?.baseUrl === baseUrl ? roster.teams : undefined, source, requested?.viewId);
    // A Team member follows prompt edits and handoffs alike: Team routing moves its seat to the successor.
    const result = succession.resolveTarget(source, requested);
    if (mapped && sessionKey(mapped.binding) !== sessionKey(result.target)) throw keyedError('navigation.view.bindingSynchronizing');
    if (member && sessionKey(member) !== sessionKey(result.target)) throw keyedError('navigation.view.teamUnconfirmed');
    return { ...result, target: { ...result.target, ...(member ? { teamId: member.teamId, teamMemberId: member.teamMemberId } : {}) } };
  }, directory: source => labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)), refreshSettled: succession.refreshSettled,
    successionContextFor: succession.successionContextFor, synchronize: () => void succession.refresh() } };

  const latestContexts = useRef(contextValues);
 latestContexts.current = contextValues;

  const sessionDescriptions = useMemo<ContextType<typeof SessionDescriptionsContext>>(() => ({
    describe: session => latestContexts.current.descriptions.describe(session),
    hostName: id => latestContexts.current.descriptions.hostName?.(id),
    navigate: (...args) => latestContexts.current.descriptions.navigate!(...args),
  }), []);

  const operationsEnabled = accessReady && activated;

  // Where locators lead changes with succession (a handoff, a discovery) and with the Team roster (a seat moving to its
  // member's successor): a new value then reaches every conversation, also those a dock or a hidden pane keeps, so each
  // resolves its target again. Nothing else App renders for changes it.
  const resolutionRevision = JSON.stringify([succession.revision, teamRoster?.baseUrl === baseUrl ? teamRoster.teams.map(team => [team.id, team.revision]) : null]);

  const sessionViewOperations = useMemo<ContextType<typeof SessionViewOperationsContext>>(() => ({
    storageScope: baseUrl, transport, enabled: operationsEnabled,
    resolveTarget: (source, requested) => latestContexts.current.operations.resolveTarget(source, requested),
    directory: source => latestContexts.current.operations.directory(source),
    refreshSettled: (...args) => latestContexts.current.operations.refreshSettled(...args),
    successionContextFor: (...args) => latestContexts.current.operations.successionContextFor?.(...args),
    synchronize: () => latestContexts.current.operations.synchronize?.(),
  }), [baseUrl, transport, operationsEnabled, resolutionRevision]);
  return { windowPaneFolding, describeBot, describeBotConversation, retainedHandoff, successionFailure, successionRetry, successionNotice, sidebarShortcuts, menuCurrentBinding, trackTeamTpmEntries, askEntry, shortcutPlacement, sessionPanelContent, sessionDescriptions, sessionViewOperations };
}

export type ViewModelSlice = ReturnType<typeof useViewModel>;
