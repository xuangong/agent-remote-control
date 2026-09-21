import { useEffect, useRef } from 'react';
import { accessBrandMark, accessCopy, accessPageStyle, type AccessPageState } from '@orchardworks/agent-remote-hosted/access-page';

export function AccessPage({ state, sessionLink, loginUrl, onLogin, onRetry }: {
  state: AccessPageState; sessionLink: boolean; loginUrl: string; onLogin(): void; onRetry(): void;
}) {
  const copy = accessCopy[state];
  const error = state === 'expired' || state === 'unavailable';
  const busy = !!copy.status;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!busy) heading.current?.focus({ preventScroll: true }); }, [state, busy]);
  const step = state === 'checking' ? 0 : state === 'opening' ? 2 : 1;
  return <main className="arc-access" data-state={state}>
    <style>{accessPageStyle}</style>
    <header className="arc-access-brand"><span dangerouslySetInnerHTML={{ __html: accessBrandMark }} />Agent Remote</header>
    <section className="arc-access-body" aria-labelledby="access-title">
      <ol className="arc-access-progress" aria-label="Sign-in progress">
        {['Open link', 'Sign in', sessionLink ? 'Open session' : 'Open workspace'].map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}
      </ol>
      <p className="arc-access-eyebrow">{error ? 'Try again' : sessionLink ? 'Continue on this device' : 'Your agent workspace'}</p>
      <h1 id="access-title" ref={heading} tabIndex={-1}>{state === 'checking' && !sessionLink ? 'Opening your workspace' : copy.title}</h1>
      <p className="arc-access-description" role={error ? 'alert' : undefined}>{state === 'signin' && !sessionLink ? 'Sign in through your gateway to open your Agent Hosts and sessions.' : copy.description}</p>
      {busy ? <p className="arc-access-activity" role="status">{copy.status}</p> : <div className="arc-access-actions">
        {state === 'unavailable' ? <button className="arc-access-action" type="button" onClick={onRetry}>Try again</button>
          : <a className="arc-access-action" href={loginUrl} onClick={onLogin}>Sign in through gateway</a>}
        {state === 'unavailable' ? <a className="arc-access-secondary" href={loginUrl} onClick={onLogin}>Sign in through gateway</a> : null}
      </div>}
      {!busy && <p className="arc-access-note">{sessionLink ? 'After sign-in, this link opens the same session. Use an account with access to its Host.' : 'Use your existing gateway account to continue.'}</p>}
    </section>
    <footer className="arc-access-footer"><span>Agent Remote Control</span><span className="arc-access-host">{window.location.host}</span></footer>
  </main>;
}
