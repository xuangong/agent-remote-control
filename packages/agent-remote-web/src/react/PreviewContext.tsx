import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { HttpPreviewClient, PreviewRegistration, PreviewRegistrationRequest } from '../client/preview-client.js';
import type { PreviewController } from './PreviewActions.js';
import { usePreviewRenewal } from './usePreviewRenewal.js';
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
  url?: string; error?: string; returnFocus?: HTMLElement;
}
const DockContext = createContext<{
  browsers: readonly BrowserEntry[]; activeKey?: string;
  resume(key: string): void; close(key: string): void;
} | undefined>(undefined);


export function PreviewProvider({ client, hostId, canManage, children }: {
  readonly client: HttpPreviewClient; readonly hostId: string; readonly canManage: boolean; readonly children: ReactNode;
}) {
  const scopeRef = useRef({ client, hostId, version: 0, request: 0 });
  if (scopeRef.current.client !== client || scopeRef.current.hostId !== hostId) {
    scopeRef.current = { client, hostId, version: scopeRef.current.version + 1, request: 0 };
  }
  const scope = scopeRef.current;
  const [state, setState] = useState<{ version: number; registrations: readonly PreviewRegistration[]; loading: boolean; error?: string }>(
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
    try {
      const snapshot = await client.snapshot(hostId);
      if (scopeRef.current === scope && scope.request === request) {
        setState({ version: scope.version, registrations: snapshot.registrations, loading: false });
      }
    } catch (cause) {
      if (scopeRef.current === scope && scope.request === request) {
        setState(current => ({
          version: scope.version,
          registrations: current.version === scope.version ? current.registrations : [],
          loading: false,
          error: message(cause, 'Preview state is unavailable. Retry after checking the Host connection.'),
        }));
      }
    }
  }, [client, hostId, scope]);

  useEffect(() => {
    setState({ version: scope.version, registrations: [], loading: true });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh, scope.version]);

  const renewalIssues = usePreviewRenewal(client, hostId, canManage, currentBrowsers, currentState.registrations, refresh);

  const value = useMemo<PreviewContextValue>(() => ({
    registrations: currentState.registrations, canManage, loading: currentState.loading, error: currentState.error, refresh,
    register: async (agentId: string, request: PreviewRegistrationRequest) => {
      const registration = await client.register(agentId, request);
      await refresh();
      return registration;
    },
    unregister: async (id: string) => {
      await client.unregister(hostId, id);
      if (scopeRef.current === scope) updateBrowsers(current => current.map(entry => entry.id === id && entry.version === scope.version
        ? { ...entry, error: 'This preview has been unregistered.' } : entry));
      await refresh();
    },
    open: async (id: string, target: string, agentId?: string) => {
      if (scopeRef.current !== scope) return '';
      const sessionId = agentId ?? currentState.registrations.find(entry => entry.id === id)?.sources[0]?.sessionId ?? '';
      const key = JSON.stringify([scope.version, sessionId, id, target]);
      const existing = browserEntries.current.find(entry => entry.key === key);
      if (existing) { setActiveKey(key); return existing.url ?? ''; }
      const request = new AbortController(); requests.set(key, request);
      const entry: BrowserEntry = { version: scope.version, key, id, sessionId, target,
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
        const handoff = await client.open(hostId, id, target, request.signal);
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
      const selected = currentState.registrations.find(item => item.id === browser.id);
      const renewal = renewalIssues[browser.id];
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
