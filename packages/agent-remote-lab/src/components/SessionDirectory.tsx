import { StarButton } from './SessionFavorites.js';
import type { SessionStars } from '../hooks/useSessionStars.js';
import { useFeedbackToast } from './Toast.js';
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker.js';
import { useEffect, useRef, useState } from 'react';
import { sessionForest, sessionKey, sessionStatusLabel, type SessionEntry } from '../session-tree.js';
import { SessionTree } from './SessionTree.js';
import { DirectoryError, type CreateSessionOptions, type OpenedSession, type SessionCatalogPage, type SessionDirectoryClient, type SessionSummary, type SessionWorkspace } from '../directory-client.js';

interface Props {
  searchable?: boolean;
  favorites?: SessionStars;
  directory: SessionDirectoryClient;
  providerId: string;
  activeAgentId?: string;
  opened: readonly OpenedSession[];
  known?: readonly SessionEntry[];
  hostId?: string;
  onOpenRelated?(item: SessionEntry): void;
  busy: boolean;
  revision: number;
  onOpen(item: SessionSummary): void;
  onSelect(item: OpenedSession): void;
  onClose(agentId: string): void;
}

export function SessionDirectory({ favorites, searchable = false, directory, providerId, activeAgentId, opened, known = [], hostId = 'local', onOpenRelated, busy, revision, onOpen, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('');
  const matches = (item: SessionEntry) => !search.trim() || [item.title, item.nativeSessionId, item.providerId, ('workspace' in item && typeof item.workspace === 'string' ? item.workspace : '')].some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()));
  const [page, setPage] = useState<SessionCatalogPage | undefined>(directory.cachedPages.get(providerId));
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Session list', failure);
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
      setFailure(isExpired ? 'This session list expired. Refresh to see the latest sessions.' : error instanceof Error ? error.message : 'Could not load sessions.');
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
    if (!directory.cachedPages.get(providerId)) void load();
    return () => { generation.current += 1; inFlight.current = false; };
  }, [providerId, directory]);

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
    const timer = window.setInterval(() => void inspect(), 5_000);
    return () => { retired = true; window.clearInterval(timer); };
  }, [providerId, directory]);

  const discovered = new Map<string, SessionEntry>((page?.items ?? []).map((item) => [sessionKey({ ...item, hostId }), { ...item, hostId }]));
  for (const item of known) {
    if ((item.hostId ?? 'local') !== hostId || item.providerId !== providerId) continue;
    if (item.parentNativeSessionId || discovered.has(sessionKey(item))) discovered.set(sessionKey(item), { ...discovered.get(sessionKey(item)), ...item });
  }
  const discoveredTree = sessionForest([...discovered.values()].filter(matches), known);
  const active = known.find((item) => item.agentId === activeAgentId) ?? opened.find((item) => item.agentId === activeAgentId);
  const activeKey = active ? sessionKey(active) : undefined;
  const openedByKey = new Map(opened.map(item => [sessionKey(item), item]));
  const openRelated = (item: SessionEntry) => {
    if (onOpenRelated) onOpenRelated(item);
    else { const saved = opened.find((entry) => sessionKey(entry) === sessionKey(item)); if (saved) onSelect(saved); }
  };
  return <>
    {searchable ? <label className="lab-session-search">Search loaded sessions<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, workspace, or ID" /></label> : null}
    <section className="lab-session-directory" aria-label="Discover sessions">
      <div className="lab-directory-heading"><h2>Discover sessions</h2><button type="button" onClick={() => void load()} disabled={loading || !providerId}>Refresh</button></div>
      <p className="agent-visually-hidden">Roots by activity · Subagents by creation</p>
      {updates && !expired ? <button type="button" className="lab-directory-updates" onClick={() => void load()} disabled={loading}>Updates available · Refresh</button> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      {loading ? <p className="lab-control-note" role="status">Loading sessions…</p> : null}
      {!loading && !failure && discoveredTree.length === 0 ? <p className="lab-control-note">{search.trim() ? 'No matching loaded sessions.' : 'No sessions yet. Create a new session to get started.'}</p> : null}
      <SessionTree key={search.trim() ? `search:${search}` : 'all'} defaultExpanded={!!search.trim()} nodes={discoveredTree} activeKey={activeKey} renderRow={(item, placeholder) => {
        const summary = page?.items.find((entry) => entry.nativeSessionId === item.nativeSessionId);
        const related = Boolean(item.parentNativeSessionId) || !summary;
        const saved = openedByKey.get(sessionKey(item));
        const current = sessionKey(item) === activeKey;
        return <><button type="button" className="lab-session-row" aria-current={current ? 'page' : undefined} disabled={busy || (!saved && (related ? !onOpenRelated : summary?.state === 'unavailable'))} onClick={() => { if (saved) onSelect(saved); else if (related) openRelated(item); else if (summary) onOpen(summary); }} title={summary?.workspace}>
          <strong className="agent-session-title" data-session-status={item.status ?? summary?.state}>{item.title || item.nativeSessionId}</strong>
          <small>{current ? 'Current session · ' : ''}{item.role ?? summary?.workspace ?? item.providerId}{summary?.model ? ` · ${summary.model}` : ''}</small>
          <span><i className="lab-session-indicator agent-session-title" data-session-status={item.status ?? summary?.state} aria-hidden="true" />{sessionStatusLabel(item) || (summary ? stateLabel(summary.state) : placeholder ? 'Parent session' : 'Discovered')}{summary ? <time dateTime={summary.updatedAt}>{formatTime(summary.updatedAt)}</time> : null}</span>
        </button>{favorites && !placeholder ? <StarButton session={item} favorites={favorites} /> : null}</>;
      }} />
      {page?.hasMore ? <button type="button" className="lab-directory-more" disabled={loading || expired} onClick={() => void load(page.nextCursor)}>Load more sessions</button> : null}
    </section>
  </>;
}

function stateLabel(state: SessionSummary['state']): string { return state === 'running' ? 'Working' : state === 'waiting' ? 'Waiting' : state === 'unavailable' ? 'Unavailable' : state === 'idle' ? 'Idle' : 'Unknown'; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

export function SessionConfiguration({ directory, providerId, disabled, value, onChange, canBrowse = true }: {
  directory: SessionDirectoryClient; providerId: string; disabled: boolean; value: CreateSessionOptions; onChange(value: CreateSessionOptions): void; canBrowse?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [workspaces, setWorkspaces] = useState<SessionWorkspace[]>([]);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Workspace list', failure);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let retired = false;
    setPicking(false);
    setWorkspaces([]);
    setFailure(undefined);
    if (!providerId) return;
    setLoading(true);
    void directory.workspaces(providerId).then((result) => { if (!retired) setWorkspaces(result.workspaces); })
      .catch((error) => { if (!retired) setFailure(error instanceof Error ? error.message : 'Could not load workspaces.'); })
      .finally(() => { if (!retired) setLoading(false); });
    return () => { retired = true; };
  }, [directory, providerId, retry]);
  return <div className="lab-session-configuration">
    <label htmlFor="session-workspace">Workspace</label>
    <div className="lab-workspace-field"><select id="session-workspace" value={value.cwd ? '__custom_folder' : value.workspaceId ?? ''} disabled={disabled || loading} onChange={(event) => onChange({ ...value, workspaceId: event.target.value || undefined, cwd: undefined })}>
      <option value="">Host default</option>
      {value.cwd ? <option value="__custom_folder">{value.cwd}</option> : null}
      {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.path}</option>)}
    </select>
    {canBrowse && providerId !== 'dsh' ? <button type="button" disabled={disabled || loading} onClick={() => setPicking(true)}>Browse…</button> : null}</div>
    {picking && canBrowse && !disabled ? <WorkspaceFolderPicker key={providerId} directory={directory} providerId={providerId} workspaces={workspaces}
      initialPath={value.cwd ?? workspaces.find(workspace => workspace.id === value.workspaceId)?.path}
      onClose={() => setPicking(false)} onSelect={cwd => { onChange({ ...value, cwd, workspaceId: undefined }); setPicking(false); }} /> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure} <button type="button" onClick={() => setRetry((current) => current + 1)}>Retry workspaces</button></p> : null}
    {providerId === 'dsh' ? <p className="lab-control-note">Model, reasoning effort, and session mode follow DSH settings.</p> : <>
      {!value.workspaceId ? <><label htmlFor="session-directory">Working directory</label><input id="session-directory" value={value.cwd ?? ''} placeholder="Provider default" disabled={disabled} onChange={(event) => onChange({ ...value, cwd: event.target.value || undefined })} /></> : null}
      <label htmlFor="session-model">Model</label><input id="session-model" value={value.model ?? ''} placeholder="Provider default" disabled={disabled} onChange={(event) => onChange({ ...value, model: event.target.value || undefined })} />
      <label htmlFor="session-effort">Reasoning effort</label><select id="session-effort" value={value.reasoningEffort ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value || undefined })}><option value="">Provider default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select>
    </>}
  </div>;
}
