import type { AgentStatus } from '@agent-remote-controller/agent-remote-protocol';
import type { SessionStars } from '../hooks/useSessionStars.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import type { StarInput, VisibleSessionStar } from '../session-stars-client.js';
import { SessionPopover } from './SessionPopover.js';

export function starInput(session: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId' | 'title' | 'parentNativeSessionId'>): StarInput {
  return { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId,
    title: (session.title || session.nativeSessionId).replace(/[\u0000-\u001f]/g, ' ').slice(0, 512), ...(session.parentNativeSessionId ? { parentNativeSessionId: session.parentNativeSessionId } : {}) };
}
export function StarButton({ session, favorites }: { session: Parameters<typeof starInput>[0]; favorites: SessionStars }) {
  if (!favorites.enabled || session.hostId === 'local' || !session.hostId) return null;
  const selected = favorites.stars.some(item => sessionKey(item) === sessionKey(session));
  return <button type="button" className="lab-star-button" aria-label={`${selected ? 'Unstar' : 'Star'} ${session.title}`} aria-pressed={selected}
    title={selected ? 'Remove from favorites' : 'Add to favorites'} disabled={!!favorites.pending || favorites.loading} onClick={() => void favorites.toggle(starInput(session))}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill={selected ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9Z" /></svg>
  </button>;
}
export function FavoritesList({ favorites, tracking, activeKey, busy, onOpen }: { favorites: SessionStars; tracking: SessionTracking; activeKey?: string; busy: boolean; onOpen(item: VisibleSessionStar): void }) {
  return <>
    {favorites.loading ? <p className="lab-control-note" role="status">Loading favorites…</p> : null}
    {favorites.error ? <p className="lab-control-note" role="alert">{favorites.error} <button type="button" onClick={() => void favorites.refresh()}>Refresh favorites</button></p> : null}
    {!favorites.loading && !favorites.error && !favorites.stars.length ? <p className="lab-control-note">Star a session to keep it here across your devices.</p> : null}
    <ul className="lab-favorite-list">{favorites.stars.map(item => {
      const key = sessionKey(item), tracked = tracking.sessions.some(session => sessionKey(session) === key);
      return <li key={key}>
        <button type="button" className="lab-session-row" aria-current={activeKey === key ? 'page' : undefined} disabled={busy || !item.available || !item.online} onClick={() => onOpen(item)}>
          <strong>{item.title}</strong><small>{item.hostName ?? 'Unavailable Host'} · {item.providerId}{!item.available ? ' · Access unavailable' : !item.online ? ' · Host offline' : ''}</small>
        </button>
        <div className="lab-favorite-actions"><button type="button" aria-pressed={tracked} aria-label={`${tracked ? 'Untrack' : 'Track'} ${item.title}`} disabled={!tracked && !item.available} onClick={() => tracking.toggle(item)}>{tracked ? 'Untrack' : 'Track'}</button>
          <StarButton session={item} favorites={favorites} /></div>
      </li>;
    })}</ul>
    {tracking.error ? <p className="lab-control-note" role="alert">{tracking.error}</p> : null}
  </>;
}
export function FavoritesMenu({ title, status, currentSession, favorites, tracking, activeKey, busy, onOpen }: { title: string; status?: AgentStatus; currentSession?: Parameters<typeof starInput>[0]; favorites: SessionStars; tracking: SessionTracking; activeKey?: string; busy: boolean; onOpen(item: VisibleSessionStar): void }) {
  return <SessionPopover label="Favorites" className="lab-title-favorites" trigger={<><span className="lab-favorites-title agent-session-title" data-session-status={status}>{title}</span><span className="lab-favorites-chevron" aria-hidden="true">▾</span></>} onOpen={() => void favorites.refresh()}>
    {close => <>{currentSession ? <div className="lab-favorites-current"><span>Current: {currentSession.title}</span><StarButton session={currentSession} favorites={favorites} /></div> : null}<FavoritesList favorites={favorites} tracking={tracking} activeKey={activeKey} busy={busy} onOpen={item => { close(); onOpen(item); }} /></>}
  </SessionPopover>;
}
