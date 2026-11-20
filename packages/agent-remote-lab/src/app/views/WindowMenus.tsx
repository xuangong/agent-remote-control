// The session transfer dialog and the Window overview; the Window entry moves with the shortcuts (see ShortcutSlots).
import { WindowOverview } from '../../components/WindowOverview.js';
import { SessionTransferDialog } from '../../components/SessionLink.js';
import type { AppScope } from '../types.js';

export function WindowMenus({ scope }: { readonly scope: Pick<AppScope, 'baseUrl' | 'openScannedSession' | 'scanOpen' | 'setScanOpen' | 'setWindowOverviewOpen' | 'windowMode' | 'windowOverviewAvailable' | 'windowOverviewOpen' | 'windowSessionStatus' | 'windowWorkspace'> }) {
  const { baseUrl, openScannedSession, scanOpen, setScanOpen, setWindowOverviewOpen, windowMode, windowOverviewAvailable, windowOverviewOpen, windowSessionStatus, windowWorkspace } = scope;
  return <>
    {windowMode && scanOpen ? <SessionTransferDialog onOpen={openScannedSession} onClose={() => setScanOpen(false)} /> : null}
    <WindowOverview workspace={windowWorkspace} scope={baseUrl} enabled={windowOverviewAvailable} open={windowMode && windowOverviewOpen} sessionStatus={windowSessionStatus} onOpenChange={setWindowOverviewOpen} />
  </>;
}
