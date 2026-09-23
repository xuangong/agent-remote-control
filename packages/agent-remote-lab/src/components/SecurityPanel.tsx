import { useEffect, useRef, useState } from 'react';
import { browserSessions, revokeAllBrowserSessions, revokeBrowserSession, securityAudit, SecurityError,
  type BrowserSession, type BrowserSessions, type SecurityEvent } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

const time = (value: number) => value === 0 ? 'Not recorded' : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const readable = (value: string) => value.replace(/[_.-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
export function SecurityPanel({ onClose, onSignedOut }: { onClose(): void; onSignedOut(): void }) {
  const [sessions, setSessions] = useState<BrowserSessions>();
  const [events, setEvents] = useState<SecurityEvent[]>();
  const [failure, setFailure] = useState<string>();
  const [auditFailure, setAuditFailure] = useState(false);
  const [confirmation, setConfirmation] = useState<BrowserSession | 'all'>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const controller = useRef<AbortController>();
  const sequence = useRef(0);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    const current = ++sequence.current;
    setFailure(undefined); setAuditFailure(false);
    void browserSessions(abort.signal).then(value => { if (!abort.signal.aborted && current === sequence.current) setSessions(value); }).catch(error => {
      if (!abort.signal.aborted) { if (error instanceof SecurityError && error.status === 401) onSignedOut(); else setFailure(error instanceof Error ? error.message : 'Could not load browser sessions.'); }
    });
    void securityAudit(abort.signal).then(value => { if (!abort.signal.aborted && current === sequence.current) setEvents(value); }).catch(() => { if (!abort.signal.aborted) setAuditFailure(true); });
    return () => abort.abort();
  }, [attempt]);
  async function revoke() {
    if (!confirmation || busy) return;
    const target = confirmation;
    const abort = controller.current;
    setBusy(true); setFailure(undefined); setNotice(undefined);
    try {
      if (target === 'all') { await revokeAllBrowserSessions(abort?.signal); if (!abort?.signal.aborted) onSignedOut(); }
      else {
        const result = await revokeBrowserSession(target.id, abort?.signal);
        if (abort?.signal.aborted) return;
        if (result.current) { onSignedOut(); return; }
        setSessions(value => value ? { ...value, sessions: value.sessions.filter(session => session.id !== target.id) } : value);
        setNotice(`${target.label} signed out.`); setConfirmation(undefined); setAttempt(value => value + 1);
      }
    } catch (error) {
      if (!abort?.signal.aborted) { if (error instanceof SecurityError && error.status === 401) onSignedOut(); else setFailure(error instanceof Error ? error.message : 'Could not sign out the browser.'); }
    } finally { if (!abort?.signal.aborted) setBusy(false); }
  }
  return <main className="gateway-security" aria-labelledby="security-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <div className="gateway-security-content">
      <header className="gateway-security-header"><button type="button" disabled={busy} onClick={onClose}>Back to conversation</button><h1 id="security-title" ref={heading} tabIndex={-1}>Security</h1></header>
      <section aria-labelledby="browser-sessions-title">
        <div className="gateway-security-heading"><h2 id="browser-sessions-title">Signed-in browsers</h2><button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Refresh</button></div>
        <p>Browsers active in the last 7 days. Repeated sign-ins from the same browser appear together. If you see an unfamiliar browser, sign it out.</p>
        {failure ? <p role="alert">{failure}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {!sessions && !failure ? <p role="status">Loading signed-in browsers…</p> : null}
        {sessions?.sessions.length === 0 ? <p>No active browsers were returned. Refresh to check your access.</p> : null}
        <ul className="gateway-security-list">{sessions?.sessions.map(session => <li key={session.id}>
          <div><strong>{session.label}</strong>{session.current ? <span className="gateway-security-current">This browser</span> : null}
            <p>Last active <time dateTime={session.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : undefined}>{time(session.lastSeenAt)}</time></p>
            <p>Browser {session.id.replace(/^browser:/, '').slice(0, 8)}{session.sessionCount && session.sessionCount > 1 ? ` · ${session.sessionCount} sign-ins` : ''}</p>
            {session.activity?.length ? <details><summary>Activity in the last 7 days</summary><ul>{session.activity.map(at => <li key={at}><time dateTime={new Date(at).toISOString()}>{time(at)}</time></li>)}</ul><p>Latest activity per UTC day.</p></details> : null}</div>
          <button type="button" disabled={busy} aria-label={session.current ? undefined : `Sign out ${session.label}`} onClick={() => setConfirmation(session)}>{session.current ? 'Sign out this browser' : 'Sign out browser'}</button>
        </li>)}</ul>
        <p>Signing out a browser revokes all its sign-ins. Hosts stay paired. Sign out all browsers also includes browsers inactive for more than 7 days.</p>
        {sessions?.sessions.length ? <button type="button" disabled={busy} onClick={() => setConfirmation('all')}>Sign out all browsers</button> : null}
        {confirmation ? <div className="gateway-security-confirmation" role="group" aria-label="Confirm browser sign-out">
          <p>{confirmation === 'all' ? 'Sign out every browser, including this one?' : `Sign out ${confirmation.label}${confirmation.current ? ' (this browser)' : ''}?`}</p>
          <button type="button" disabled={busy} onClick={() => void revoke()}>{busy ? 'Signing out…' : 'Confirm sign out'}</button>
          <button type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>Cancel</button>
        </div> : null}
      </section>
      <section aria-labelledby="sensitive-actions-title"><h2 id="sensitive-actions-title">Sensitive actions</h2>
        {sessions?.recentAuthentication ? <p>Your recent gateway sign-in allows pairing and credential rotation.</p> : sessions ? <ReauthenticationNotice /> : <p>Checking whether a recent gateway sign-in is required…</p>}
        {sessions?.authenticatedAt != null ? <p>Last gateway sign-in: {time(sessions.authenticatedAt)}</p> : null}
      </section>
      <section aria-labelledby="security-activity-title"><h2 id="security-activity-title">Recent security activity</h2>
        <p>Access and device events for your account. Conversation content and credentials are excluded.</p>
        {auditFailure ? <p role="alert">Security activity is unavailable. Use Refresh to try again.</p> : events === undefined ? <p role="status">Loading security activity…</p> : events.length === 0 ? <p>No recent security activity.</p> :
          <ul className="gateway-security-list gateway-security-audit">{events.map(event => <li key={event.id}><div><strong>{readable(event.action)}</strong><p>{readable(event.outcome)}{event.hostId ? <span> · Host <code>{event.hostId}</code></span> : null}</p></div><time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time></li>)}</ul>}
      </section>
    </div>
  </main>;
}
