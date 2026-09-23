import { watchPageResume } from '@orchardworks/agent-remote-web/headless';
import { controllerPath, readControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { signInReturnKey } from '@orchardworks/agent-remote-hosted/access-page';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { AccessPage } from './components/AccessPage.js';
import { clearConversationRecovery } from './conversation-recovery.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { useRecoveryNotice } from './hooks/useRecoveryNotice.js';
import { WorkspaceReady, retireWorkspace, workspaceSignedOut, previousWorkspacePath, parseAccess, readWorkspaceAccess, rememberWorkspaceAccess, forgetWorkspaceAccess, claimAutomaticSignIn, prepareManualSignIn, setWorkspaceReady, type WorkspaceAccess } from './workspace-access.js';

const jsonPost = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
const navigateToLogin = (url: string) => window.location.replace(url);
export function GatewayController({ children, navigate = navigateToLogin }: {
  children(baseUrl: string, accountAction: ReactNode, ready: boolean): ReactNode;
  navigate?(url: string): void;
}) {
  const [access, setAccess] = useState<WorkspaceAccess | null | undefined>(() => {
    const cached = readWorkspaceAccess();
    if (cached) setWorkspaceReady(cached.basePath, false);
    return cached;
  });
  const display = useRef(access); display.current = access;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const securityTrigger = useRef<HTMLElement>();
  const [attempt, setAttempt] = useState(0);
  const stop = useRef<() => void>(() => undefined);
  const notice = useRecoveryNotice('workspace-access', ready ? 'ready' : 'connecting', !ready, !!access);
  useEffect(() => {
    let stopped = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | undefined;
    let current: WorkspaceAccess | undefined;
    let retries = 0;
    const pause = () => {
      if (display.current) setWorkspaceReady(display.current.basePath, false);
      setReady(false);
    };
    const stopRequests = () => {
      stopped = true; pending?.abort(); clearTimeout(expiry); clearTimeout(refresh); clearTimeout(deadline); pause();
    };
    stop.current = stopRequests;
    const schedule = (delay: number) => {
      clearTimeout(refresh);
      refresh = setTimeout(() => { if (document.visibilityState !== 'hidden') void request(true); }, delay);
    };
    const unavailable = () => {
      setFailed(true);
      if (!current || current.expiresAt <= Date.now()) pause();
      if (!display.current) setAccess(null);
      schedule(Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)));
    };
    async function request(renew: boolean): Promise<void> {
      if (pending || stopped) return;
      const controller = new AbortController(); pending = controller;
      deadline = setTimeout(() => {
        if (pending !== controller || stopped) return;
        pending = undefined; controller.abort(); unavailable();
      }, 12000);
      try {
        const response = await fetch(renew ? '/auth/refresh' : '/auth/status', {
          ...(renew ? jsonPost : {}), credentials: 'same-origin', signal: controller.signal, cache: 'no-store',
        });
        if (stopped || controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          stopRequests(); setSecurityOpen(false);
          if (response.status === 401 && claimAutomaticSignIn()) {
            let target = '/';
            try { target = controllerPath(readControllerLocation(new URLSearchParams(window.location.search))); } catch { /* Ignore invalid navigation targets. */ }
            flushRecoveryWrites();
            try { sessionStorage.setItem(signInReturnKey, target); } catch { /* The server also retains the target. */ }
            navigate('/auth/login' + target.slice(1));
            setNeedsSignIn(true);
          } else {
            if (response.status === 403) {
              if (display.current) retireWorkspace(display.current.basePath);
              if (display.current) clearConversationRecovery(new URL(display.current.basePath, window.location.origin).href);
              forgetWorkspaceAccess();
            }
            setAccess(null); setNeedsSignIn(true); setFailed(false);
          }
          return;
        }
        if (!response.ok) throw new Error('Access service is unavailable.');
        const value = parseAccess(await response.json());
        if (stopped || controller.signal.aborted) return;
        if (value.expiresAt <= Date.now()) throw new Error('Access response expired.');
        const previousPath = display.current?.basePath ?? previousWorkspacePath();
        if (previousPath && previousPath !== value.basePath) {
          retireWorkspace(previousPath);
          clearConversationRecovery(new URL(previousPath, window.location.origin).href);
        }
        current = value; retries = 0;
        rememberWorkspaceAccess(value);
        setWorkspaceReady(value.basePath, true);
        display.current = value; setAccess(value); setReady(true); setFailed(false); setNeedsSignIn(false);
        clearTimeout(expiry);
        expiry = setTimeout(() => { pause(); void request(true); }, value.expiresAt - Date.now());
        schedule(Math.max(250, value.refreshAfterMs ?? Math.max(250, value.expiresAt - Date.now() - 1000)));
      } catch {
        if (!stopped && !controller.signal.aborted) unavailable();
      } finally {
        if (pending === controller) { clearTimeout(deadline); pending = undefined; }
      }
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== 'agent-remote:signed-out' && event.key !== 'agent-remote:workspace-access') return;
      if (workspaceSignedOut()) {
        stopRequests();
        if (display.current) { retireWorkspace(display.current.basePath); clearConversationRecovery(new URL(display.current.basePath, window.location.origin).href); }
        setSecurityOpen(false); setAccess(null); setFailed(false);
      } else if (display.current && previousWorkspacePath() && previousWorkspacePath() !== display.current.basePath) {
        stopRequests(); retireWorkspace(display.current.basePath);
        clearConversationRecovery(new URL(display.current.basePath, window.location.origin).href);
        setAccess(undefined); setSecurityOpen(false); setAttempt(value => value + 1);
      }
    };
    window.addEventListener('storage', storageChanged);
    const beforeShow = (event: PageTransitionEvent) => { if (event.persisted && !stopped) pause(); };
    const beforeVisible = () => { if (document.visibilityState === 'visible' && !stopped) pause(); };
    const beforeOnline = () => { if (document.visibilityState !== 'hidden' && !stopped) pause(); };
    window.addEventListener('pageshow', beforeShow, true);
    document.addEventListener('visibilitychange', beforeVisible, true);
    window.addEventListener('online', beforeOnline, true);
    const unwatch = watchPageResume(() => {
      if (stopped) return;
      clearTimeout(refresh);
      pause();
      // Frozen requests may never settle in Safari; replace them on foreground recovery.
      pending?.abort(); pending = undefined; clearTimeout(deadline);
      void request(true);
    });
    pause();
    if (workspaceSignedOut()) { stopped = true; setAccess(null); } else void request(false);
    return () => {
      unwatch(); stopRequests(); window.removeEventListener('storage', storageChanged);
      window.removeEventListener('pageshow', beforeShow, true);
      document.removeEventListener('visibilitychange', beforeVisible, true);
      window.removeEventListener('online', beforeOnline, true);
    };
  }, [attempt, navigate]);
  function signedOut(): void {
    stop.current(); if (access) retireWorkspace(access.basePath); setSecurityOpen(false); forgetWorkspaceAccess(); setAccess(null); setFailed(false);
    clearConversationRecovery(access ? new URL(access.basePath, window.location.origin).href : undefined);
  }
  async function logout(): Promise<void> {
    signedOut();
    try {
      const response = await fetch('/auth/logout', { ...jsonPost, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok && response.status !== 401) setFailed(true);
    } catch { setFailed(true); }
  }
  let returnPath = '/';
  let sessionLink = false;
  try {
    const target = readControllerLocation(new URLSearchParams(window.location.search));
    returnPath = controllerPath(target);
    sessionLink = !!(target.nativeSessionId || target.agentId);
  } catch { /* Invalid targets do not become redirects. */ }
  function rememberTarget() {
    prepareManualSignIn(); flushRecoveryWrites();
    try { sessionStorage.setItem(signInReturnKey, returnPath); } catch { /* Sign-in remains available without browser storage. */ }
  }
  const entry = (state: Parameters<typeof AccessPage>[0]['state']) => <AccessPage state={state} sessionLink={sessionLink}
    loginUrl={'/auth/login' + returnPath.slice(1)} onLogin={rememberTarget}
    onRetry={() => { setFailed(false); setNeedsSignIn(false); setAttempt(value => value + 1); }} />;
  function closeSecurity() {
    setSecurityOpen(false);
    requestAnimationFrame(() => securityTrigger.current?.focus());
  }
  const accountAction = <>
    {access?.user ? <span className="gateway-account-identity" aria-label="Gateway account" title={[access.user.name, access.user.email, `Gateway user: ${access.user.id}`].filter(Boolean).join(' · ')}><span aria-hidden="true">◉</span> {access.user.name || access.user.email || access.user.id}</span> : null}
    <button type="button" disabled={!ready} onClick={event => { securityTrigger.current = event.currentTarget; setSecurityOpen(true); }}>Security</button>
    <button type="button" onClick={() => void logout()}>Sign out</button>
  </>;
  if (access) return <WorkspaceReady.Provider value={ready}>
    <div className="gateway-sign-out gateway-account-actions" hidden={securityOpen}>{accountAction}</div>
    <div className="gateway-private" key={access.basePath} hidden={securityOpen} {...(securityOpen ? { inert: '' } : {})}>{children(new URL(access.basePath, window.location.origin).href, accountAction, ready)}</div>
    {securityOpen ? <SecurityPanel onClose={closeSecurity} onSignedOut={signedOut} /> : null}
    {notice && !securityOpen ? <div className="gateway-recovery" role="status">
      {needsSignIn ? <>Sign in to reconnect. <a href={'/auth/login' + returnPath.slice(1)} onClick={rememberTarget}>Sign in</a></> : <>Reconnecting… <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></>}
    </div> : null}
  </WorkspaceReady.Provider>;
  if (access === undefined && previousWorkspacePath()) return <WorkspaceShell />;
  return entry(access === undefined ? 'checking' : failed ? 'unavailable' : 'signin');
}
