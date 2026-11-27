// The session transfer dialog and the Window overview; the Window entry moves with the shortcuts (see ShortcutSlots).
import { WindowOverview } from '../../features/windows/WindowOverview.js';
import { SessionTransferDialog } from '../../kernel/SessionLink.js';
import type { AppScope } from '../types.js';

export function WindowMenus({ scope }: { readonly scope: Pick<AppScope, 'baseUrl' | 'openScannedSession' | 'startSessionUse' | 'scanOpen' | 'setScanOpen' | 'setWindowOverviewOpen' | 'windowMode' | 'windowOverviewAvailable' | 'windowOverviewOpen' | 'windowSessionStatus' | 'windowWorkspace'> }) {
  const { baseUrl, openScannedSession, startSessionUse, scanOpen, setScanOpen, setWindowOverviewOpen, windowMode, windowOverviewAvailable, windowOverviewOpen, windowSessionStatus, windowWorkspace } = scope;
  return <>
    {windowMode && scanOpen ? <SessionTransferDialog onOpen={async ({ sessionUse, ...target }) => {
      // A link that asks for a bot is confirmed first; the scanner has done its part.
      if (sessionUse) { startSessionUse({ session: target, use: sessionUse }); return true; }
      return openScannedSession(target);
    }} onClose={() => setScanOpen(false)} /> : null}
    <WindowOverview workspace={windowWorkspace} scope={baseUrl} enabled={windowOverviewAvailable} open={windowMode && windowOverviewOpen} sessionStatus={windowSessionStatus} onOpenChange={setWindowOverviewOpen} />
  </>;
}
