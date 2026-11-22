import { useEffect, useRef, useState } from 'react';
import { errorWords, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { browserSessions, revokeAllBrowserSessions, revokeBrowserSession, securityAudit, SecurityError,
  type BrowserSession, type BrowserSessions, type SecurityEvent } from '../../kernel/security-client.js';
import { ReauthenticationNotice } from '../../conversation/ReauthenticationNotice.js';

const time = (value: number, t: Translate) => value === 0 ? t('settings.security.notRecorded') : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const identifiedBrowser = (session: BrowserSession) => session.current || (session.identified ?? session.id.startsWith('browser:'));
const readable = (value: string) => value.replace(/[_.-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
export function SecurityPanel({ onClose, onSignedOut }: { onClose(): void; onSignedOut(): void }) {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
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
      if (!abort.signal.aborted) { if (error instanceof SecurityError && error.status === 401) onSignedOut(); else setFailure(errorWords(error, words.current, 'settings.security.loadFailed')); }
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
        setNotice(t('settings.security.signedOut', { label: target.label })); setConfirmation(undefined); setAttempt(value => value + 1);
      }
    } catch (error) {
      if (!abort?.signal.aborted) { if (error instanceof SecurityError && error.status === 401) onSignedOut(); else setFailure(errorWords(error, t, 'settings.security.signOutFailed')); }
    } finally { if (!abort?.signal.aborted) setBusy(false); }
  }
  const renderSession = (session: BrowserSession) => <li key={session.id}>
          <div><strong>{session.label}</strong>{session.current ? <span className="gateway-security-current">{t('settings.security.thisBrowser')}</span> : null}
            <p>{t('settings.security.lastActive')}<time dateTime={session.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : undefined}>{time(session.lastSeenAt, t)}</time></p>
            <p>{identifiedBrowser(session) ? t('settings.security.browser') : t('settings.security.signInRecord')} {session.id.replace(/^browser:/, '').slice(0, 8)}{session.sessionCount && session.sessionCount > 1 ? ` · ${t('settings.security.signIns', { count: session.sessionCount })}` : ''}</p>
            {session.activity?.length ? <details><summary>{t('settings.security.activity7')}</summary><ul>{session.activity.map(at => <li key={at}><time dateTime={new Date(at).toISOString()}>{time(at, t)}</time></li>)}</ul><p>{t('settings.security.perUtcDay')}</p></details> : null}</div>
          <button type="button" disabled={busy} aria-label={session.current ? undefined : t('settings.security.signOutNamed', { label: session.label })} onClick={() => setConfirmation(session)}>{session.current ? t('settings.security.signOutThis') : identifiedBrowser(session) ? t('settings.security.signOutBrowser') : t('settings.security.signOutLogin')}</button>
        </li>;
  return <main className="gateway-security" aria-labelledby="security-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <div className="gateway-security-content">
      <header className="gateway-security-header"><button type="button" disabled={busy} onClick={onClose}>{t('settings.security.back')}</button><h1 id="security-title" ref={heading} tabIndex={-1}>{t('settings.security.title')}</h1></header>
      <section aria-labelledby="browser-sessions-title">
        <div className="gateway-security-heading"><h2 id="browser-sessions-title">{t('settings.security.browsersTitle')}</h2><button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>{t('common.refresh')}</button></div>
        <p>{t('settings.security.browsersNote')}</p>
        {failure ? <p role="alert">{failure}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {!sessions && !failure ? <p role="status">{t('settings.security.loading')}</p> : null}
        {sessions?.sessions.length === 0 ? <p>{t('settings.security.noBrowsers')}</p> : null}
        <ul className="gateway-security-list" aria-label={t('settings.security.identified')}>{sessions?.sessions.filter(identifiedBrowser).map(renderSession)}</ul>
        {sessions?.sessions.some(session => !identifiedBrowser(session)) ? <details className="gateway-security-legacy">
          <summary>{t('settings.security.earlier', { count: sessions.sessions.filter(session => !identifiedBrowser(session)).length })}</summary>
          <p>{t('settings.security.earlierNote')}</p>
          <ul className="gateway-security-list">{sessions.sessions.filter(session => !identifiedBrowser(session)).map(renderSession)}</ul>
        </details> : null}
        <p>{t('settings.security.revokeNote')}</p>
        {sessions?.sessions.length ? <button type="button" disabled={busy} onClick={() => setConfirmation('all')}>{t('settings.security.signOutAll')}</button> : null}
        {confirmation ? <div className="gateway-security-confirmation" role="group" aria-label={t('settings.security.confirmLabel')}>
          <p>{confirmation === 'all' ? t('settings.security.confirmAll') : t('settings.security.confirmOne', { label: confirmation.label, kind: confirmation.current ? t('settings.security.kindCurrent') : identifiedBrowser(confirmation) ? '' : t('settings.security.kindEarlier') })}</p>
          <button type="button" disabled={busy} onClick={() => void revoke()}>{busy ? t('settings.security.signingOut') : t('settings.security.confirmSignOut')}</button>
          <button type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>{t('common.cancel')}</button>
        </div> : null}
      </section>
      <section aria-labelledby="sensitive-actions-title"><h2 id="sensitive-actions-title">{t('settings.security.sensitive')}</h2>
        {sessions?.recentAuthentication ? <p>{t('settings.security.recent')}</p> : sessions ? <ReauthenticationNotice /> : <p>{t('settings.security.checkingRecent')}</p>}
        {sessions?.authenticatedAt != null ? <p>{t('settings.security.lastSignIn', { time: time(sessions.authenticatedAt, t) })}</p> : null}
      </section>
      <section aria-labelledby="security-activity-title"><h2 id="security-activity-title">{t('settings.security.activityTitle')}</h2>
        <p>{t('settings.security.activityNote')}</p>
        {auditFailure ? <p role="alert">{t('settings.security.activityUnavailable')}</p> : events === undefined ? <p role="status">{t('settings.security.activityLoading')}</p> : events.length === 0 ? <p>{t('settings.security.activityNone')}</p> :
          <ul className="gateway-security-list gateway-security-audit">{events.map(event => <li key={event.id}><div><strong>{readable(event.action)}</strong><p>{readable(event.outcome)}{event.hostId ? <span>{t('settings.security.hostLabel')}<code>{event.hostId}</code></span> : null}</p></div><time dateTime={new Date(event.at).toISOString()}>{time(event.at, t)}</time></li>)}</ul>}
      </section>
    </div>
  </main>;
}
