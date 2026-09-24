import { useRef, useState } from 'react';
import { FavoriteDialog } from './favorites/FavoriteDialog.js';
import { FavoriteTree } from './favorites/FavoriteTree.js';
import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
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
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!favorites.enabled || session.hostId === 'local' || !session.hostId) return null;
  const selected = favorites.stars.some(item => sessionKey(item) === sessionKey(session));
  return <><button ref={trigger} type="button" className="lab-star-button" aria-label={`${selected ? 'Edit favorite' : 'Star'} ${session.title}`} aria-pressed={selected}
    title={selected ? 'Edit favorite' : 'Add to favorites'} disabled={!!favorites.pending || favorites.loading} onClick={() => setEditing(true)}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill={selected ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9Z" /></svg>
  </button>{editing ? <FavoriteDialog key={favorites.scope} favorites={favorites} edit={{ type:'session', session:starInput(session) }} onClose={() => { setEditing(false); trigger.current?.focus({preventScroll:true}); }} /> : null}</>;
}
export function FavoritesList({ favorites, tracking, trackedOnly = false, onFilterChange, activeKey, busy, onOpen }: { favorites: SessionStars; tracking: SessionTracking; trackedOnly?: boolean; onFilterChange?(trackedOnly: boolean): void; activeKey?: string; busy: boolean; onOpen(item: VisibleSessionStar): void }) {
  return <>
    {favorites.loading ? <p className="lab-control-note" role="status">Loading favorites…</p> : null}
    {favorites.error ? <p className="lab-control-note" role="alert">{favorites.error} <button type="button" onClick={() => void favorites.refresh()}>Refresh favorites</button></p> : null}
    <FavoriteTree key={favorites.scope} favorites={favorites} tracking={tracking} trackedOnly={trackedOnly} onFilterChange={onFilterChange} activeKey={activeKey} busy={busy} onOpen={onOpen} />
    {tracking.error ? <p className="lab-control-note" role="alert">{tracking.error}</p> : null}
  </>;
}

export function FavoritesMenu({ onScan, title, status, currentSession, favorites, tracking, activeKey, busy, onOpen }: { onScan?(): void; title: string; status?: AgentStatus; currentSession?: Parameters<typeof starInput>[0]; favorites: SessionStars; tracking: SessionTracking; activeKey?: string; busy: boolean; onOpen(item: VisibleSessionStar): void }) {
  return <SessionPopover headingAction={onScan ? close => <button type="button" className="lab-favorites-scan" onClick={() => { close(); onScan(); }}>Scan to open</button> : undefined} label="Favorites" className="lab-title-favorites" trigger={<><span className="lab-favorites-title agent-session-title" data-session-status={status}>{title}</span><span className="lab-favorites-chevron" aria-hidden="true">▾</span></>} onOpen={() => void favorites.refresh()}>
    {close => <>{currentSession ? <div className="lab-favorites-current"><span>Current: {currentSession.title}</span><StarButton session={currentSession} favorites={favorites} /></div> : null}<FavoritesList favorites={favorites} tracking={tracking} activeKey={activeKey} busy={busy} onOpen={item => { close(); onOpen(item); }} /></>}
  </SessionPopover>;
}
