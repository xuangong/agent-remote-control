import { watchPagePolling } from '../client/page-polling.js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { HttpPreviewClient, PinnedPreviewName, PreviewRegistration, PreviewRegistrationRequest } from '../client/preview-client.js';
import type { PreviewController } from './PreviewActions.js';
import { previewRegistrationKey, usePreviewRenewal } from './usePreviewRenewal.js';
import { PreviewBrowser } from './PreviewBrowser.js';
import { PreviewWorkspaceContext } from './PreviewWorkspace.js';

export interface PreviewContextValue extends PreviewController {
  readonly loading: boolean;
  readonly error?: string;
  refresh(): Promise<void>;
}

const Context = createContext<PreviewContextValue | undefined>(undefined);

interface BrowserEntry {
  version: number; key: string; id: string; sessionId: string; target: string;
  hostId?: string; registration?: PreviewRegistration;
  url?: string; error?: string; returnFocus?: HTMLElement;
}
const DockContext = createContext<{
  browsers: readonly BrowserEntry[]; activeKey?: string;
  resume(key: string): void; close(key: string): void;
} | undefined>(undefined);


export function PreviewProvider({ client, hostId, canManage, polling = true, children }: {
  readonly client: HttpPreviewClient; readonly hostId: string; readonly canManage: boolean; readonly polling?: boolean; readonly children: ReactNode;
}) {
  const scopeRef = useRef({ client, hostId, version: 0, request: 0 });
  if (scopeRef.current.client !== client || scopeRef.current.hostId !== hostId) {
    scopeRef.current = { client, hostId, version: scopeRef.current.version + 1, request: 0 };
  }
  const scope = scopeRef.current;
  const [state, setState] = useState<{ version: number; routing?: 'subdomain' | 'path'; registrations: readonly PreviewRegistration[]; pinnedNames?: readonly PinnedPreviewName[]; loading: boolean; error?: string }>(
    { version: scope.version, registrations: [], loading: true },
  );
  const currentState = state.version === scope.version ? state : { version: scope.version, registrations: [], loading: true };
  const [browsers, setBrowsers] = useState<BrowserEntry[]>([]);
  const browserEntries = useRef<BrowserEntry[]>([]);
  const updateBrowsers = useCallback((update: (current: BrowserEntry[]) => BrowserEntry[]) => {
    browserEntries.current = update(browserEntries.current);
    setBrowsers(browserEntries.current);
  }, []);
  const [activeKey, setActiveKey] = useState<string>();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const requests = useMemo(() => new Map<string, AbortController>(), [scope]);
  const snapshots = useMemo(() => new Map<AbortController, ReturnType<typeof setTimeout>>(), [scope]);
  const currentBrowsers = browsers.filter(entry => entry.version === scope.version);
  const closeBrowser = useCallback((key: string) => {
    requests.get(key)?.abort(); requests.delete(key);
    updateBrowsers(current => current.filter(entry => entry.key !== key));
    setActiveKey(current => current === key ? undefined : current);
  }, [requests, updateBrowsers]);
  const resumeBrowser = useCallback((key: string) => setActiveKey(key), []);
  const minimizeBrowser = useCallback(() => setActiveKey(undefined), []);
  useEffect(() => {
    updateBrowsers(current => current.filter(entry => entry.version === scope.version));
    setActiveKey(undefined);
    return () => { for (const request of requests.values()) request.abort(); };
  }, [requests, scope.version, updateBrowsers]);

  const refresh = useCallback(async () => {
    const request = ++scope.request;
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Preview state refresh timed out. Retrying automatically.'));
    }, 12_000);
    snapshots.set(controller, deadline);
    try {
      const snapshot = await client.snapshot(hostId, controller.signal);
      if (!controller.signal.aborted && scopeRef.current === scope && scope.request === request) {
        setState(previous => previous.version === scope.version && !previous.loading && !previous.error
          && JSON.stringify(previous.pinnedNames) === JSON.stringify(snapshot.pinnedNames)
          && previous.routing === snapshot.routing && JSON.stringify(previous.registrations) === JSON.stringify(snapshot.registrations) ? previous
          : { version: scope.version, registrations: snapshot.registrations, pinnedNames: snapshot.pinnedNames, routing: snapshot.routing, loading: false });
      }
    } catch (cause) {
      if ((!controller.signal.aborted || timedOut) && scopeRef.current === scope && scope.request === request) {
        setState(current => ({
          version: scope.version,
          registrations: current.version === scope.version ? current.registrations : [],
          pinnedNames: current.version === scope.version ? current.pinnedNames : undefined,
          routing: current.version === scope.version ? current.routing : undefined,
          loading: false,
          error: message(cause, 'Preview state is unavailable. Retry after checking the Host connection.'),
        }));
      }
    } finally {
      clearTimeout(deadline);
      snapshots.delete(controller);
    }
  }, [client, hostId, scope, snapshots]);

  useEffect(() => {
    setState({ version: scope.version, registrations: [], loading: true });
    return () => {
      scope.request++;
      for (const [controller, deadline] of snapshots) {
        clearTimeout(deadline);
        controller.abort();
      }
      snapshots.clear();
    };
  }, [scope, snapshots]);
  const pollingInterval = polling || currentBrowsers.length > 0 ? 5_000 : 30_000;
  useEffect(() => watchPagePolling(refresh, pollingInterval), [refresh, pollingInterval]);

  const renewalIssues = usePreviewRenewal(client, hostId, canManage, currentBrowsers, currentState.registrations, refresh);

  const value = useMemo<PreviewContextValue>(() => ({
    registrations: currentState.registrations, pinnedNames: currentState.pinnedNames, routing: currentState.routing, canManage, loading: currentState.loading, error: currentState.error, refresh,
    register: async (agentId: string, request: PreviewRegistrationRequest) => {
      const registration = await client.register(agentId, request);
      // Registration can finish before the Controller's data tunnel connects.
      const signal = AbortSignal.timeout(10_000);
      while (!signal.aborted) {
        if (scopeRef.current !== scope) throw new Error('The preview Host changed. Retry from the current Host.');
        const snapshot = await client.snapshot(hostId, signal).catch(error => { if (!signal.aborted) throw error; });
        if (!snapshot) break;
        const ready = snapshot.registrations.find(value => value.id === registration.id && value.status === 'active' && value.availability === 'online' && !value.pendingUnregister);
        if (ready) { await refresh(); return registration; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('The preview is registered, but its tunnel is still connecting. Open it again shortly.');
    },
    unpinName: async nameId => { await client.unpinName(hostId, nameId); await refresh(); },
    pinName: async (id, pinned) => { await client.pinName(hostId, id, pinned); await refresh(); },
    unregister: async (id: string, remoteHostId?: string) => {
      await client.unregister(remoteHostId ?? hostId, id);
      if (scopeRef.current === scope) updateBrowsers(current => current.map(entry => entry.id === id && entry.version === scope.version
        && (entry.hostId ?? hostId) === (remoteHostId ?? hostId)
        ? { ...entry, error: 'This preview has been unregistered.' } : entry));
      await refresh();
    },
    getTunnelUrl: async (id: string, target: string) => {
      if (scopeRef.current !== scope) throw new Error('The preview Host changed. Retry from the current Host.');
      const url = await client.tunnelUrl(hostId, id, target, AbortSignal.timeout(20_000));
      if (scopeRef.current !== scope) throw new Error('The preview Host changed. Retry from the current Host.');
      return url;
    },
    open: async (id: string, target: string, agentId?: string, remote?: { hostId: string; registration: PreviewRegistration }) => {
      if (scopeRef.current !== scope) return '';
      const sessionId = agentId ?? remote?.registration.sources[0]?.sessionId ?? currentState.registrations.find(entry => entry.id === id)?.sources[0]?.sessionId ?? '';
      const key = JSON.stringify([scope.version, remote?.hostId ?? hostId, sessionId, id, target]);
      const existing = browserEntries.current.find(entry => entry.key === key);
      if (existing) { setActiveKey(key); return existing.url ?? ''; }
      const request = new AbortController(); requests.set(key, request);
      const entry: BrowserEntry = { version: scope.version, key, id, sessionId, target, ...(remote ? { hostId: remote.hostId, registration: remote.registration } : {}),
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined };
      updateBrowsers(current => [...current.filter(item => item.version === scope.version && item.key !== key), entry]);
      setActiveKey(key);
      const update = (result: Partial<BrowserEntry>) => {
        if (scopeRef.current === scope && requests.get(key) === request) {
          updateBrowsers(current => current.map(item => item.key === key ? { ...item, ...result } : item));
        }
      };
      const deadline = window.setTimeout(() => {
        if (!request.signal.aborted) { update({ error: 'Preview access timed out. Close and open it again.' }); request.abort(); }
      }, 20_000);
      try {
        const handoff = await client.open(remote?.hostId ?? hostId, id, target, request.signal);
        if (request.signal.aborted) return '';
        const url = await client.enter(handoff, id, request.signal);
        if (!request.signal.aborted) update({ url });
        return url;
      } catch (error) {
        if (!request.signal.aborted) update({ error: message(error, 'Preview access is unavailable. Close and open it again.') });
        return '';
      } finally { window.clearTimeout(deadline); if (requests.get(key) === request) requests.delete(key); }
    },
  }), [canManage, client, currentState, hostId, refresh, scope, requests, updateBrowsers]);

  return <Context.Provider value={value}><DockContext.Provider value={{ browsers: currentBrowsers, activeKey, resume: resumeBrowser, close: closeBrowser }}>
    <PreviewWorkspaceContext.Provider value={{ open: currentBrowsers.some(entry => entry.key === activeKey), setContainer, hide: minimizeBrowser }}>
    {children}
    {currentBrowsers.map(browser => {
      const selected = browser.registration ?? currentState.registrations.find(item => item.id === browser.id);
      const renewal = renewalIssues[previewRegistrationKey(browser.hostId ?? hostId, browser.id)];
      const unavailable = selected?.pendingUnregister || selected?.status === 'unregistered' ? 'This preview has been unregistered.'
        : renewal?.terminal ? renewal.message
        : !selected && !currentState.loading && !canManage ? 'This preview registration is no longer available. Close and open it again.' : undefined;
      const notice = renewal?.message ?? (!selected || selected.status === 'expired' ? 'Renewing preview registration…'
        : selected.availability !== 'online' ? 'Controller offline. The preview will reconnect automatically.' : undefined);
      return <PreviewBrowser container={container} key={browser.key} browserKey={browser.key} visible={activeKey === browser.key}
        url={browser.url} target={browser.target} notice={notice} error={unavailable ?? browser.error} returnFocus={browser.returnFocus}
        onMinimize={minimizeBrowser} onClose={() => closeBrowser(browser.key)} />;
    })}
  </PreviewWorkspaceContext.Provider></DockContext.Provider></Context.Provider>;
}

export function PreviewDock({ sessionId }: { readonly sessionId?: string }) {
  const context = useContext(DockContext);
  const entries = context?.browsers.filter(entry => entry.sessionId === sessionId && entry.key !== context.activeKey) ?? [];
  if (!context || entries.length === 0) return null;
  return <aside className="agent-preview-dock" aria-label="Session previews">
    {entries.map(entry => <span className="agent-preview-dock-entry" key={entry.key}>
      <button type="button" data-preview-key={entry.key} aria-label={`Resume preview: ${entry.target}`} title={`Resume preview: ${entry.target}`}
        onClick={() => context.resume(entry.key)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>
        <span>{new URL(entry.target).host}</span>
      </button>
      <button type="button" aria-label={`Close preview: ${entry.target}`} title="Close preview" onClick={() => context.close(entry.key)}>×</button>
    </span>)}
  </aside>;
}

export function usePreviewController(): PreviewContextValue | undefined { return useContext(Context); }

function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
