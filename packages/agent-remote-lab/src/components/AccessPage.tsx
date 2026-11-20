import { useEffect, useRef } from 'react';
import { accessMark, accessPageStyle, accessView, accessWordmark, type AccessPageState } from '@orchardworks/agent-relay-core/access-page';
import { deviceChoices } from '../device-choices.js';

/** The page's own sign-in entry: a quiet wait (the mark and one sentence) or a card that needs the reader. */
export function AccessPage({ state, sessionLink, loginUrl, onLogin, onRetry }: {
  state: AccessPageState; sessionLink: boolean; loginUrl: string; onLogin(): void; onRetry(): void;
}) {
  const view = accessView(state, deviceChoices().language.locale, { sessionLink });
  const heading = useRef<HTMLHeadingElement>(null);
  const card = view.kind === 'card';
  useEffect(() => { if (card) heading.current?.focus({ preventScroll: true }); }, [state, card]);
  const error = state === 'expired' || state === 'unavailable';
  return <main className="arc-access" data-state={state} data-kind={card ? 'card' : 'wait'}>
    <style>{accessPageStyle}</style>
    <div className="arc-access-panel">
      <div className="arc-access-brand"><span className="arc-access-mark" dangerouslySetInnerHTML={{ __html: accessMark }} /><span className="arc-access-wordmark">{accessWordmark}</span></div>
      {view.kind === 'wait' ? <p className="arc-access-sentence" role="status">{view.sentence}</p> : <div className="arc-access-detail">
        <h1 id="access-title" ref={heading} tabIndex={-1}>{view.title}</h1>
        <p className="arc-access-description" role={error ? 'alert' : undefined}>{view.description}</p>
        <div className="arc-access-actions">
          {state === 'unavailable' ? <button className="arc-access-action" type="button" onClick={onRetry}>{view.action}</button>
            : <a className="arc-access-action" href={loginUrl} onClick={onLogin}>{view.action}</a>}
          {state === 'unavailable' && view.secondary ? <a className="arc-access-secondary" href={loginUrl} onClick={onLogin}>{view.secondary}</a> : null}
        </div>
        <footer className="arc-access-footer">{window.location.host}</footer>
      </div>}
    </div>
  </main>;
}
