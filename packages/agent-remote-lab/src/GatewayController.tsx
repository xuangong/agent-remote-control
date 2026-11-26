import { relayLinkView, watchPageResume, type ChannelLink } from '@orchardworks/agent-client';
import { DeviceLinkContext, type DeviceLink } from './kernel/device-link.js';
import type { AccountFacts } from './kernel/account.js';
import { deviceStore } from '@orchardworks/agent-client/device-store';
import { withMessageKey } from '@orchardworks/agent-client/locale';
import { controllerPath, readControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { signInReturnKey } from '@orchardworks/agent-relay-core/access-page';
import { WorkspaceShell } from './features/windows/WorkspaceShell.js';
import { AccessPage } from './features/computers/AccessPage.js';
import { clearConversationRecovery } from './kernel/conversation-recovery.js';
import { flushRecoveryWrites } from './kernel/recovery-writes.js';
import { useRecoveryNotice } from './conversation/useRecoveryNotice.js';
import { leaseDeadlineOnDeviceClock } from './kernel/lease-clock.js';
import { RelayLinkReport, WorkspaceReady, WorkspaceReadable, scopeFor, storedRowsRelay, subscribeStoredRows, confirmWorkspaceAccess, readStoredLease, revokeStoredRows, retireWorkspace, workspaceSignedOut, previousWorkspacePath, parseAccess, readWorkspaceAccess, rememberWorkspaceAccess, forgetWorkspaceAccess, claimAutomaticSignIn, prepareManualSignIn, setWorkspaceReady, type WorkspaceAccess } from './kernel/workspace-access.js';

/** The Security panel loads when it opens: the sign-in entry stays small, and the panel brings the page's words and components with it. */
const SecurityPanel = lazy(() => import('./features/computers/SecurityPanel.js').then(module => ({ default: module.SecurityPanel })));
/** The device link's words, from the page's catalogue; they load with the workspace, so the sign-in entry stays small. */
const DeviceLinkWords = lazy(() => import('./kernel/DeviceLinkIndicator.js').then(module => ({ default: module.DeviceLinkWords })));
const jsonPost = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
const navigateToLogin = (url: string) => window.location.replace(url);
export function GatewayController({ children, navigate = navigateToLogin, automaticAccess = false }: {
  children(baseUrl: string, account: AccountFacts | undefined, ready: boolean): ReactNode;
  navigate?(url: string): void;
  /** The dedicated local Devbox supplies access without an interactive account. */
  automaticAccess?: boolean;
}) {
  const [access, setAccess] = useState<WorkspaceAccess | null | undefined>(() => {
    const cached = readWorkspaceAccess();
    if (cached) setWorkspaceReady(cached.basePath, false, readStoredLease() !== undefined);
    return cached;
  });
  const display = useRef(access); display.current = access;
  // Reading what the device stores waits for nothing: the cached lease, until the Relay refuses it, is enough.
  const readable = useSyncExternalStore(listener => access ? subscribeStoredRows(access.basePath, listener) : () => {}, () => !!access && !!storedRowsRelay(access.basePath));
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const securityTrigger = useRef<HTMLElement>();
  const [attempt, setAttempt] = useState(0);
  const stop = useRef<() => void>(() => undefined);
  const [channelLink, setChannelLink] = useState<ChannelLink>('unknown');
  const reopenLink = useRef<() => void>();
  const relayLinkReporter = useMemo(() => ({ report: setChannelLink, setReopen: (reopen: (() => void) | undefined) => { reopenLink.current = reopen; } }), []);
  const browserOnline = useBrowserOnline();
  // The page's one connection indicator: this device's link to the Relay, after the usual grace for a quick socket swap.
  const link = relayLinkView({ accessReady: ready, needsSignIn, channel: channelLink, browserOnline });
  const notice = useRecoveryNotice('device-link', link.state !== 'online', !!access);
  // The indicator sits in the foot of the sidebar on screen; a page without one shows it at the top.
  const [claims, setClaims] = useState(0);
  const claim = useMemo(() => (shown: boolean) => {
    if (!shown) return () => {};
    setClaims(count => count + 1);
    return () => setClaims(count => count - 1);
  }, []);
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
    // The local expiry is a copy of the Relay's lease, which another page may have renewed, and the Relay closes the
    // channels of a lease that really expired. So the page holds its traffic while it asks, instead of pausing: a pause
    // closes every live channel and reattaches every session. It pauses only if it cannot confirm access (see unavailable).
    const confirmExpiredAccess = () => {
      if (current && current.expiresAt <= Date.now() && display.current) confirmWorkspaceAccess(display.current.basePath);
    };
    const stopRequests = () => {
      stopped = true; pending?.abort(); clearTimeout(expiry); clearTimeout(refresh); clearTimeout(deadline); pause();
    };
    stop.current = stopRequests;
    const schedule = (delay: number, renew = true) => {
      clearTimeout(refresh);
      // Background pages still own live session channels and must renew before their lease expires. Browsers delay
      // their timers, so a hidden page renews at a third of the remaining lease rather than at half of it.
      if (document.visibilityState === 'hidden' && current) delay = Math.max(250, Math.min(delay, (current.expiresAt - Date.now()) / 3));
      refresh = setTimeout(() => { void request(renew); }, delay);
    };
    const unavailable = (renew: boolean) => {
      setFailed(true);
      if (!current || current.expiresAt <= Date.now()) pause();
      if (!display.current) setAccess(null);
      schedule(Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)), renew);
    };
    async function request(renew: boolean): Promise<void> {
      if (pending || stopped) return;
      const controller = new AbortController(); pending = controller;
      deadline = setTimeout(() => {
        if (pending !== controller || stopped) return;
        pending = undefined; controller.abort(); unavailable(renew);
      }, 12000);
      try {
        const response = await fetch(renew ? '/auth/refresh' : '/auth/status', {
          ...(renew ? jsonPost : {}), credentials: 'same-origin', signal: controller.signal, cache: 'no-store',
        });
        if (stopped || controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          // The Relay does not confirm this person: the conversations this device stored for them are not shown again and are removed.
          void deviceStore.purge(display.current ? scopeFor(display.current.basePath) : undefined).catch(() => { /* Storage may be unavailable. */ });
          if (display.current) revokeStoredRows(display.current.basePath);
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
        if (!response.ok) throw withMessageKey(new Error('Access service is unavailable.'), 'navigation.gateway.accessUnavailable');
        const answer = parseAccess(await response.json());
        if (stopped || controller.signal.aborted) return;
        // From here the lease's expiry is a moment on this device's clock, however far it is from the Relay's.
        const receivedAt = Date.now();
        const value = { ...answer, expiresAt: leaseDeadlineOnDeviceClock({ expiresAt: answer.expiresAt, relayDate: response.headers.get('date'), receivedAt }) };
        if (value.expiresAt <= receivedAt) throw withMessageKey(new Error('Access response expired.'), 'navigation.gateway.accessExpired');
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
        expiry = setTimeout(() => { confirmExpiredAccess(); void request(true); }, value.expiresAt - Date.now());
        schedule(Math.max(250, value.refreshAfterMs ?? Math.max(250, value.expiresAt - Date.now() - 1000)));
      } catch {
        if (!stopped && !controller.signal.aborted) unavailable(renew);
      } finally {
        if (pending === controller) { clearTimeout(deadline); pending = undefined; }
      }
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== 'agent-remote:signed-out' && event.key !== 'agent-remote:workspace-access') return;
      if (!automaticAccess && workspaceSignedOut()) {
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
    // Capture runs before the page's own resume listeners, which may send on their channels.
    const beforeShow = (event: PageTransitionEvent) => { if (event.persisted && !stopped) confirmExpiredAccess(); };
    const beforeVisible = () => { if (document.visibilityState === 'visible' && !stopped) confirmExpiredAccess(); };
    const beforeOnline = () => { if (document.visibilityState !== 'hidden' && !stopped) confirmExpiredAccess(); };
    window.addEventListener('pageshow', beforeShow, true);
    document.addEventListener('visibilitychange', beforeVisible, true);
    window.addEventListener('online', beforeOnline, true);
    const unwatch = watchPageResume(() => {
      if (stopped) return;
      clearTimeout(refresh);
      confirmExpiredAccess();
      // Frozen requests may never settle in Safari; replace them on foreground recovery.
      pending?.abort(); pending = undefined; clearTimeout(deadline);
      // The Relay may have renewed the lease while this page was suspended.
      // Status renews expired grants without forcing another upstream check for a current lease.
      void request(false);
    });
    pause();
    if (!automaticAccess && workspaceSignedOut()) { stopped = true; setAccess(null); } else void request(false);
    return () => {
      unwatch(); stopRequests(); window.removeEventListener('storage', storageChanged);
      window.removeEventListener('pageshow', beforeShow, true);
      document.removeEventListener('visibilitychange', beforeVisible, true);
      window.removeEventListener('online', beforeOnline, true);
    };
  }, [attempt, navigate, automaticAccess]);
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
  // The account's facts for the Settings page: who it is, Security and Sign out. The Devbox has no interactive account.
  const account: AccountFacts | undefined = automaticAccess ? undefined : {
    ...(access?.user?.name ? { name: access.user.name } : {}), ...(access?.user?.email ? { email: access.user.email } : {}), ...(access?.user ? { id: access.user.id } : {}),
    ready, openSecurity: () => { securityTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; setSecurityOpen(true); }, signOut: () => void logout(),
  };
  const signIn = { href: '/auth/login' + returnPath.slice(1), onClick: rememberTarget };
  const retryLink = () => { setAttempt(value => value + 1); reopenLink.current?.(); };
  const deviceLink: DeviceLink = { claim, ...(notice && !securityOpen ? { notice: { state: link.state === 'sign_in' ? 'sign_in' : 'offline', signIn, retry: retryLink } } : {}) };
  if (access) return <WorkspaceReady.Provider value={ready}><WorkspaceReadable.Provider value={readable}><RelayLinkReport.Provider value={relayLinkReporter}><DeviceLinkContext.Provider value={deviceLink}>
    <div className="gateway-private" key={access.basePath} hidden={securityOpen} {...(securityOpen ? { inert: '' } : {})}>{children(new URL(access.basePath, window.location.origin).href, account, ready)}</div>
    {securityOpen ? <Suspense fallback={null}><SecurityPanel onClose={closeSecurity} onSignedOut={signedOut} /></Suspense> : null}
    {deviceLink.notice && !claims ? <div className="gateway-recovery"><Suspense fallback={null}><DeviceLinkWords notice={deviceLink.notice} /></Suspense></div> : null}
  </DeviceLinkContext.Provider></RelayLinkReport.Provider></WorkspaceReadable.Provider></WorkspaceReady.Provider>;
  // While the Relay has not answered, the page is the wordless shell, whether or not this device has been here before.
  if (access === undefined) return <WorkspaceShell />;
  return entry(failed ? 'unavailable' : 'signin');
}

function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}
