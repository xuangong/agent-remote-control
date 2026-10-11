import { useRef, useState, type MouseEvent } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import type { SessionSuccessionHistoryNavigation } from '../hooks/useSessionSuccession.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import './SessionSuccessionHistory.css';

export interface SessionSuccessionHistoryProps {
  navigation?: SessionSuccessionHistoryNavigation;
  onOpen(session: SessionEntry, intent?: 'history'): Promise<boolean>;
}
export function SessionSuccessionHistory({ navigation, onOpen }: SessionSuccessionHistoryProps) {
  return navigation ? <HistoryLinks key={`${navigation.roleKey}:${sessionKey(navigation.session)}:${navigation.history}`} navigation={navigation} onOpen={onOpen} /> : null;
}

function HistoryLinks({ navigation, onOpen }: SessionSuccessionHistoryProps & { navigation: SessionSuccessionHistoryNavigation }) {
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const opening = useRef(false);
  const older = navigation.history ? [...(navigation.predecessor ? [navigation.predecessor] : []), ...navigation.ancestors] : navigation.ancestors;
  function targetLink(target: SessionEntry, label: string, intent?: 'history') {
    const href = controllerPath({ hostId: target.hostId ?? 'local', providerId: target.providerId, nativeSessionId: target.nativeSessionId, sessionIntent: intent });
    async function open(event: MouseEvent<HTMLAnchorElement>) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (opening.current) return;
      opening.current = true; setPending(true); setError(undefined);
      try { if (!await onOpen(target, intent)) setError('This session could not be opened.'); }
      catch (error) { setError(error instanceof Error ? error.message : 'This session could not be opened.'); }
      finally { opening.current = false; setPending(false); }
    }
    return <a href={href} onClick={event => void open(event)} aria-disabled={pending || undefined} title={target.title}>{label}</a>;
  }
  if (!navigation.history && !navigation.predecessor) return null;
  return <nav className="lab-succession-history" aria-label="Session handoff history" aria-busy={pending || undefined}>
    <span className="lab-succession-history-relation">{navigation.history
      ? <>Continued by <span className="lab-succession-history-title" title={navigation.current.title}>{navigation.current.title}</span><span aria-hidden="true"> · </span>{targetLink(navigation.current, 'Return to current')}</>
      : <>Continued from {targetLink(navigation.predecessor!, navigation.predecessor!.title, 'history')}</>}</span>
    {older.length ? <details className="lab-succession-history-older"><summary>Earlier history ({older.length})</summary>
      <ol aria-label="Earlier sessions">{older.map(target => <li key={sessionKey(target)}>{targetLink(target, target.title, 'history')}</li>)}</ol>
    </details> : null}
    {error ? <span className="lab-succession-history-error" role="alert">{error}</span> : null}
  </nav>;
}
