// The Workbench mode, page visibility, access readiness and the Relay transport.
import { useWorkbenchMode } from '../kernel/useWorkbenchMode.js';
import { stopLayoutDiagnostics } from '../kernel/layout-diagnostics.js';
import { RelayLinkReport, WorkspaceReady, workspaceFetch, workspaceSocket } from '../kernel/workspace-access.js';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HttpWebSocketTransport } from '@orchardworks/agent-client';
import { ReadingPositions } from '../kernel/conversation-recovery.js';
import { useVisualViewport } from '../kernel/useVisualViewport.js';
import { arrangeFloatingEntries } from '../kernel/useTrackingPosition.js';
import type { LabTransport } from './types.js';
import type { AppInputs } from './types.js';

export function useWorkbenchShell(scope: Pick<AppInputs, 'baseUrl' | 'injectedTransport'>) {
  const { baseUrl, injectedTransport } = scope;

  const navigation = useWorkbenchMode(baseUrl);

  const windowMode = navigation.mode === 'window';

  const windowModeRef = useRef(windowMode);
 windowModeRef.current = windowMode;

  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const accessReady = useContext(WorkspaceReady);

  const [activated, setActivated] = useState(accessReady);

  useEffect(() => { if (accessReady) setActivated(true); }, [accessReady]);

  const accessReadyRef = useRef(accessReady);
 accessReadyRef.current = accessReady;

  const shellRef = useVisualViewport(arrangeFloatingEntries);

  useEffect(() => () => stopLayoutDiagnostics('unmount'), []);

  const readingPositions = useMemo(() => new ReadingPositions(baseUrl), [baseUrl]);

  const transport = useMemo<LabTransport>(() => injectedTransport
    ?? new HttpWebSocketTransport(baseUrl, { sessionChannels: true, sessionSuccessions: true, fetch: workspaceFetch, webSocketFactory: workspaceSocket }) as LabTransport, [baseUrl, injectedTransport]);

  const mountedTransport = useRef<LabTransport>();

  useEffect(() => {
    mountedTransport.current = transport;
    return () => {
      mountedTransport.current = undefined;
      // StrictMode immediately reuses this transport after its effect cleanup probe.
      if (!injectedTransport) queueMicrotask(() => {
        if (mountedTransport.current !== transport) (transport as HttpWebSocketTransport).dispose();
      });
    };
  }, [transport, injectedTransport]);
  const relayLink = useContext(RelayLinkReport);
  useEffect(() => {
    if (!transport.relayLink || !transport.subscribeRelayLink) return;
    relayLink.report(transport.relayLink());
    const stop = transport.subscribeRelayLink(relayLink.report);
    relayLink.setReopen(transport.reopenRelayLink ? () => transport.reopenRelayLink!() : undefined);
    return () => { stop(); relayLink.report('unknown'); relayLink.setReopen(undefined); };
  }, [transport, relayLink]);
  return { navigation, windowMode, windowModeRef, pageVisible, accessReady, activated, accessReadyRef, shellRef, readingPositions, transport, mountedTransport };
}

export type WorkbenchShellSlice = ReturnType<typeof useWorkbenchShell>;
