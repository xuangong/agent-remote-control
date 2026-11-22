import { errorWords } from '@orchardworks/agent-client';
import { useFeedbackToast } from '../../kernel/Toast.js';
import { Fragment, type ReactElement, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteSessionStatus } from '@orchardworks/agent-client';
import { createTimelineRenderModel, useTranslate, type SessionLinkResolver } from '@orchardworks/agent-client-web/react';
import { traceItemLabel, traceItemLabels, traceItemStatus, traceItemSummary, traceSequence, traceSessionReferences, type TraceEntryRequest } from '../../kernel/trace-model.js';
import { TraceEntryDetails } from './TraceEntryDetails.js';
import { TraceSessionLinks } from './TraceSessionLinks.js';

export function TraceView(props: Parameters<typeof TraceBrowser>[0]) {
  const retained = useRef<ReactElement | null>(null);
  if (props.visible !== false) retained.current = <TraceBrowser {...props} />;
  return retained.current;
}

function TraceBrowser({ state, visible = true, revealEntry, onShowConversation, sessionStatus, sessionTitle, resolveSessionLink, onLoadOlder, headingStart }: {
  headingStart?: ReactNode;
  state?: AgentReplicaState; visible?: boolean; revealEntry?: TraceEntryRequest; onShowConversation?: (key: string) => void;
  sessionStatus?: RemoteSessionStatus; sessionTitle?: string; resolveSessionLink?: SessionLinkResolver; onLoadOlder?: () => void | Promise<void>;
}) {
  const t = useTranslate();
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast(t('diagnostics.history.title'), failure);
  const loadingRef = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const consumedRequest = useRef<number>();
  const [focusRevision, setFocusRevision] = useState(0);
  const timeline = state?.timeline;
  const rows = useMemo(() => createTimelineRenderModel(timeline?.entries ?? []).map(row => ({
    ...row, search: JSON.stringify(row.entry).toLocaleLowerCase(),
  })), [timeline?.entries]);
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
    try { await onLoadOlder(); } catch (error) { setFailure(errorWords(error, t, 'diagnostics.history.failed')); }
    finally { loadingRef.current = false; setLoading(false); }
  }

  return <div className="lab-trace-layout" aria-label={t('diagnostics.trace.label')}>
    <header className="lab-workbench-heading"><div>{headingStart}<p className="lab-eyebrow">Trace</p><h2>{t('diagnostics.trace.heading')}</h2></div>
      <span>{timeline?.epoch ? `${timeline.epoch} · seq ${Math.max(0, timeline.nextSeq - 1)}` : t('diagnostics.trace.noReplica')}</span>
    </header>
    <div className="lab-trace-controls">
      <p className="lab-trace-notice">{t('diagnostics.trace.notice')}</p>
      {waits.length ? <details className="lab-trace-waits" aria-label={t('diagnostics.waits.label')} open>
        <summary>{t('diagnostics.waits.label')} <span>{waits.length}</span></summary>
        <ul>{waits.map(({ entry, key }) => {
          const current = sessionStatus === 'ready' && state?.agent?.activeTurn?.turnId === entry.turnId && entry.turnId !== undefined;
          return <li key={key} data-wait-call={entry.item.type === 'tool_call' ? entry.item.callId : undefined}>
            <div><strong className="agent-session-title" data-session-status={state?.agent?.status}>{sessionTitle || state?.agent?.runtimeInfo.sessionId || t('diagnostics.waits.thisSession')}</strong>
              <span>{current ? t('diagnostics.waits.waitingFor') : t('diagnostics.waits.lastWaitingFor')}</span>
              {traceSessionReferences(entry.item).length ? <TraceSessionLinks item={entry.item} resolveSessionLink={resolveSessionLink} /> : <span>{traceItemSummary(entry.item)}</span>}
            </div>
            <button type="button" onClick={() => selectEntry(key)}>{t('diagnostics.trace.inspect', { sequence: traceSequence(entry.seqStart, entry.seqEnd) })}</button>
          </li>;
        })}</ul>
      </details> : null}
      <div className="lab-trace-filters">
        <input ref={searchRef} aria-label={t('diagnostics.trace.search')} type="search" placeholder={t('diagnostics.trace.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label={t('diagnostics.trace.typeFilter')} value={type} onChange={event => setType(event.target.value)}><option value="all">{t('diagnostics.trace.allTypes')}</option>
          {Object.entries(traceItemLabels(t)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span role="status">{t('diagnostics.trace.loaded', { shown: matches.length, total: rows.length })}</span>
      </div>
    </div>
    <div className="lab-trace-browser" data-has-selection={selected !== undefined || undefined}>
      <ol className="lab-trace-list" ref={listRef} aria-label={t('diagnostics.trace.events')}>
        {timeline?.hasOlder ? <li className="lab-trace-history"><button type="button" disabled={!onLoadOlder || loading} aria-busy={loading} onClick={() => void loadOlder()}>{loading ? t('common.loading') : t('diagnostics.trace.loadEarlier')}</button>{failure ? <p role="alert">{failure}</p> : null}</li> : null}
        {matches.map(({ entry, key }, index) => <Fragment key={key}>
          {index === 0 || entry.turnId !== matches[index - 1]?.entry.turnId ? <li className="lab-trace-turn"><span>{t('diagnostics.entry.turn')}</span><code>{entry.turnId ?? t('diagnostics.notRecorded')}</code></li> : null}
          <li className="lab-trace-row"><button type="button" data-trace-entry-key={key} aria-current={selected === key ? 'true' : undefined} onClick={() => selectEntry(key)}>
            <code className="lab-trace-sequence">{traceSequence(entry.seqStart, entry.seqEnd)}</code>
            <span className="lab-trace-event"><strong>{traceItemLabel(entry.item, t)}</strong><span className="lab-trace-summary">{traceItemSummary(entry.item).slice(0, 180)}</span></span>
            <span className="lab-trace-meta"><span className="lab-trace-status" data-status={traceItemStatus(entry.item)}>{traceItemStatus(entry.item) ?? entry.item.type}</span>
              <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time></span>
          </button></li>
        </Fragment>)}
        {!matches.length ? <li className="lab-trace-empty">{rows.length ? t('diagnostics.trace.noMatches') : t('diagnostics.trace.noEvents')}</li> : null}
      </ol>
      <section className="lab-trace-detail" aria-label={t('diagnostics.trace.details')} ref={detailRef} tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); } }}>
        {selected ? <><button type="button" className="lab-trace-close" onClick={closeDetails}>{t('diagnostics.trace.backToEvents')}</button>
          {selection ? <TraceEntryDetails key={selection.key} entry={selection.entry} resolveSessionLink={resolveSessionLink}
            onShowConversation={onShowConversation ? () => onShowConversation(selection.key) : undefined} />
            : <p role="status">{t('diagnostics.trace.gone')}</p>}
        </> : <div className="lab-trace-detail-empty"><p className="lab-eyebrow">{t('diagnostics.trace.eventDetails')}</p><p>{t('diagnostics.trace.selectEvent')}</p></div>}
      </section>
    </div>
  </div>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
