// The dock rail: the primary groups of a Window, or the main conversation with its Side conversations.
import { isBotView, windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { SessionFamily } from '../../conversation/SessionFamily.js';
import { CommunicationNavigationContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { remoteSessionState } from '@orchardworks/agent-client';
import { handoffCommand } from '../../handoff-command.js';
import { SessionTitle } from '../../conversation/SessionTitle.js';
import { StarButton } from '../../features/sessions/SessionFavorites.js';
import { MissingSessionNote } from '../../kernel/SessionConnectionNotice.js';
import { SessionLink } from '../../kernel/SessionLink.js';
import { SessionHeadingActions } from '../../conversation/SessionHeadingActions.js';
import { compositionSelection } from '../../kernel/session-composition.js';
import { AsleepNotice } from '../../conversation/AsleepNotice.js';
import { sessionKey } from '../../kernel/session-tree.js';
import { ChatSessionManager } from '../../features/sessions/ChatSessionManager.js';
import { LabWorkbench } from '../../conversation/LabWorkbench.js';
import { SideConversation } from '../../features/session-links/SideConversation.js';
import { ForkEntries, ForkReference } from '../../features/session-links/ForkReference.js';
import { sideNavigationSource, forkDisplayState } from '../../kernel/session-forks.js';
import { CollapsedConversations } from '../../conversation/CollapsedConversations.js';
import { MinimizeMainSession, SessionDockRail } from '../../kernel/SessionDock.js';
import { ConversationPane, ConversationSplit } from '../../conversation/ConversationSplit.js';
import { forkCommands } from '../../conversation/fork-actions.js';
import { IconButton } from '../../ui/IconButton.js';
import { viewKey } from '../helpers.js';
import type { AppScope } from '../types.js';
import { usePhoneLayout } from '../../kernel/usePhoneLayout.js';
import { useBotWorkbench } from '../useBotWorkbench.js';
import { derivedWorkbenchPanes } from './derivedWorkbenchTiles.js';
import { BotWorkbenchBody } from './BotWorkbenchBody.js';
import { WorkbenchPhone } from './WorkbenchPhone.js';

export function SessionDocks({ scope }: { readonly scope: Pick<AppScope, 'accessReady' | 'activeAgentId' | 'activeOpened' | 'activeView' | 'ancestors' | 'asleepBot' | 'attachingAgentId' | 'availableConversationActions' | 'baseUrl' | 'botHandoff' | 'boundFork' | 'canHandoffPrimary' | 'closeSide' | 'closeView' | 'compactLayout' | 'compositionProtected' | 'conversationActions' | 'conversationHistory' | 'createFork' | 'createSessionView' | 'currentSession' | 'detachedSideRoot' | 'directory' | 'draftBindingFor' | 'draftOwnerBinding' | 'executePrimaryCommand' | 'expandedKeys' | 'favorites' | 'focusPrimaryContent' | 'focusSession' | 'focusedWindow' | 'foldedBot' | 'forkInputStatus' | 'forkStore' | 'handoff' | 'hostOffline' | 'inspectTimelineEntry' | 'letterReveals' | 'markSessionMissing' | 'messageDrafts' | 'missingSessions' | 'navigationIntent' | 'observeSideActivity' | 'openFork' | 'openLocalView' | 'openNewSessionPanel' | 'openSession' | 'openSideKeys' | 'openingControlNotice' | 'presentSessionView' | 'presentedPrimaryViewId' | 'presentedViewId' | 'primaryCommunication' | 'primaryDisplaySlot' | 'primaryExpanded' | 'primaryGroups' | 'primaryNavigation' | 'primarySuccessionGated' | 'questionDrafts' | 'receiveViewSession' | 'refreshRelations' | 'remoteHosts' | 'renamePrimaryTitle' | 'replicaFor' | 'reportPendingPrimaryInput' | 'restoreView' | 'revealSession' | 'selectPrimaryGroup' | 'selectedHost' | 'sessionEntries' | 'sessionState' | 'sessionWindows' | 'setMinimizedViewTarget' | 'setQuestionDrafts' | 'setRemovingBot' | 'setSessionViewTarget' | 'shareSession' | 'sharedSlots' | 'sharedWindow' | 'showWindowSessionChooser' | 'sideSessions' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'status' | 'succession' | 'successionContext' | 'successionProgress' | 'supportingRailOpen' | 'traceRequest' | 'transitioning' | 'transport' | 'unlinkSide' | 'viewNavigation' | 'wakeBot' | 'windowMode' | 'windowSession' | 'windowStageVisible' | 'windowWorkspace' | 'teamRoster'> }) {
  const { accessReady, activeAgentId, activeOpened, activeView, ancestors, asleepBot, attachingAgentId, availableConversationActions, baseUrl, botHandoff, boundFork, canHandoffPrimary, closeSide, closeView, compactLayout, compositionProtected, conversationActions, conversationHistory, createFork, createSessionView, currentSession, detachedSideRoot, directory, draftBindingFor, draftOwnerBinding, executePrimaryCommand, expandedKeys, favorites, focusPrimaryContent, focusSession, focusedWindow, foldedBot, forkInputStatus, forkStore, handoff, hostOffline, inspectTimelineEntry, letterReveals, markSessionMissing, messageDrafts, missingSessions, navigationIntent, observeSideActivity, openFork, openLocalView, openNewSessionPanel, openSession, openSideKeys, openingControlNotice, presentSessionView, presentedPrimaryViewId, presentedViewId, primaryCommunication, primaryDisplaySlot, primaryExpanded, primaryGroups, primaryNavigation, primarySuccessionGated, questionDrafts, receiveViewSession, refreshRelations, remoteHosts, renamePrimaryTitle, replicaFor, reportPendingPrimaryInput, restoreView, revealSession, selectPrimaryGroup, selectedHost, sessionEntries, sessionState, sessionWindows, setMinimizedViewTarget, setQuestionDrafts, setRemovingBot, setSessionViewTarget, shareSession, sharedSlots, sharedWindow, showWindowSessionChooser, sideSessions, stackPath, stackRange, stackRoot, state, status, succession, successionContext, successionProgress, supportingRailOpen, traceRequest, transitioning, transport, unlinkSide, viewNavigation, wakeBot, windowMode, windowSession, windowStageVisible, windowWorkspace } = scope;
  const phone = usePhoneLayout();
  const t = useTranslate();
  const workbench = useBotWorkbench(scope);
  const derived = workbench.bound ? derivedWorkbenchPanes(workbench, scope, t) : [];
  const storedPanes = sharedWindow ? primaryGroups.map(view => {
            const pendingSlot = view.id === sharedWindow.selectedPrimaryViewId ? succession.displaySlot : undefined;
            const slot = sharedSlots?.get(view.id) ?? (pendingSlot && view.binding
              && [compositionSelection(pendingSlot), { hostId: pendingSlot.origin.target.hostId, ...pendingSlot.origin.target.native }]
                .some(source => sessionKey(source) === sessionKey(view.binding!)) ? pendingSlot : undefined);
            const additionalWidth = sharedWindow.views.filter(child => child.id !== view.id && windowPrimaryViewId(sharedWindow, child.id) === view.id && !child.collapsed).reduce((total, child) => total + child.width, 0);
            const missing = !!view.binding && missingSessions.has(sessionKey(view.binding));
            return { id: view.id, title: view.binding && !missing ? view.binding.title : t('windows.selectSession'), width: view.width, additionalWidth,
              // A sleeping bot stands folded and dimmed; restoring it wakes it for every device.
              selected: view.id === presentedPrimaryViewId && !workbench.selected, collapsed: view.collapsed || asleepBot(view),
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
                    <strong>{t('windows.selectSession')}</strong>
                    <IconButton icon="close" data-pane-selection-ignore label={t('windows.group.closeLabel', { title: t('windows.selectSession') })} title={t('windows.closeSessionView')}
                      onClick={() => windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id })} />
                  </header><div className="lab-empty-session-body">
                    {view.binding ? <MissingSessionNote title={view.binding.title} host={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId} /> : <p>{t('windows.emptyView')}</p>}
                    <div className="lab-empty-session-actions">
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); showWindowSessionChooser(); }}>{t('windows.chooseSession')}</button>
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); openNewSessionPanel(); }}>{t('windows.newSession')}</button>
                    </div></div></div>,
            };
          }) : [];
  const phoneWorkbench = phone && workbench.bound;
  return <>
        {sharedWindow && phoneWorkbench ? <WorkbenchPhone workbench={workbench} panes={[...storedPanes, ...derived]} openStored={selectPrimaryGroup} />
        : sharedWindow ? <BotWorkbenchBody workbench={workbench}><SessionDockRail compact={compactLayout} stack={phone} onCreateView={createSessionView}
          onSelectPrimaryGroup={id => workbench.owns(id) ? workbench.select(id) : (workbench.clearSelection(), selectPrimaryGroup(id))}
          onResizePrimaryGroup={(viewId, width) => { if (!workbench.owns(viewId)) windowWorkspace.authority?.operate({ type: 'view.resize', viewId, width }); }}
          onCollapsePrimaryGroup={(viewId, collapsed) => {
            if (workbench.owns(viewId)) { workbench.setFolded(viewId, collapsed); return; }
            const view = sharedWindow.views.find(item => item.id === viewId);
            if (!collapsed && view && asleepBot(view)) wakeBot(sharedWindow.id, viewId);
            if (collapsed || view?.collapsed) windowWorkspace.authority?.operate({ type: 'view.collapse', viewId, collapsed });
          }}
          onClosePrimaryGroup={viewId => windowWorkspace.authority?.operate({ type: 'view.close', viewId })}
          onRemovePrimaryGroup={viewId => setRemovingBot({ windowId: sharedWindow.id, viewId })}
          primaryGroups={[...storedPanes, ...derived]} /></BotWorkbenchBody> : <SessionDockRail onCreateView={createSessionView} minimizedHeader={<div ref={setMinimizedViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-minimized-view-slot" />} mainTitle={stackRoot?.title ?? activeOpened?.title} minimumBaseWidth={stackRange.end > stackRange.start ? 640 : 320}><ConversationSplit compact={compactLayout} start={stackRange.start} end={stackRange.end}>
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(0, stackRange.start)} offset={0} onExpand={revealSession} />
        <ConversationPane className="lab-primary-conversation lab-session-composition" data-active={!sessionWindows.activeId || undefined} tabIndex={-1} hidden={!primaryExpanded} onFocusCapture={event => focusPrimaryContent(event.target)} onClickCapture={event => focusPrimaryContent(event.target)}>
        {windowSession.empty ? <div className="lab-empty-session-view" role="status"><p>{t('windows.emptyView')}</p><button type="button" onClick={openNewSessionPanel}>{t('windows.newSession')}</button>{botHandoff ? null : successionProgress}</div> : <><CommunicationNavigationContext.Provider value={primaryCommunication}><LabWorkbench {...primaryNavigation}
          sessionIdentity={stackRoot ?? succession.selected ?? activeOpened}
          operationBinding={succession.binding ? { source: succession.binding.session, historical: navigationIntent.sessionIntent === 'history', scope: { agentId: succession.binding.session.agentId, client: succession.binding.client, replica: succession.binding.replica, transport, recipient: succession.imageRecipient, isCurrent: succession.binding.isCurrent } } : undefined}
          headingMode={compactLayout ? 'toolbar' : 'inline'}
          headingStart={primaryExpanded ? <div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : undefined}
          sessionState={!accessReady || hostOffline ? remoteSessionState(state, !accessReady ? 'connecting' : 'disconnected') : sessionState}
          handoff={handoff}
          draftSessionKey={succession.selected ? sessionKey(succession.selected) : stackRoot ? sessionKey(stackRoot) : activeAgentId}
          draftOnly={succession.active && !succession.isCurrent()}
          opening={!windowWorkspace.unavailable}
          mutationBlocked={primarySuccessionGated}
          onPendingInputChange={reportPendingPrimaryInput}
          pendingFirstInputContext={successionContext && successionContext.state !== 'materialized' ? { state: successionContext.state, onRetry: successionContext.onRetry } : undefined}
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
            localViews={succession.localViews()} activeSlot={succession.desired?.slot.id} onOpenView={view => void openLocalView(view.slotId)} /> : null}<nav className="lab-conversation-history" aria-label={t('windows.history.label')}>
            <button type="button" aria-label={t('windows.history.back')} title={t('common.back')} disabled={transitioning || !conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label={t('windows.history.forward')} title={t('windows.history.forwardHint')} disabled={transitioning || !conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav>{shareSession ? <SessionLink session={shareSession} sessionIntent={navigationIntent.sessionIntent} keepOriginal={navigationIntent.keepOriginal} /> : null}</SessionHeadingActions></>}
          conversationPath={ancestors.length > 0 ? <nav className="lab-conversation-path" aria-label={t('windows.path.label')}>
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
