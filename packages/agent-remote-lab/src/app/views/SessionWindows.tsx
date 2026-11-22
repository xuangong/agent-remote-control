// The floating session windows.
import { TeamGatherButton } from '../../features/team/TeamGatherButton.js';
import { SessionWindow } from '../../features/windows/SessionWindow.js';
import { SessionFamily } from '../../conversation/SessionFamily.js';
import { sessionKey } from '../../kernel/session-tree.js';
import type { AppScope } from '../types.js';

export function SessionWindows({ scope }: { readonly scope: Pick<AppScope, 'activeView' | 'baseUrl' | 'chooseWindowSession' | 'compactLayout' | 'markSessionMissing' | 'messageDrafts' | 'missingSessions' | 'presentSessionView' | 'presentedRootView' | 'receiveViewSession' | 'remoteHosts' | 'sessionWindows' | 'sharedWindow' | 'supportingRailOpen' | 'transport' | 'viewNavigation' | 'windowDraftBinding' | 'windowMode' | 'windowPaneFolding'> }) {
  const { activeView, baseUrl, chooseWindowSession, compactLayout, markSessionMissing, messageDrafts, missingSessions, presentSessionView, presentedRootView, receiveViewSession, remoteHosts, sessionWindows, sharedWindow, supportingRailOpen, transport, viewNavigation, windowDraftBinding, windowMode, windowPaneFolding } = scope;
  return <>
        <div className="lab-session-windows">{sessionWindows.entries.map(entry => <SessionWindow key={entry.id} entry={entry} baseUrl={baseUrl}
          // Not windowStageVisible: `visible` also decides docking (a hidden view leaves the dock) and, through SessionFamily, keeps the
          // conversation attached. The sessions page hides #lab-workbench instead, and visibleWindows leaves these views unseen.
          visible={windowMode && activeView === 'workbench' && !supportingRailOpen && (!compactLayout || (sharedWindow ? presentedRootView?.id : sessionWindows.selectedId) === entry.id)} compact={compactLayout}
          closeWith={sessionWindows.entries.filter(child => child.closeWith === entry.id).map(child => child.id)}
          selected={sessionWindows.selectedId === entry.id} onFocus={() => sessionWindows.focus(sharedWindow ? entry.id : entry.managed ? undefined : entry.id)}
          onChangeSession={entry.managed ? undefined : () => chooseWindowSession(entry.id)}
          hostLabel={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.name ?? entry.target.hostId : ''}
          offline={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.online === false : false}
          actions={entry.groupId ? <TeamGatherButton baseUrl={baseUrl} entry={entry} onGather={targets => sessionWindows.gather(entry, targets)} /> : undefined}
          onSessionBound={entry.managed ? undefined : receiveViewSession}
          missing={!!entry.target && missingSessions.has(sessionKey(entry.target))} onSessionUnavailable={markSessionMissing}
          sessionPresentation={context => presentSessionView(context, { team: !!entry.groupId || !!entry.teamMemberId })}
          transport={transport} draftStore={messageDrafts} {...windowDraftBinding(entry)} navigation={viewNavigation} onClose={() => sessionWindows.close(entry.id)}
          {...windowPaneFolding(entry.id)} />)}</div>
  </>;
}
