import { errorWords, watchList, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { SessionListingStatus } from '@orchardworks/agent-remote-protocol';
import { StarButton } from './SessionFavorites.js';
import type { SessionStars } from './useSessionStars.js';
import { useFeedbackToast } from '../../kernel/Toast.js';
import { WorkspaceSelect } from '../../kernel/WorkspaceSelect.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sessionForest, sessionKey, sessionStatusLabel, type SessionEntry } from '../../kernel/session-tree.js';
import { SessionTree } from './SessionTree.js';
import { directorySessionLinks } from './directory-relations.js';
import type { ForkStore } from '../../kernel/session-forks.js';
import { DirectoryError, type CreateSessionOptions, type OpenedSession, type SessionCatalogPage, type SessionDirectoryClient, type SessionSummary } from '../../kernel/directory-client.js';

interface Props {
  quickOpen?: ReactNode;
  searchable?: boolean;
  favorites?: SessionStars;
  directory: SessionDirectoryClient;
  providerId: string;
  activeAgentId?: string;
  opened: readonly OpenedSession[];
  known?: readonly SessionEntry[];
  sideStore?: ForkStore;
  askStore?: ForkStore;
  hostId?: string;
  /** How often a listing in progress is checked; a test shortens it. */
  listingPollMs?: number;
  onOpenRelated?(item: SessionEntry): void;
  busy: boolean;
  revision: number;
  onOpen(item: SessionSummary): void;
  onSelect(item: OpenedSession): void;
  onClose(agentId: string): void;
}

export function SessionDirectory({ quickOpen, favorites, searchable = false, directory, providerId, activeAgentId, opened, known = [], sideStore, askStore, hostId = 'local', listingPollMs = 2000, onOpenRelated, busy, revision, onOpen, onSelect, onClose }: Props) {
  const t = useTranslate();
  const [search, setSearch] = useState('');
  const [listing, setListing] = useState<SessionListingStatus>();
  const [requestingListing, setRequestingListing] = useState(false);
  const [, refreshRelations] = useState(0);
  useEffect(() => {
    const refresh = () => refreshRelations(value => value + 1);
    const unsubscribe = [sideStore?.subscribe(refresh), askStore?.subscribe(refresh)];
    return () => { for (const stop of unsubscribe) stop?.(); };
  }, [sideStore, askStore]);
  const matches = (item: SessionEntry) => !search.trim() || [item.title, item.nativeSessionId, item.providerId, ('workspace' in item && typeof item.workspace === 'string' ? item.workspace : '')].some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()));
  const [page, setPage] = useState<SessionCatalogPage | undefined>(directory.cachedPages.get(providerId));
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast(t('sessions.directory.listToastTitle'), failure);
  const [expired, setExpired] = useState(false);
  const [updates, setUpdates] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const pageRef = useRef(page);
  pageRef.current = page;

  async function load(cursor?: string): Promise<void> {
    if (!providerId || inFlight.current) return;
    const request = generation.current;
    inFlight.current = true;
    setLoading(true);
    setFailure(undefined);
    try {
      const next = await directory.list(providerId, cursor);
      if (generation.current !== request) return;
      setPage((current) => {
        const entries = new Map((cursor ? current?.items ?? [] : []).map((item) => [item.nativeSessionId, item]));
        for (const item of next.items) entries.set(item.nativeSessionId, item);
        const result = { ...next, items: [...entries.values()] };
        directory.cachedPages.set(providerId, result);
        return result;
      });
      setExpired(false);
      setUpdates(false);
    } catch (error) {
      if (generation.current !== request) return;
      const isExpired = error instanceof DirectoryError && error.code === 'cursor_expired';
      setExpired(isExpired);
      setFailure(isExpired ? t('sessions.directory.expired') : errorWords(error, t, 'sessions.directory.loadFailed'));
    } finally {
      if (generation.current === request) { inFlight.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setPage(directory.cachedPages.get(providerId));
    setFailure(undefined);
    setExpired(false);
    setUpdates(false);
    setRequestingListing(false);
    if (!directory.cachedPages.get(providerId)) void load();
    return () => { generation.current += 1; inFlight.current = false; };
  }, [providerId, directory]);

  useEffect(() => {
    let retired = false;
    setListing(undefined);
    if (providerId === 'codex' && hostId !== 'local') {
      void directory.listing(providerId).then(status => { if (!retired) setListing(status); }).catch(() => undefined);
    }
    return () => { retired = true; };
  }, [providerId, directory, hostId]);

  useEffect(() => {
    if (!listing?.refreshing) return;
    let retired = false;
    const timer = window.setTimeout(() => {
      void directory.listing(providerId).then(status => {
        if (retired) return;
        setListing(status);
        void load();
      }).catch(error => {
        if (retired) return;
        setFailure(errorWords(error, t, 'sessions.directory.checkListingFailed'));
        setListing({ ...listing, refreshing: false });
      });
    }, listingPollMs);
    return () => { retired = true; window.clearTimeout(timer); };
  }, [listing, directory, providerId, listingPollMs]);

  async function listNativeSessions() {
    const request = generation.current;
    setRequestingListing(true);
    setFailure(undefined);
    try {
      const status = await directory.listing(providerId, true);
      if (generation.current !== request) return;
      setListing(status);
      void load();
    } catch (error) {
      if (generation.current === request) setFailure(errorWords(error, t, 'sessions.directory.startListingFailed'));
    } finally { if (generation.current === request) setRequestingListing(false); }
  }

  useEffect(() => {
    if (revision > 0) setUpdates(true);
  }, [revision]);

  useEffect(() => {
    let retired = false;
    let checking = false;
    const inspect = async () => {
      if (!providerId || checking || !pageRef.current || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const next = await directory.revision(providerId);
        if (!retired && next.revision !== pageRef.current?.revision) setUpdates(true);
      } catch { /* A revision failure must not replace an already loaded directory. */ }
      finally { checking = false; }
    };
    const stop = watchList(inspect, 5_000);
    return () => { retired = true; stop(); };
  }, [providerId, directory]);

  const discovered = new Map<string, SessionEntry>((page?.items ?? []).map((item) => [sessionKey({ ...item, hostId }), { ...item, hostId }]));
  for (const item of known) {
    if ((item.hostId ?? 'local') !== hostId || item.providerId !== providerId) continue;
    if (item.parentNativeSessionId || discovered.has(sessionKey(item))) discovered.set(sessionKey(item), { ...discovered.get(sessionKey(item)), ...item });
  }
  const links = directorySessionLinks(sideStore?.linked() ?? [], askStore?.linked() ?? [], [...discovered.values(), ...known]);
  const discoveredTree = sessionForest([...discovered.values()].filter(item => matches(item)
    || [...(links.get(sessionKey(item))?.values() ?? [])].some(link => matches(link.target))), known);
  const active = known.find((item) => item.agentId === activeAgentId) ?? opened.find((item) => item.agentId === activeAgentId);
  const activeKey = active ? sessionKey(active) : undefined;
  const openedByKey = new Map(opened.map(item => [sessionKey(item), item]));
  const openRelated = (item: SessionEntry) => {
    if (onOpenRelated) onOpenRelated(item);
    else { const saved = opened.find((entry) => sessionKey(entry) === sessionKey(item)); if (saved) onSelect(saved); }
  };
  const renderRow = (item: SessionEntry, placeholder: boolean, relationKinds?: readonly string[]) => {
    const summary = page?.items.find(entry => entry.nativeSessionId === item.nativeSessionId);
    const related = Boolean(relationKinds?.length || item.parentNativeSessionId) || !summary;
    const saved = openedByKey.get(sessionKey(item));
    const current = sessionKey(item) === activeKey;
    const nativeLinks = item.parentNativeSessionId ? links.get(sessionKey({ ...item, nativeSessionId: item.parentNativeSessionId }))?.get(sessionKey(item)) : undefined;
    const kinds = relationKinds ?? (item.parentNativeSessionId ? [t('sessions.directory.subagent'), ...(nativeLinks?.kinds ?? [])] : []);
    return <><button type="button" className="lab-session-row" aria-current={current ? 'page' : undefined} disabled={busy || (!saved && (related ? !onOpenRelated : summary?.state === 'unavailable'))} onClick={() => { if (saved) onSelect(saved); else if (related) openRelated(item); else if (summary) onOpen(summary); }} title={summary?.workspace}>
      <strong className="agent-session-title" data-session-status={item.status ?? summary?.state}>{item.title || item.nativeSessionId}</strong>
      <small>{current ? `${t('sessions.directory.currentPrefix')} ` : ''}{kinds.length ? kinds.join(' · ') + ' · ' : ''}{item.role ?? summary?.workspace ?? item.providerId}{summary?.model ? ` · ${summary.model}` : ''}</small>
      <span><i className="lab-session-indicator agent-session-title" data-session-status={item.status ?? summary?.state} aria-hidden="true" />{sessionStatusLabel(item, t) || (summary ? stateLabel(summary.state, t) : placeholder ? t('sessions.directory.parentSession') : t('sessions.directory.discovered'))}{summary ? <time dateTime={summary.updatedAt}>{formatTime(summary.updatedAt)}</time> : null}</span>
    </button>{favorites && !placeholder ? <StarButton session={item} favorites={favorites} /> : null}</>;
  };
  return <>
    {searchable ? <label className="lab-session-search"><span>{t('sessions.directory.searchLabel')}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('sessions.directory.searchPlaceholder')} /></label> : null}
    <section className="lab-session-directory" aria-label={t('sessions.directory.discover')}>
      <div className="lab-directory-heading"><h2>{t('sessions.directory.discover')}</h2><div className="lab-directory-actions">{quickOpen}<button type="button" onClick={() => void load()} disabled={loading || !providerId}>{t('common.refresh')}</button></div></div>
      <p className="agent-visually-hidden">{t('sessions.directory.rootsHint')}</p>
      {listing ? <div className="lab-directory-listing">
        <button type="button" onClick={() => void listNativeSessions()} disabled={requestingListing || listing.refreshing}>
          {listing.refreshing ? t('sessions.directory.listing') : t('sessions.directory.listNative')}
        </button>
        <p role="status">{listing.refreshing ? t('sessions.directory.listingReading')
          : listing.error ? t('sessions.directory.listingStopped', { error: listing.error })
          : listing.listedAt ? t('sessions.directory.listedAt', { time: new Date(listing.listedAt).toLocaleString() })
          : t('sessions.directory.listingHint')}</p>
      </div> : null}
      {updates && !expired ? <button type="button" className="lab-directory-updates" onClick={() => void load()} disabled={loading}>{t('sessions.directory.updates')}</button> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      {loading ? <p className="lab-control-note" role="status">{t('sessions.directory.loading')}</p> : null}
      {!loading && !failure && discoveredTree.length === 0 ? <p className="lab-control-note">{search.trim() ? t('sessions.directory.noMatches') : t('sessions.directory.empty')}</p> : null}
      <SessionTree key={search.trim() ? `search:${search}` : 'all'} defaultExpanded={!!search.trim()} nodes={discoveredTree} activeKey={activeKey} renderRow={renderRow} renderRelated={node => {
        const children = new Set(node.children.map(child => child.key));
        const related = [...(links.get(node.key)?.values() ?? [])].filter(link => !children.has(sessionKey(link.target)) && (matches(node.session) || matches(link.target)));
        return related.length ? <ul className="lab-session-list lab-session-tree" aria-label={t('sessions.directory.related', { title: node.session.title })}>
          {related.map(link => <li key={sessionKey(link.target)} data-session-key={sessionKey(link.target)}><div className="lab-session-branch">
            <span className="lab-session-toggle-space" />{renderRow(link.target, false, link.kinds)}
          </div></li>)}
        </ul> : null;
      }} />
      {page?.hasMore ? <button type="button" className="lab-directory-more" disabled={loading || expired} onClick={() => void load(page.nextCursor)}>{t('sessions.directory.loadMore')}</button> : null}
    </section>
  </>;
}

function stateLabel(state: SessionSummary['state'], t: Translate): string {
  return state === 'running' ? t('sessions.directory.stateWorking') : state === 'waiting' ? t('sessions.directory.stateWaiting') : state === 'unavailable' ? t('sessions.directory.stateUnavailable') : state === 'idle' ? t('sessions.directory.stateIdle') : t('sessions.directory.stateUnknown');
}
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

export function SessionConfiguration({ directory, providerId, disabled, value, onChange, canBrowse = true }: {
  directory: SessionDirectoryClient; providerId: string; disabled: boolean; value: CreateSessionOptions; onChange(value: CreateSessionOptions): void; canBrowse?: boolean;
}) {
  const t = useTranslate();
  return <div className="lab-session-configuration">
    <WorkspaceSelect directory={directory} providerId={providerId} disabled={disabled} canBrowse={canBrowse}
      value={{ workspaceId: value.cwd ? undefined : value.workspaceId, path: value.cwd }}
      onChange={selection => onChange({ ...value, workspaceId: selection.workspaceId, cwd: selection.workspaceId ? undefined : selection.path })} />
    {providerId === 'dsh' ? <p className="lab-control-note">{t('sessions.directory.dshNote')}</p> : <>
      {!value.workspaceId ? <><label htmlFor="session-directory">{t('sessions.directory.workingDirectory')}</label><input id="session-directory" value={value.cwd ?? ''} placeholder={t('sessions.directory.providerDefault')} disabled={disabled} onChange={(event) => onChange({ ...value, cwd: event.target.value || undefined })} /></> : null}
      <label htmlFor="session-model">{t('sessions.directory.model')}</label><input id="session-model" value={value.model ?? ''} placeholder={t('sessions.directory.providerDefault')} disabled={disabled} onChange={(event) => onChange({ ...value, model: event.target.value || undefined })} />
      <label htmlFor="session-effort">{t('sessions.directory.effort')}</label><select id="session-effort" value={value.reasoningEffort ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value || undefined })}><option value="">{t('sessions.directory.providerDefault')}</option><option value="low">{t('sessions.directory.effortLow')}</option><option value="medium">{t('sessions.directory.effortMedium')}</option><option value="high">{t('sessions.directory.effortHigh')}</option><option value="xhigh">{t('sessions.directory.effortXhigh')}</option></select>
    </>}
  </div>;
}
