import { useFeedbackToast } from './Toast.js';
import { sessionActivity } from '../session-activity.js';
import { Fragment, type ReactElement, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { createTimelineRenderModel, type SessionLinkResolver } from '@orchardworks/agent-remote-web/react';
import { traceItemLabel, traceItemLabels, traceItemStatus, traceItemSummary, traceSequence, traceSessionReferences, type TraceEntryRequest } from '../trace-model.js';
import { TraceEntryDetails } from './TraceEntryDetails.js';
import { TraceSessionLinks } from './TraceSessionLinks.js';

export function TraceView(props: Parameters<typeof TraceBrowser>[0]) {
  const retained = useRef<ReactElement | null>(null);
  if (props.visible !== false) retained.current = <TraceBrowser {...props} />;
  return retained.current;
}

function TraceBrowser({ state, visible = true, revealEntry, onShowConversation, sessionStatus, sessionTitle, resolveSessionLink, onLoadOlder }: {
  state?: AgentReplicaState; visible?: boolean; revealEntry?: TraceEntryRequest; onShowConversation?: (key: string) => void;
  sessionStatus?: RemoteSessionStatus; sessionTitle?: string; resolveSessionLink?: SessionLinkResolver; onLoadOlder?: () => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Conversation history', failure);
  const loadingRef = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const consumedRequest = useRef<number>();
  const [focusRevision, setFocusRevision] = useState(0);
  const timeline = state?.timeline;
  const rows = useMemo(() => createTimelineRenderModel(timeline?.epoch ?? null, timeline?.entries ?? []).map(row => ({
    ...row, search: JSON.stringify(row.entry).toLocaleLowerCase(),
  })), [timeline?.epoch, timeline?.entries]);
  const matches = rows.filter(row => (type === 'all' || row.entry.item.type === type) && row.search.includes(query.trim().toLocaleLowerCase()));
  const selection = rows.find(row => row.key === selected);
  const waits = rows.filter(row => row.entry.item.type === 'tool_call' && row.entry.item.name === 'agent.wait' && row.entry.item.status === 'running');

  useLayoutEffect(() => {
    if (!revealEntry || !visible || consumedRequest.current === revealEntry.requestId) return;
    consumedRequest.current = revealEntry.requestId;
    setQuery(''); setType('all'); selectEntry(revealEntry.key);
  }, [revealEntry, visible]);
  useLayoutEffect(() => {
    if (!selected) return;
    detailRef.current?.focus({ preventScroll: true });
    if (detailRef.current) detailRef.current.scrollTop = 0;
    const list = listRef.current;
    const row = Array.from(list?.querySelectorAll<HTMLButtonElement>('[data-trace-entry-key]') ?? []).find(node => node.dataset.traceEntryKey === selected);
    if (list && row && list.clientHeight > 0) {
      const bounds = list.getBoundingClientRect();
      const target = row.getBoundingClientRect();
      if (target.top < bounds.top || target.bottom > bounds.bottom) list.scrollTop += target.top - bounds.top - (list.clientHeight - target.height) / 2;
    }
  }, [selected, focusRevision]);

  function selectEntry(key: string) {
    setSelected(key);
    setFocusRevision(value => value + 1);
  }

  function closeDetails() {
    const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-trace-entry-key]') ?? []).find(node => node.dataset.traceEntryKey === selected);
    setSelected(undefined);
    window.requestAnimationFrame(() => (row?.isConnected ? row : searchRef.current)?.focus({ preventScroll: true }));
  }

  async function loadOlder() {
    if (!onLoadOlder || loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setFailure(undefined);
    try { await onLoadOlder(); } catch (error) { setFailure(error instanceof Error ? error.message : 'Earlier activity could not be loaded.'); }
    finally { loadingRef.current = false; setLoading(false); }
  }

  return <div className="lab-trace-layout" aria-label="Normalized Timeline trace">
    <header className="lab-workbench-heading"><div><p className="lab-eyebrow">Trace</p><h2>Execution events</h2></div>
      <span>{timeline?.epoch ? `${timeline.epoch} · seq ${Math.max(0, timeline.nextSeq - 1)}` : 'No replica attached'}</span>
    </header>
    <div className="lab-trace-controls">
      <p className="lab-trace-notice">Inspect the normalized Timeline received by this client. Provider-native and raw wire frames are not retained by the public replica.</p>
      {waits.length ? <details className="lab-trace-waits" aria-label="Agent waits" open>
        <summary>Agent waits <span>{waits.length}</span></summary>
        <ul>{waits.map(({ entry, key }) => {
          const current = sessionStatus === 'ready' && state?.agent?.activeTurn?.turnId === entry.turnId && entry.turnId !== undefined;
          return <li key={key} data-wait-call={entry.item.type === 'tool_call' ? entry.item.callId : undefined}>
            <div><strong className="agent-session-title" data-session-status={sessionActivity(state)}>{sessionTitle || state?.agent?.runtimeInfo.sessionId || 'This session'}</strong>
              <span>{current ? 'Waiting for' : 'Last observed waiting for'}</span>
              {traceSessionReferences(entry.item).length ? <TraceSessionLinks item={entry.item} resolveSessionLink={resolveSessionLink} /> : <span>{traceItemSummary(entry.item)}</span>}
            </div>
            <button type="button" onClick={() => selectEntry(key)}>Inspect {traceSequence(entry.seqStart, entry.seqEnd)}</button>
          </li>;
        })}</ul>
      </details> : null}
      <div className="lab-trace-filters">
        <input ref={searchRef} aria-label="Search trace" type="search" placeholder="Search events, paths, results…" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="Trace event type" value={type} onChange={event => setType(event.target.value)}><option value="all">All event types</option>
          {Object.entries(traceItemLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span role="status">{matches.length} / {rows.length} loaded</span>
      </div>
    </div>
    <div className="lab-trace-browser" data-has-selection={selected !== undefined || undefined}>
      <ol className="lab-trace-list" ref={listRef} aria-label="Trace events">
        {timeline?.hasOlder ? <li className="lab-trace-history"><button type="button" disabled={!onLoadOlder || loading} aria-busy={loading} onClick={() => void loadOlder()}>{loading ? 'Loading…' : 'Load earlier activity'}</button>{failure ? <p role="alert">{failure}</p> : null}</li> : null}
        {matches.map(({ entry, key }, index) => <Fragment key={key}>
          {index === 0 || entry.turnId !== matches[index - 1]?.entry.turnId ? <li className="lab-trace-turn"><span>Turn</span><code>{entry.turnId ?? 'Not recorded'}</code></li> : null}
          <li className="lab-trace-row"><button type="button" data-trace-entry-key={key} aria-current={selected === key ? 'true' : undefined} onClick={() => selectEntry(key)}>
            <code className="lab-trace-sequence">{traceSequence(entry.seqStart, entry.seqEnd)}</code>
            <span className="lab-trace-event"><strong>{traceItemLabel(entry.item)}</strong><span className="lab-trace-summary">{traceItemSummary(entry.item).slice(0, 180)}</span></span>
            <span className="lab-trace-meta"><span className="lab-trace-status" data-status={traceItemStatus(entry.item)}>{traceItemStatus(entry.item) ?? entry.item.type}</span>
              <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time></span>
          </button></li>
        </Fragment>)}
        {!matches.length ? <li className="lab-trace-empty">{rows.length ? 'No matching events. Change your search or filter.' : 'No projected events are available yet.'}</li> : null}
      </ol>
      <section className="lab-trace-detail" aria-label="Trace entry details" ref={detailRef} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); } }}>
        {selected ? <><button type="button" className="lab-trace-close" onClick={closeDetails}>Back to events</button>
          {selection ? <TraceEntryDetails key={selection.key} entry={selection.entry} resolveSessionLink={resolveSessionLink}
            onShowConversation={onShowConversation ? () => onShowConversation(selection.key) : undefined} />
            : <p role="status">This event is no longer in the loaded timeline. Select another event.</p>}
        </> : <div className="lab-trace-detail-empty"><p className="lab-eyebrow">Event details</p><p>Select an event to inspect its input, result, and source sequences.</p></div>}
      </section>
    </div>
  </div>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
