import { useState } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { ToolCallDetails, useTranslate, type SessionLinkResolver } from '@orchardworks/agent-client-web/react';
import { traceItemLabel, traceItemStatus, traceItemSummary, traceSequence, traceSourceRanges, traceSessionReferences } from '../../kernel/trace-model.js';
import { TraceSessionLinks } from './TraceSessionLinks.js';

const collapseLabelKeys = { assistant_merge: 'diagnostics.merge.assistant', reasoning_merge: 'diagnostics.merge.reasoning', tool_lifecycle: 'diagnostics.merge.toolLifecycle' } as const;

export function TraceEntryDetails({ entry, onShowConversation, resolveSessionLink }: {
  entry: ProjectedTimelineEntry; onShowConversation?: () => void; resolveSessionLink?: SessionLinkResolver;
}) {
  const t = useTranslate();
  const [showJson, setShowJson] = useState(false);
  const item = entry.item;
  return <>
    <div className="lab-trace-detail-title"><span className="lab-eyebrow">{traceSequence(entry.seqStart, entry.seqEnd)}</span>
      <h3>{traceItemLabel(item, t)}</h3><span className="lab-trace-status" data-status={traceItemStatus(item)}>{traceItemStatus(item) ?? item.type}</span>
    </div>
    {onShowConversation ? <button type="button" className="lab-trace-conversation-link" onClick={onShowConversation}>{t('diagnostics.showInConversation')}</button> : null}
    <dl className="lab-state-grid lab-trace-entry-meta">
      <div><dt>{t('diagnostics.entry.provider')}</dt><dd>{entry.providerId}</dd></div>
      <div><dt>{t('diagnostics.entry.turn')}</dt><dd>{entry.turnId ?? t('diagnostics.notRecorded')}</dd></div>
      <div><dt>{t('diagnostics.entry.timestamp')}</dt><dd><time dateTime={entry.timestamp}>{entry.timestamp}</time></dd></div>
      <div><dt>{t('diagnostics.entry.sourceSequences')}</dt><dd>{traceSourceRanges(entry, t)}</dd></div>
      <div><dt>{t('diagnostics.entry.merges')}</dt><dd>{entry.collapsed.map(reason => t(collapseLabelKeys[reason])).join(', ') || t('common.none')}</dd></div>
      {item.type === 'tool_call' ? <div><dt>{t('diagnostics.event.toolCall')}</dt><dd>{item.callId}</dd></div> : null}
      {item.type === 'tool_call' && item.result?.durationMs !== undefined ? <div><dt>{t('diagnostics.entry.duration')}</dt><dd>{item.result.durationMs} ms</dd></div> : null}
      {item.type === 'tool_call' && item.result?.exitCode !== undefined ? <div><dt>{t('diagnostics.entry.exitCode')}</dt><dd>{item.result.exitCode}</dd></div> : null}
    </dl>
    {traceSessionReferences(item).length ? <section className="lab-trace-detail-section"><h4>{item.type === 'tool_call' && item.name === 'agent.wait' ? t('diagnostics.entry.waitTargets') : t('diagnostics.entry.relatedSessions')}</h4>
      <TraceSessionLinks item={item} resolveSessionLink={resolveSessionLink} />
    </section> : null}
    <section className="lab-trace-detail-section"><h4>{item.type === 'tool_call' ? t('diagnostics.entry.toolInput') : t('diagnostics.entry.content')}</h4>
      {item.type === 'tool_call' ? <ToolCallDetails detail={item.detail} /> : <pre tabIndex={0}>{item.type === 'interaction' || item.type === 'todo' ? JSON.stringify(item, null, 2) : traceItemSummary(item)}</pre>}
    </section>
    {item.type === 'tool_call' ? <section className="lab-trace-detail-section"><h4>{t('diagnostics.entry.result')}</h4>
      {item.result?.truncated ? <p>{t('diagnostics.entry.truncated')}</p> : null}
      {item.result ? item.result.content.map((content, index) => <pre key={index} tabIndex={0}>{content.type === 'text' ? content.text : JSON.stringify(content.value, null, 2)}</pre>)
        : <p>{item.status === 'running' ? t('diagnostics.entry.noResultYet') : t('diagnostics.entry.noResult')}</p>}
      {item.error ? <p className="lab-trace-error">{item.error}</p> : null}
    </section> : null}
    {entry.resources.length ? <section className="lab-trace-detail-section"><h4>{t('diagnostics.entry.resources', { count: entry.resources.length })}</h4>
      <pre tabIndex={0}>{JSON.stringify(entry.resources, null, 2)}</pre>
    </section> : null}
    <details className="lab-trace-detail-section" onToggle={event => setShowJson(event.currentTarget.open)}>
      <summary>{t('diagnostics.entry.json')}</summary>
      {showJson ? <pre tabIndex={0}>{JSON.stringify(entry, null, 2)}</pre> : null}
    </details>
    <p className="lab-trace-detail-note">{t('diagnostics.entry.note')}</p>
  </>;
}
