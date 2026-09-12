import { useEffect, useState, type ReactNode } from 'react';

type Access = { basePath: string; expiresAt: number };
export function GatewayController({ children }: { children(baseUrl: string): ReactNode }) {
  const [access, setAccess] = useState<Access | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    void fetch('/auth/status', { signal: abort.signal, cache: 'no-store' }).then(async response => {
      if (response.status === 401) { setAccess(null); return; }
      if (!response.ok) throw new Error('Access service is unavailable.');
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('basePath' in value) || !('expiresAt' in value) ||
        typeof value.basePath !== 'string' || !/^\/u\/[a-f0-9]{64}\/$/.test(value.basePath) ||
        typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) throw new Error('Invalid access response.');
      if (abort.signal.aborted) return;
      if (value.expiresAt <= Date.now()) { setAccess(null); return; }
      setAccess({ basePath: value.basePath, expiresAt: value.expiresAt });
      expiry = setTimeout(() => setAccess(null), value.expiresAt - Date.now());
    }).catch(() => { if (!abort.signal.aborted) { setFailed(true); setAccess(null); } });
    return () => { abort.abort(); clearTimeout(expiry); };
  }, []);
  if (access) return children(new URL(access.basePath, window.location.origin).href);
  return <main className="gateway-access">
    <h1>Agent Remote</h1>
    {access === undefined ? <p role="status">Checking access…</p> : <>
      <p>{failed ? 'The relay is unavailable. Try again shortly.' : 'Sign in through your gateway to open your Agent Hosts and sessions.'}</p>
      <a href="/auth/login">Sign in through gateway</a>
    </>}
  </main>;
}
