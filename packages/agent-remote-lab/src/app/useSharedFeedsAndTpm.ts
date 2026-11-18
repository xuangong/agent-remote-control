// Shared feeds and drafts, the Team and TPM services and menus.
import { hostProviders } from '../state/creation-choice.js';
import { useSharedDrafts } from '../hooks/useSharedDraft.js';
import { touchWindow } from '../window-recency.js';
import { useSharedFeedsSource } from '../shared-feeds.js';
import { useWindowVisibility } from '../hooks/useWindowVisibility.js';
import { useTeamVisibility } from '../hooks/useTeamVisibility.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import type { SessionEntry } from '../session-tree.js';
import { useTpmVisibility } from '../hooks/useTpmVisibility.js';
import { useTpmWork, type TpmService } from '../hooks/useTpmWork.js';
import { useTpmMainSessions } from '../hooks/useTpmMainSessions.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteHost } from '../components/HostPairing.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { AppInputs } from './types.js';

export function useSharedFeedsAndTpm(scope: Pick<AppInputs & WorkbenchShellSlice & ActiveSessionSlice & SessionSuccessionBindingSlice & RemoteHostStateSlice & ProviderStateSlice & RequestedSessionSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & WorkbenchRecordsSlice, 'accessReady' | 'accessReadyRef' | 'activated' | 'baseUrl' | 'directory' | 'favorites' | 'hostClient' | 'initialState' | 'presentedViewId' | 'providers' | 'remoteHosts' | 'retryHosts' | 'selectHost' | 'selectedBot' | 'selectedHost' | 'sessionEntries' | 'setNewBot' | 'setTeamRoster' | 'sharedWindow' | 'transport' | 'windowMode' | 'windowOverviewAvailable' | 'windowOverviewOpen' | 'windowWorkspace'>) {
  const { accessReady, accessReadyRef, activated, baseUrl, directory, favorites, hostClient, initialState, presentedViewId, providers, remoteHosts, retryHosts, selectHost, selectedBot, selectedHost, sessionEntries, setNewBot, setTeamRoster, sharedWindow, transport, windowMode, windowOverviewAvailable, windowOverviewOpen, windowWorkspace } = scope;

  const askTriggerRef = useRef<HTMLButtonElement>(null);

  const tpmView = useTpmVisibility();

  const teamView = useTeamVisibility();

  const [teamReveal, setTeamReveal] = useState<{ baseUrl: string; teamId: string; requestId: string }>();

  const windowView = useWindowVisibility();

  // Windows and their floating entry show the states of their sessions whenever there is a Window to show.
  const sharedStatesWanted = !windowMode && activated && accessReady || windowOverviewAvailable && windowOverviewOpen
    || windowMode && windowView.visible && !initialState && !windowWorkspace.unavailable && (windowWorkspace.windows.length > 0 || !!windowWorkspace.window);

  // The account's shared IM state: session states with read positions (rows show what is unread, and a conversation on
  // screen is read), drafts that follow the owner to every device, and messages waiting for offline Hosts. Kept outside
  // App's state: its frames render the roster, folded cards and outbox bubbles that show them, not App (stage 6).
  const sharedFeeds = useSharedFeedsSource(transport, { states: sharedStatesWanted, drafts: activated && accessReady, outbox: activated && accessReady });

  // The shared states channel says at once when a Host connects or leaves. The Host list follows it then instead of at
  // its next refresh (up to 30 s on a phone with the sidebar closed), so composers and offline notices change with it.
  const listedHosts = useRef(remoteHosts);
 listedHosts.current = remoteHosts;

  const sharedHostFlags = useRef('');

  useEffect(() => sharedFeeds.subscribe(() => {
    const states = sharedFeeds.get().states;
    if (!states) return;
    const flags = JSON.stringify(listedHosts.current.map(host => [host.id, states.host(host.id)?.online]));
    if (flags === sharedHostFlags.current) return;
    sharedHostFlags.current = flags;
    if (listedHosts.current.some(host => { const shared = states.host(host.id); return !!shared && shared.online !== (host.online === true); })) retryHosts();
  }), [sharedFeeds, retryHosts]);

  const sharedDrafts = useSharedDrafts(sharedFeeds, transport);

  const updateTeamRoster = useCallback((baseUrl: string, teams: Team[]) => setTeamRoster({ baseUrl, teams }), []);

  const [tpmListOpen, setTpmListOpen] = useState(false);

  // Most recent use orders the Window overview; a page in front counts as using its Window.
  useEffect(() => {
    const id = sharedWindow?.id;
    if (!windowMode || !id) return;
    const use = () => { if (document.visibilityState === 'visible') touchWindow(baseUrl, id); };
    use();
    window.addEventListener('focus', use); document.addEventListener('visibilitychange', use);
    return () => { window.removeEventListener('focus', use); document.removeEventListener('visibilitychange', use); };
  }, [baseUrl, sharedWindow?.id, windowMode]);

  const tpmTriggerRef = useRef<HTMLButtonElement>(null);

  const candidateTpmService = hostClient as Partial<TpmService>;

  const tpmService = candidateTpmService.tpmList && candidateTpmService.tpmWork && candidateTpmService.tpmCreate && candidateTpmService.tpmAction ? candidateTpmService as TpmService : undefined;

  // The Hosts a session can run on: the Lab server itself when it has local providers, then the paired Hosts.
  const selectableHosts = useMemo(() => providers.length > 0 ? [{ id: 'local', name: 'Lab server', online: true }, ...remoteHosts] : remoteHosts, [providers.length, remoteHosts]);


  /**
   * Opens New bot where a new bot most likely belongs: the Host and provider of the selected bot, else the selected Host,
   * else the first online Host with a provider.
   */
  function openNewBot() {
    const usable = (host: RemoteHost) => host.online !== false && (host.id === 'local' ? providers.length > 0 : hostProviders(host).length > 0);
    const like = !windowMode ? selectedBot.view?.binding : undefined;
    const likeHost = like && selectableHosts.find(host => host.id === (like.hostId ?? 'local') && usable(host as RemoteHost));
    const current = selectableHosts.find(host => host.id === selectedHost.id);
    if (likeHost) selectHost(likeHost as RemoteHost, like.providerId);
    else if (!current || !usable(current as RemoteHost)) {
      const first = selectableHosts.find(host => usable(host as RemoteHost));
      if (first) selectHost(first as RemoteHost);
    }
    setNewBot({ open: true });
  }

  const attachTpm = useCallback(async (item: SessionEntry): Promise<OpenedSession> => {
    if (!accessReadyRef.current) throw new Error('Workspace access is restoring.');
    const target = new SessionDirectoryClient(baseUrl, undefined, item.hostId ?? 'local');
    const attached = await target.attach(item.providerId, item.nativeSessionId);
    return { hostId: item.hostId, providerId: item.providerId, nativeSessionId: attached.nativeSessionId ?? item.nativeSessionId, title: item.title, agentId: attached.agentId };
  }, [baseUrl]);

  // TPM runs on Controllers, so only paired Hosts are asked for TPM works; the Lab server has none.
  const tpm = useTpmWork(tpmService, remoteHosts, accessReady && !!directory, attachTpm, tpmView.visible, baseUrl, windowWorkspace.authority,
    sharedWindow && presentedViewId ? { windowId: sharedWindow.id, viewId: presentedViewId } : undefined, tpmListOpen);

  const tpmMainSessions = useTpmMainSessions(baseUrl, accessReady, tpmView.visible && (tpmListOpen || tpm.expanded), tpm.works, [...favorites.stars, ...sessionEntries], transport);

  const tpmMainState = useRef({ scope: baseUrl, transport, hosts: remoteHosts, providers, works: tpm.works });

  tpmMainState.current = { scope: baseUrl, transport, hosts: remoteHosts, providers, works: tpm.works };

  const tpmMainRequest = useRef(0);
  return { askTriggerRef, tpmView, teamView, teamReveal, setTeamReveal, windowView, sharedFeeds, sharedDrafts, updateTeamRoster, tpmListOpen, setTpmListOpen, tpmTriggerRef, selectableHosts, openNewBot, tpm, tpmMainSessions, tpmMainState, tpmMainRequest };
}

export type SharedFeedsAndTpmSlice = ReturnType<typeof useSharedFeedsAndTpm>;
