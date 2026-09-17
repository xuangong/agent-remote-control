import { useState } from 'react';
import type { ProjectedTimelineEntry } from '@agent-remote-controller/agent-remote-protocol';
import { ToolCallDetails, type SessionLinkResolver } from '@agent-remote-controller/agent-remote-web/react';
import { traceItemLabel, traceItemStatus, traceItemSummary, traceSequence, traceSourceRanges, traceSessionReferences } from '../trace-model.js';
import { TraceSessionLinks } from './TraceSessionLinks.js';

const collapseLabels = { assistant_merge: 'Assistant updates', reasoning_merge: 'Reasoning updates', tool_lifecycle: 'Tool lifecycle' };

export function TraceEntryDetails({ entry, onShowConversation, resolveSessionLink }: {
  entry: ProjectedTimelineEntry; onShowConversation?: () => void; resolveSessionLink?: SessionLinkResolver;
}) {
  const [showJson, setShowJson] = useState(false);
  const item = entry.item;
  return <>
    <div className="lab-trace-detail-title"><span className="lab-eyebrow">{traceSequence(entry.seqStart, entry.seqEnd)}</span>
      <h3>{traceItemLabel(item)}</h3><span className="lab-trace-status" data-status={traceItemStatus(item)}>{traceItemStatus(item) ?? item.type}</span>
    </div>
    {onShowConversation ? <button type="button" className="lab-trace-conversation-link" onClick={onShowConversation}>Show in Conversation</button> : null}
    <dl className="lab-state-grid lab-trace-entry-meta">
      <div><dt>Provider</dt><dd>{entry.providerId}</dd></div>
      <div><dt>Turn</dt><dd>{entry.turnId ?? 'Not recorded'}</dd></div>
      <div><dt>Recorded timestamp</dt><dd><time dateTime={entry.timestamp}>{entry.timestamp}</time></dd></div>
      <div><dt>Source sequences</dt><dd>{traceSourceRanges(entry)}</dd></div>
      <div><dt>Projection merges</dt><dd>{entry.collapsed.map(reason => collapseLabels[reason]).join(', ') || 'None'}</dd></div>
      {item.type === 'tool_call' ? <div><dt>Tool call</dt><dd>{item.callId}</dd></div> : null}
      {item.type === 'tool_call' && item.result?.durationMs !== undefined ? <div><dt>Recorded tool duration</dt><dd>{item.result.durationMs} ms</dd></div> : null}
      {item.type === 'tool_call' && item.result?.exitCode !== undefined ? <div><dt>Exit code</dt><dd>{item.result.exitCode}</dd></div> : null}
    </dl>
    {traceSessionReferences(item).length ? <section className="lab-trace-detail-section"><h4>{item.type === 'tool_call' && item.name === 'agent.wait' ? 'Wait targets' : 'Related sessions'}</h4>
      <TraceSessionLinks item={item} resolveSessionLink={resolveSessionLink} />
    </section> : null}
    <section className="lab-trace-detail-section"><h4>{item.type === 'tool_call' ? 'Normalized tool input' : 'Content'}</h4>
      {item.type === 'tool_call' ? <ToolCallDetails detail={item.detail} /> : <pre tabIndex={0}>{item.type === 'interaction' || item.type === 'todo' ? JSON.stringify(item, null, 2) : traceItemSummary(item)}</pre>}
    </section>
    {item.type === 'tool_call' ? <section className="lab-trace-detail-section"><h4>Result</h4>
      {item.result?.truncated ? <p>Result truncated by the Provider.</p> : null}
      {item.result ? item.result.content.map((content, index) => <pre key={index} tabIndex={0}>{content.type === 'text' ? content.text : JSON.stringify(content.value, null, 2)}</pre>)
        : <p>{item.status === 'running' ? 'No result received yet.' : 'No result recorded.'}</p>}
      {item.error ? <p className="lab-trace-error">{item.error}</p> : null}
    </section> : null}
    {entry.resources.length ? <section className="lab-trace-detail-section"><h4>Resource bindings · {entry.resources.length}</h4>
      <pre tabIndex={0}>{JSON.stringify(entry.resources, null, 2)}</pre>
    </section> : null}
    <details className="lab-trace-detail-section" onToggle={event => setShowJson(event.currentTarget.open)}>
      <summary>Normalized event JSON</summary>
      {showJson ? <pre tabIndex={0}>{JSON.stringify(entry, null, 2)}</pre> : null}
    </details>
    <p className="lab-trace-detail-note">This is the current projected event. Source sequences identify contributing events; intermediate payloads are not retained here. Tool duration is shown only when recorded by the Provider.</p>
  </>;
}
