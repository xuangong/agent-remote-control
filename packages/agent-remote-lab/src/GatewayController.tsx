import { controllerPath, readControllerLocation } from '@borgee/agent-remote-hosted/controller-location';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { clearConversationRecovery } from './conversation-recovery.js';

type Access = { basePath: string; expiresAt: number; refreshAfterMs?: number };
function parseAccess(value: unknown): Access {
  if (!value || typeof value !== 'object' || !('basePath' in value) || !('expiresAt' in value) ||
    typeof value.basePath !== 'string' || !/^\/u\/[a-f0-9]{64}\/$/.test(value.basePath) ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
    ('refreshAfterMs' in value && (typeof value.refreshAfterMs !== 'number' || !Number.isFinite(value.refreshAfterMs) || value.refreshAfterMs < 0))) {
    throw new Error('Invalid access response.');
  }
  return value as Access;
}
const jsonPost = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
export function GatewayController({ children }: { children(baseUrl: string, accountAction: ReactNode): ReactNode }) {
  const [access, setAccess] = useState<Access | null>();
  const [failed, setFailed] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const stop = useRef<() => void>(() => undefined);
  useEffect(() => {
    const abort = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let recovery: ReturnType<typeof setTimeout> | undefined;
    let recovering = false;
    let inFlight = false;
    let current: Access | undefined;
    let retries = 0;
    const retire = () => { abort.abort(); clearTimeout(expiry); clearTimeout(refresh); clearTimeout(recovery); setAccess(null); };
    stop.current = retire;
    const suspend = () => {
      if (recovering || abort.signal.aborted) return;
      recovering = true;
      clearTimeout(refresh);
      setSuspended(true);
      recovery = setTimeout(retire, 5000);
    };
    const expire = () => {
      if (current?.refreshAfterMs === undefined) { retire(); return; }
      suspend();
      if (!inFlight) void request(true);
    };
    const scheduleRefresh = (delay: number) => {
      if (current && Date.now() + delay < current.expiresAt) refresh = setTimeout(() => void request(true), delay);
    };
    async function request(renew: boolean): Promise<void> {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      if (renew && current && current.expiresAt <= Date.now()) suspend();
      try {
        const response = await fetch(renew ? '/auth/refresh' : '/auth/status', {
          ...(renew ? jsonPost : {}), credentials: 'same-origin', signal: abort.signal, cache: 'no-store',
        });
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403) { retire(); return; }
        if (!response.ok) throw new Error('Access service is unavailable.');
        const value = parseAccess(await response.json());
        if (abort.signal.aborted) return;
        if (value.expiresAt <= Date.now()) { retire(); return; }
        current = value;
        retries = 0;
        recovering = false;
        clearTimeout(recovery);
        setSuspended(false);
        setAccess(value);
        clearTimeout(expiry);
        expiry = setTimeout(expire, value.expiresAt - Date.now());
        if (value.refreshAfterMs !== undefined) scheduleRefresh(Math.max(250, value.refreshAfterMs));
      } catch {
        if (abort.signal.aborted) return;
        if (renew && !recovering && current && current.expiresAt > Date.now()) {
          scheduleRefresh(Math.min(10_000, 1000 * 2 ** Math.min(retries++, 4)));
        } else { setFailed(true); retire(); }
      } finally { inFlight = false; }
    }
    void request(false);
    return () => { abort.abort(); clearTimeout(expiry); clearTimeout(refresh); clearTimeout(recovery); };
  }, []);
  async function logout(): Promise<void> {
    stop.current();
    clearConversationRecovery();
    try {
      const response = await fetch('/auth/logout', { ...jsonPost, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok && response.status !== 401) setFailed(true);
    } catch { setFailed(true); }
  }
  if (access) return <>
    <button type="button" className="gateway-sign-out" onClick={() => void logout()}>Sign out</button>
    <div className="gateway-private" key={access.basePath} hidden={suspended} {...(suspended ? { inert: '' } : {})}>{children(new URL(access.basePath, window.location.origin).href, <button type="button" onClick={() => void logout()}>Sign out</button>)}</div>
    {suspended ? <main className="gateway-access"><h1>Agent Remote</h1><p role="status">Restoring access…</p></main> : null}
  </>;
  let loginUrl = '/auth/login';
  try { loginUrl += controllerPath(readControllerLocation(new URLSearchParams(window.location.search))).slice(1); } catch { /* Invalid targets do not become redirects. */ }
  return <main className="gateway-access">
    <h1>Agent Remote</h1>
    {access === undefined ? <p role="status">Checking access…</p> : <>
      <p>{failed ? 'The relay is unavailable. Try again shortly.' : 'Sign in through your gateway to open your Agent Hosts and sessions.'}</p>
      <a href={loginUrl}>Sign in through gateway</a>
    </>}
  </main>;
}
