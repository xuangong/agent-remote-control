import { errorWords } from '@orchardworks/agent-client';
import { tpmMainTarget } from '../kernel/tpm-main-sessions.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { AppInputs } from './types.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { SessionBindingSlice } from './useSessionBinding.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Opening the main session of a TPM work item once its current mapping is confirmed.
export function useTpmMainOpening(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice & SessionBindingSlice, 'accessReadyRef' | 'baseUrl' | 'mountedTransport' | 'sessionEntries' | 'setFailure' | 'tpm' | 'tpmMainRequest' | 'tpmMainState' | 'transport' | 'openSession'>) {
  const { accessReadyRef, baseUrl, mountedTransport, sessionEntries, setFailure, tpm, tpmMainRequest, tpmMainState, transport, openSession } = scope;

  const t = useTranslate();
  async function openTpmMain(item: (typeof tpm.works)[number]): Promise<void> {
    const request = ++tpmMainRequest.current;
    const binding = item.work.mainBinding, ref = item.work.mainSessionRef;
    const target = tpmMainTarget(item);
    const current = () => accessReadyRef.current && tpmMainRequest.current === request && mountedTransport.current === transport
      && tpmMainState.current.scope === baseUrl && tpmMainState.current.transport === transport;
    try {
      if (!current()) throw new Error(t('team.tpm.error.accessRestoring'));
      if (binding?.kind === 'primary_role') {
        if (!ref || !transport.fetchSessionSuccessionCurrent) throw new Error(t('team.tpm.error.mappingUnavailable'));
        const latestRole = await transport.fetchSessionSuccessionCurrent(binding.roleId, { signal: AbortSignal.timeout(15000) });
        if (!current()) return;
        if (latestRole.locator.hostId !== item.hostId || latestRole.role.current.controllerId !== ref.controllerId
          || latestRole.role.current.providerId !== ref.providerId || latestRole.role.current.nativeSessionId !== ref.nativeSessionId) {
          await tpm.refresh();
          if (current()) throw new Error(t('team.tpm.error.mainChanged'));
          return;
        }
      }
      if (!current()) return;
      const host = tpmMainState.current.hosts.find(host => host.id === target.hostId);
      const catalog = target.hostId === 'local' ? tpmMainState.current.providers : host?.providers;
      if ((target.hostId !== 'local' && (!host || !host.online)) || !catalog?.some(provider => provider.providerId === target.providerId)) {
        throw new Error(t('team.tpm.error.providerUnavailable'));
      }
      const title = sessionEntries.find(entry => sessionKey(entry) === sessionKey(target))?.title ?? t('team.tpm.mainSessionDefaultTitle');
      await openSession({ ...target, title });
    } catch (error) { if (current()) setFailure(errorWords(error, t, 'team.tpm.error.mainNotOpened')); }
  }
  return { openTpmMain };
}

export type TpmMainOpeningSlice = ReturnType<typeof useTpmMainOpening>;
