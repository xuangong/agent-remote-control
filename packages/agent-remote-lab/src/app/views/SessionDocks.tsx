// The dock rail: the primary groups of a Window, or the main conversation with its Side conversations.
import { isBotView, windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { SessionFamily } from '../../components/SessionFamily.js';
import { CommunicationNavigationContext } from '@orchardworks/agent-client-web/react';
import { remoteSessionState } from '@orchardworks/agent-client';
import { SessionSuccessionHistory } from '../../components/SessionSuccessionHistory.js';
import { handoffCommand } from '../../handoff-command.js';
import { SessionTitle } from '../../components/SessionTitle.js';
import { StarButton } from '../../components/SessionFavorites.js';
import { MissingSessionNote } from '../../components/SessionConnectionNotice.js';
import { SessionLink } from '../../components/SessionLink.js';
import { SessionHeadingActions } from '../../components/SessionHeadingActions.js';
import { compositionSelection } from '../../session-composition.js';
import { AsleepNotice } from '../../components/AsleepNotice.js';
import { sessionKey } from '../../session-tree.js';
import { ChatSessionManager } from '../../components/ChatSessionManager.js';
import { LabWorkbench } from '../../components/LabWorkbench.js';
import { SideConversation } from '../../components/SideConversation.js';
import { ForkEntries, ForkReference } from '../../components/ForkReference.js';
import { sideNavigationSource, forkDisplayState } from '../../session-forks.js';
import { CollapsedConversations } from '../../components/CollapsedConversations.js';
import { MinimizeMainSession, SessionDockRail } from '../../components/SessionDock.js';
import { ConversationPane, ConversationSplit } from '../../components/ConversationSplit.js';
import { forkCommands } from '../../fork-actions.js';
import { IconButton } from '../../ui/IconButton.js';
import { viewKey } from '../helpers.js';
import type { AppScope } from '../types.js';

export function SessionDocks({ scope }: { readonly scope: Pick<AppScope, 'accessReady' | 'activeAgentId' | 'activeOpened' | 'activeView' | 'ancestors' | 'asleepBot' | 'attachingAgentId' | 'availableConversationActions' | 'baseUrl' | 'botHandoff' | 'boundFork' | 'canHandoffPrimary' | 'closeSide' | 'closeView' | 'compactLayout' | 'compositionProtected' | 'conversationActions' | 'conversationHistory' | 'createFork' | 'createSessionView' | 'currentSession' | 'detachedSideRoot' | 'directory' | 'draftBindingFor' | 'draftOwnerBinding' | 'executePrimaryCommand' | 'expandedKeys' | 'favorites' | 'focusPrimaryContent' | 'focusSession' | 'focusedWindow' | 'foldedBot' | 'forkInputStatus' | 'forkStore' | 'handoff' | 'hostOffline' | 'inspectTimelineEntry' | 'letterReveals' | 'markSessionMissing' | 'messageDrafts' | 'missingSessions' | 'navigationIntent' | 'observeSideActivity' | 'openFork' | 'openLocalView' | 'openNewSessionPanel' | 'openSession' | 'openSideKeys' | 'openingControlNotice' | 'presentSessionView' | 'presentedPrimaryViewId' | 'presentedViewId' | 'primaryCommunication' | 'primaryDisplaySlot' | 'primaryExpanded' | 'primaryGroups' | 'primaryNavigation' | 'primarySuccessionGated' | 'questionDrafts' | 'receiveViewSession' | 'refreshRelations' | 'remoteHosts' | 'renamePrimaryTitle' | 'replicaFor' | 'reportPendingPrimaryInput' | 'restoreView' | 'revealSession' | 'selectPrimaryGroup' | 'selectedHost' | 'sessionEntries' | 'sessionState' | 'sessionWindows' | 'setMinimizedViewTarget' | 'setQuestionDrafts' | 'setRemovingBot' | 'setSessionViewTarget' | 'shareSession' | 'sharedSlots' | 'sharedWindow' | 'showWindowSessionChooser' | 'sideSessions' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'status' | 'succession' | 'successionContext' | 'successionProgress' | 'supportingRailOpen' | 'traceRequest' | 'transitioning' | 'transport' | 'unlinkSide' | 'viewNavigation' | 'wakeBot' | 'windowMode' | 'windowSession' | 'windowStageVisible' | 'windowWorkspace'> }) {
  const { accessReady, activeAgentId, activeOpened, activeView, ancestors, asleepBot, attachingAgentId, availableConversationActions, baseUrl, botHandoff, boundFork, canHandoffPrimary, closeSide, closeView, compactLayout, compositionProtected, conversationActions, conversationHistory, createFork, createSessionView, currentSession, detachedSideRoot, directory, draftBindingFor, draftOwnerBinding, executePrimaryCommand, expandedKeys, favorites, focusPrimaryContent, focusSession, focusedWindow, foldedBot, forkInputStatus, forkStore, handoff, hostOffline, inspectTimelineEntry, letterReveals, markSessionMissing, messageDrafts, missingSessions, navigationIntent, observeSideActivity, openFork, openLocalView, openNewSessionPanel, openSession, openSideKeys, openingControlNotice, presentSessionView, presentedPrimaryViewId, presentedViewId, primaryCommunication, primaryDisplaySlot, primaryExpanded, primaryGroups, primaryNavigation, primarySuccessionGated, questionDrafts, receiveViewSession, refreshRelations, remoteHosts, renamePrimaryTitle, replicaFor, reportPendingPrimaryInput, restoreView, revealSession, selectPrimaryGroup, selectedHost, sessionEntries, sessionState, sessionWindows, setMinimizedViewTarget, setQuestionDrafts, setRemovingBot, setSessionViewTarget, shareSession, sharedSlots, sharedWindow, showWindowSessionChooser, sideSessions, stackPath, stackRange, stackRoot, state, status, succession, successionContext, successionProgress, supportingRailOpen, traceRequest, transitioning, transport, unlinkSide, viewNavigation, wakeBot, windowMode, windowSession, windowStageVisible, windowWorkspace } = scope;
  return <>
        {sharedWindow ? <SessionDockRail compact={compactLayout} onCreateView={createSessionView}
          onSelectPrimaryGroup={selectPrimaryGroup}
          onResizePrimaryGroup={(viewId, width) => windowWorkspace.authority?.operate({ type: 'view.resize', viewId, width })}
          onCollapsePrimaryGroup={(viewId, collapsed) => {
            const view = sharedWindow.views.find(item => item.id === viewId);
            if (!collapsed && view && asleepBot(view)) wakeBot(sharedWindow.id, viewId);
            if (collapsed || view?.collapsed) windowWorkspace.authority?.operate({ type: 'view.collapse', viewId, collapsed });
          }}
          onClosePrimaryGroup={viewId => windowWorkspace.authority?.operate({ type: 'view.close', viewId })}
          onRemovePrimaryGroup={viewId => setRemovingBot({ windowId: sharedWindow.id, viewId })}
          primaryGroups={primaryGroups.map(view => {
            const pendingSlot = view.id === sharedWindow.selectedPrimaryViewId ? succession.displaySlot : undefined;
            const slot = sharedSlots?.get(view.id) ?? (pendingSlot && view.binding
              && [compositionSelection(pendingSlot), { hostId: pendingSlot.origin.target.hostId, ...pendingSlot.origin.target.native }]
                .some(source => sessionKey(source) === sessionKey(view.binding!)) ? pendingSlot : undefined);
            const additionalWidth = sharedWindow.views.filter(child => child.id !== view.id && windowPrimaryViewId(sharedWindow, child.id) === view.id && !child.collapsed).reduce((total, child) => total + child.width, 0);
            const missing = !!view.binding && missingSessions.has(sessionKey(view.binding));
            return { id: view.id, title: view.binding && !missing ? view.binding.title : 'Select session', width: view.width, additionalWidth,
              // A sleeping bot stands folded and dimmed; restoring it wakes it for every device.
              selected: view.id === presentedPrimaryViewId, collapsed: view.collapsed || asleepBot(view),
              // A folded bot shows who it is and how it is doing, from the shared channel, while its conversation is released.
              ...((view.collapsed || asleepBot(view)) && !missing && isBotView(view) ? { fold: foldedBot(view) } : {}),
              content: view.binding && !missing ? <>{compactLayout && asleepBot(view) ? <AsleepNotice onWake={() => restoreView(view.id)} /> : null}<SessionFamily baseUrl={baseUrl} storageScope={baseUrl} target={view.binding} viewId={view.id} folded={asleepBot(view)} onCloseView={closeView}
                sessionIntent={view.binding.sessionIntent}
                successionContext={succession.successionContextFor(slot?.id)}
                directoryFor={hostId => hostId === selectedHost.id ? directory : undefined}
                attachmentManaged={view.id === sharedWindow.selectedPrimaryViewId}
                attachedSession={succession.binding?.session.viewId === slot?.id ? succession.binding?.session : undefined}
                attachmentNotice={view.id === sharedWindow.selectedPrimaryViewId ? openingControlNotice : undefined}
                hostLabel={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId}
                offline={remoteHosts.find(host => host.id === view.binding!.hostId)?.online === false}
                // Not windowStageVisible: an inactive family parks its conversation and releases its attachment, so
                // the sessions page, which hides #lab-workbench, would detach every view and reattach them on Back.
                compact={compactLayout} active={windowMode && activeView === 'workbench' && !supportingRailOpen && (!compactLayout || view.id === (presentedPrimaryViewId ?? sharedWindow.selectedPrimaryViewId))}
                transport={transport} draftStore={messageDrafts} replicaFor={replicaFor} onSessionBound={receiveViewSession} onSessionUnavailable={markSessionMissing}
                draftBinding={slot ? draftOwnerBinding(slot.owners.text) : undefined} imageDraftBinding={slot?.owners.image}
                displayBinding={{ scope: baseUrl, key: view.id }} navigation={viewNavigation}
                sessionPresentation={presentSessionView} /></>
                : <div className="lab-empty-session-view" role="status" data-view-id={view.id} aria-current={view.id === presentedViewId || undefined}>
                  <header className="lab-empty-session-heading">
                    <strong>Select session</strong>
                    <IconButton icon="close" data-pane-selection-ignore label="Close primary group: Select session" title="Close session view"
                      onClick={() => windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id })} />
                  </header><div className="lab-empty-session-body">
                    {view.binding ? <MissingSessionNote title={view.binding.title} host={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId} /> : <p>This session view is empty.</p>}
                    <div className="lab-empty-session-actions">
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); showWindowSessionChooser(); }}>Choose session</button>
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); openNewSessionPanel(); }}>New session</button>
                    </div></div></div>,
            };
          })} /> : <SessionDockRail onCreateView={createSessionView} minimizedHeader={<div ref={setMinimizedViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-minimized-view-slot" />} mainTitle={stackRoot?.title ?? activeOpened?.title} minimumBaseWidth={stackRange.end > stackRange.start ? 640 : 320}><ConversationSplit compact={compactLayout} start={stackRange.start} end={stackRange.end}>
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(0, stackRange.start)} offset={0} onExpand={revealSession} />
        <ConversationPane className="lab-primary-conversation lab-session-composition" data-active={!sessionWindows.activeId || undefined} tabIndex={-1} hidden={!primaryExpanded} onFocusCapture={event => focusPrimaryContent(event.target)} onClickCapture={event => focusPrimaryContent(event.target)}>
        {windowSession.empty ? <div className="lab-empty-session-view" role="status"><p>This session view is empty.</p><button type="button" onClick={openNewSessionPanel}>New session</button>{botHandoff ? null : successionProgress}</div> : <><CommunicationNavigationContext.Provider value={primaryCommunication}><LabWorkbench {...primaryNavigation}
          sessionIdentity={stackRoot ?? succession.selected ?? activeOpened}
          operationBinding={succession.binding ? { source: succession.binding.session, historical: navigationIntent.sessionIntent === 'history', scope: { agentId: succession.binding.session.agentId, client: succession.binding.client, replica: succession.binding.replica, transport, recipient: succession.imageRecipient, isCurrent: succession.binding.isCurrent } } : undefined}
          headingMode={compactLayout ? 'toolbar' : 'inline'}
          headingStart={primaryExpanded ? <div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : undefined}
          sessionState={!accessReady || hostOffline ? remoteSessionState(state, !accessReady ? 'connecting' : 'disconnected') : sessionState}
          handoff={handoff}
          draftSessionKey={succession.selected ? sessionKey(succession.selected) : stackRoot ? sessionKey(stackRoot) : activeAgentId}
          draftOnly={succession.active && !succession.isCurrent()}
          mutationBlocked={primarySuccessionGated}
          onPendingInputChange={reportPendingPrimaryInput}
          pendingFirstInputContext={successionContext && successionContext.state !== 'materialized' ? { state: successionContext.state, onRetry: successionContext.onRetry } : undefined}
          headingContext={succession.historyNavigation ? <SessionSuccessionHistory navigation={succession.historyNavigation} onOpen={(session, intent) => openSession(session, undefined, undefined, false, undefined, intent)} /> : undefined}
          composerStatus={botHandoff ? undefined : successionProgress}
          imageDraftBinding={primaryDisplaySlot?.owners.image}
          imageRecipient={succession.imageRecipient}
          displayBinding={primaryDisplaySlot?.owners.display}
          onInspectEntry={key => inspectTimelineEntry(key, 'trace')}
          revealEntry={activeAgentId && letterReveals[activeAgentId] || (traceRequest?.view === 'workbench' ? traceRequest : undefined)}
          state={forkDisplayState(state, boundFork)} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={forkInputStatus?.pending && forkInputStatus.agentId === activeAgentId ? { deleteMessage: conversationActions.deleteMessage } : availableConversationActions} visible={windowStageVisible && primaryExpanded}
          consoleCommands={[...(status === 'ready' && !hostOffline && directory && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []), ...(canHandoffPrimary ? [handoffCommand] : [])]}
          onExecuteConsoleCommand={executePrimaryCommand}
          nativeTakeover={openingControlNotice}
          composerContext={boundFork ? <ForkReference fork={boundFork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : undefined}
          composerNotice={<ForkEntries forks={forkStore.linked().filter((fork) => fork.target && (sideNavigationSource(fork).agentId === activeAgentId || (activeOpened && sessionKey(sideNavigationSource(fork)) === sessionKey(activeOpened))))} openSides={stackRoot ? openSideKeys(viewKey(stackRoot)) : undefined} onOpen={(fork) => void openFork(fork)} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />}
          sessionManager={<><MinimizeMainSession />{!compactLayout && stackRoot ? <StarButton session={stackRoot} favorites={favorites} /> : null}<SessionHeadingActions sessionKey={stackRoot ? sessionKey(stackRoot) : activeAgentId}>{(!compactLayout || succession.localViews().length > 0) && directory && currentSession ? <ChatSessionManager current={currentSession} entries={sessionEntries} busy={transitioning || hostOffline} onOpen={(item) => void openSession(item)}
            localViews={succession.localViews()} activeSlot={succession.desired?.slot.id} onOpenView={view => void openLocalView(view.slotId)} /> : null}<nav className="lab-conversation-history" aria-label="Conversation history">
            <button type="button" aria-label="Back to previous conversation" title="Back" disabled={transitioning || !conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label="Forward to next conversation" title="Forward" disabled={transitioning || !conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav>{shareSession ? <SessionLink session={shareSession} sessionIntent={navigationIntent.sessionIntent} keepOriginal={navigationIntent.keepOriginal} /> : null}</SessionHeadingActions></>}
          conversationPath={ancestors.length > 0 ? <nav className="lab-conversation-path" aria-label="Conversation path">
            {ancestors.map((ancestor) => <span key={ancestor.agentId}>
              <button type="button" className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === ancestor.agentId)?.status} disabled={transitioning} onClick={() => { void openSession(ancestor); }}>{ancestor.title}</button>
              <span aria-hidden="true"> / </span>
            </span>)}
            <SessionTitle as="span" current title={activeOpened?.title ?? ''} status={state?.agent?.status} onRename={!detachedSideRoot ? renamePrimaryTitle : undefined} />
          </nav> : stackRoot ? <SessionTitle className="lab-primary-title" title={stackRoot.title} status={state?.agent?.status} onRename={!detachedSideRoot ? renamePrimaryTitle : undefined} /> : null}
          draftBinding={primaryDisplaySlot ? draftOwnerBinding(primaryDisplaySlot.owners.text) : undefined}
          questionDrafts={activeAgentId ? questionDrafts[activeAgentId] ?? {} : undefined}
          onQuestionDraftChange={activeAgentId ? (requestId, draft) => setQuestionDrafts((current) => ({
            ...current, [activeAgentId]: { ...current[activeAgentId], [requestId]: draft },
          })) : undefined}
        /></CommunicationNavigationContext.Provider>
        </>}
        </ConversationPane>
        {sideSessions.filter((session) => !stackRoot || viewKey(session) !== viewKey(stackRoot)).map((session) => <SideConversation
          headingMode={compactLayout ? 'toolbar' : 'inline'}
          key={viewKey(session)} session={session} replica={replicaFor(session.agentId)} standalone={viewKey(session) === detachedSideRoot} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)}
          onRenameTitle={viewKey(session) === detachedSideRoot ? renamePrimaryTitle : undefined}
          navigation={viewNavigation} transport={transport} store={forkStore} onActivityChange={observeSideActivity}
          headingStart={!primaryExpanded && session.agentId === stackPath[stackRange.start]?.agentId ? <><div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /><MinimizeMainSession /></> : undefined}
          position={stackPath.findIndex((entry) => viewKey(entry) === viewKey(session))}
          expanded={expandedKeys.has(viewKey(session))}
          focused={!compositionProtected && focusedWindow !== undefined && viewKey(focusedWindow) === viewKey(session)}
          openSides={openSideKeys(viewKey(session))}
          initialInput={forkInputStatus?.agentId === session.agentId ? forkInputStatus : undefined}
          visible={windowStageVisible} draftBinding={draftBindingFor(session)}
          imageDraftBinding={succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.image}
          displayBinding={succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.display}
          onFocus={() => focusSession(session)} onClose={() => closeSide(session)} onOpenSource={revealSession} onOpenFork={(fork) => void openFork(fork)} onFork={createFork} />)}
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(stackRange.end + 1)} offset={stackRange.end + 1} onExpand={revealSession} />
        </ConversationSplit></SessionDockRail>}
  </>;
}
