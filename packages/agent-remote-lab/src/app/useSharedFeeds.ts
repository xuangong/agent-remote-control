// Shared feeds and drafts, the Team roster and the New bot entry.
import { hostProviders } from '../features/sessions/creation-choice.js';
import { useSharedDrafts } from '../conversation/useSharedDraft.js';
import { touchWindow } from '../features/windows/window-recency.js';
import { useSharedFeedsSource } from '../kernel/shared-feeds.js';
import { useWindowVisibility } from '../kernel/useWindowVisibility.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { useTeamRoster } from '../kernel/useTeamRoster.js';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { RemoteHost } from '../kernel/remote-host.js';
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

export function useSharedFeeds(scope: Pick<AppInputs & WorkbenchShellSlice & ActiveSessionSlice & SessionSuccessionBindingSlice & RemoteHostStateSlice & ProviderStateSlice & RequestedSessionSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & WorkbenchRecordsSlice, 'accessReady' | 'activated' | 'baseUrl' | 'directory' | 'initialState' | 'providers' | 'remoteHosts' | 'retryHosts' | 'selectHost' | 'selectedBot' | 'selectedHost' | 'setNewBot' | 'setTeamRoster' | 'sharedWindow' | 'teamRoster' | 'transport' | 'windowMode' | 'windowOverviewAvailable' | 'windowOverviewOpen' | 'windowWorkspace'>) {
  const { accessReady, activated, baseUrl, directory, initialState, providers, remoteHosts, retryHosts, selectHost, selectedBot, selectedHost, setNewBot, setTeamRoster, sharedWindow, teamRoster, transport, windowMode, windowOverviewAvailable, windowOverviewOpen, windowWorkspace } = scope;

  const t = useTranslate();
  const askTriggerRef = useRef<HTMLButtonElement>(null);

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

  const updateTeamRoster = useCallback((baseUrl: string, teams: Team[]) => setTeamRoster(current => ({ baseUrl, teams, ...(current?.baseUrl === baseUrl && current.tasks ? { tasks: current.tasks } : {}) })), []);
  const updateTaskRoster = useCallback((baseUrl: string, tasks: Team[]) => setTeamRoster(current => ({ baseUrl, teams: current?.baseUrl === baseUrl ? current.teams : [], tasks })), []);

  const rosterTeams = teamRoster?.baseUrl === baseUrl ? teamRoster.teams : undefined;
  useTeamRoster({ baseUrl, enabled: accessReady && !!directory, teams: rosterTeams,
    publish: (baseUrl, teams, tasks) => { updateTeamRoster(baseUrl, teams); updateTaskRoster(baseUrl, tasks); } });

  // Most recent use orders the Window overview; a page in front counts as using its Window.
  useEffect(() => {
    const id = sharedWindow?.id;
    if (!windowMode || !id) return;
    const use = () => { if (document.visibilityState === 'visible') touchWindow(baseUrl, id); };
    use();
    window.addEventListener('focus', use); document.addEventListener('visibilitychange', use);
    return () => { window.removeEventListener('focus', use); document.removeEventListener('visibilitychange', use); };
  }, [baseUrl, sharedWindow?.id, windowMode]);

  // The Hosts a session can run on: the Lab server itself when it has local providers, then the paired Hosts.
  const selectableHosts = useMemo(() => providers.length > 0 ? [{ id: 'local', name: t('team.host.labServer'), online: true }, ...remoteHosts] : remoteHosts, [providers.length, remoteHosts, t]);


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

  return { askTriggerRef, windowView, sharedFeeds, sharedDrafts, updateTeamRoster, updateTaskRoster, selectableHosts, openNewBot };
}

export type SharedFeedsSlice = ReturnType<typeof useSharedFeeds>;
