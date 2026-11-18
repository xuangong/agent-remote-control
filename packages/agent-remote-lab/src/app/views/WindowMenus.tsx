// The session transfer dialog, the Window menu and the Window overview.
import { WindowMenu } from '../../components/WindowMenu.js';
import { WindowOverview } from '../../components/WindowOverview.js';
import { SessionTransferDialog } from '../../components/SessionLink.js';
import type { AppScope } from '../types.js';

export function WindowMenus({ scope }: { readonly scope: Pick<AppScope, 'baseUrl' | 'confirmBotRemoval' | 'menuCurrentBinding' | 'openScannedSession' | 'scanOpen' | 'setScanOpen' | 'setWindowOverviewOpen' | 'sidebarShortcuts' | 'supportTeams' | 'supportingRailOpen' | 'windowMode' | 'windowOverviewAvailable' | 'windowOverviewOpen' | 'windowSessionStatus' | 'windowView' | 'windowWorkspace'> }) {
  const { baseUrl, confirmBotRemoval, menuCurrentBinding, openScannedSession, scanOpen, setScanOpen, setWindowOverviewOpen, sidebarShortcuts, supportTeams, supportingRailOpen, windowMode, windowOverviewAvailable, windowOverviewOpen, windowSessionStatus, windowView, windowWorkspace } = scope;
  return <>
    {windowMode && scanOpen ? <SessionTransferDialog onOpen={openScannedSession} onClose={() => setScanOpen(false)} /> : null}
    <WindowMenu workspace={windowWorkspace} current={menuCurrentBinding}
      visible={windowMode && windowView.visible && !sidebarShortcuts} inert={supportingRailOpen} onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} sessionStatus={windowSessionStatus}
      supportTeam={teamId => supportTeams.has(teamId)} onRemoveView={confirmBotRemoval} />
    <WindowOverview workspace={windowWorkspace} scope={baseUrl} enabled={windowOverviewAvailable} open={windowMode && windowOverviewOpen} sessionStatus={windowSessionStatus} onOpenChange={setWindowOverviewOpen} />
  </>;
}
