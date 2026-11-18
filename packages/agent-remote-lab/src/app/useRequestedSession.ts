// Favorites, confirmed titles, the session the link requests and the selected Host.
import { parseWorkbenchRoute } from '../workbench-mode.js';
import { workspaceFetch } from '../workspace-access.js';
import { useStoredDisplay } from '../hooks/useStoredDisplay.js';
import { useSessionStars } from '../hooks/useSessionStars.js';
import type { StarInput } from '../session-stars-client.js';
import { readControllerLocation, type ControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { useCallback, useMemo, useRef, useState } from 'react';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { readLastSession } from '../conversation-recovery.js';
import type { RemoteHost } from '../components/HostPairing.js';
import { RemoteHostClient, SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { readCurrentConversationLayout } from '../hooks/useConversationHistory.js';
import { sessionKey } from '../session-tree.js';
import { HttpVscodeTunnelClient } from '../vscode-tunnel.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useRequestedSession(scope: Pick<AppInputs & WorkbenchShellSlice, 'accessReady' | 'activated' | 'baseUrl' | 'hostService' | 'initialState' | 'injectedDirectory' | 'injectedTransport' | 'transport' | 'userScoped'>) {
  const { accessReady, activated, baseUrl, hostService, initialState, injectedDirectory, injectedTransport, transport, userScoped } = scope;

  const favorites = useSessionStars(baseUrl, userScoped && accessReady, transport);

  const [renamingSession, setRenamingSession] = useState<{ scope: string; session: StarInput }>();

  const [confirmedTitleState, setConfirmedTitleState] = useState<{ scope: string; titles: ReadonlyMap<string, string> }>();

  const confirmedTitles = confirmedTitleState?.scope === baseUrl ? confirmedTitleState.titles : undefined;

  const withConfirmedTitle = useCallback((session: OpenedSession): OpenedSession => {
    const title = confirmedTitles?.get(sessionKey(session));
    return title !== undefined && title !== session.title ? { ...session, title } : session;
  }, [confirmedTitles]);

  const [requested] = useState<{ target?: ControllerLocation; error?: string }>(() => {
    try {
      if (parseWorkbenchRoute(new URL(location.href))?.mode === 'bot') return {};
      const target = readControllerLocation(new URLSearchParams(window.location.search));
      return { target: Object.keys(target).length ? target : readLastSession(baseUrl) };
    }
    catch { return { error: 'Invalid session link.' }; }
  });

  const [initialLayout] = useState(() => readCurrentConversationLayout(baseUrl));

  // The rows this device stored of the requested conversation, from the first frame the Relay has confirmed this person's lease.
  const cachedState = useStoredDisplay(baseUrl, requested.target);

  const requestedHostId = requested.target?.hostId;

  const [selectedHost, setSelectedHost] = useState<RemoteHost>(() => requestedHostId
    ? { id: requestedHostId, name: 'Requested Host', online: false, providers: [], providerId: '' }
    : { id: 'local', name: 'Recorded fixture', online: true });

  const vscodeTunnelClient = useMemo(() => new HttpVscodeTunnelClient(baseUrl), [baseUrl]);

  const hostClient = useMemo(() => hostService ?? new RemoteHostClient(baseUrl), [baseUrl, hostService]);

  const previewClient = useMemo(() => new HttpPreviewClient(baseUrl, workspaceFetch), [baseUrl]);

  const directory = useMemo(() => !activated ? undefined : injectedDirectory ?? (!injectedTransport && !initialState ? new SessionDirectoryClient(baseUrl, undefined, selectedHost.id) : undefined), [baseUrl, injectedDirectory, injectedTransport, initialState, selectedHost.id, activated]);

  const restoredHostSelection = useRef(false);
  return { favorites, renamingSession, setRenamingSession, setConfirmedTitleState, confirmedTitles, withConfirmedTitle, requested, initialLayout, cachedState, requestedHostId, selectedHost, setSelectedHost, vscodeTunnelClient, hostClient, previewClient, directory, restoredHostSelection };
}

export type RequestedSessionSlice = ReturnType<typeof useRequestedSession>;
