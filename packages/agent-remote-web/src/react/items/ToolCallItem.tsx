import { TimelineTitle } from '../TimelineTitle.js';
import { ToolResultView } from './ToolResultView.js';
import { Fragment, useId, useState } from 'react';
import { useItemDisclosure } from '../TimelineDisplay.js';
import { ToolResultPreview } from './ToolResultPreview.js';
import { ContentPreview } from './ContentPreview.js';
import type { AgentTimelineItem, AgentToolDetail } from '@agent-remote-controller/agent-remote-protocol';

const statusLabels = {
  running: 'Running', completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
} as const;

export type SessionLinkResolver = (nativeSessionId: string) => { href: string; title?: string; open(): Promise<void> } | undefined;

export function ToolCallItem({ item, resolveSessionLink }: { readonly item: Extract<AgentTimelineItem, { type: 'tool_call' }>; resolveSessionLink?: SessionLinkResolver }) {
  const { expanded, preview, toggle } = useItemDisclosure();
  const detailsId = useId();
  const [failure, setFailure] = useState<string>();
  const reference = item.detail.type === 'other' ? item.detail.sessionReference : undefined;
  const references = item.detail.type === 'other' ? item.detail.sessionReferences : undefined;
  const target = reference && resolveSessionLink?.(reference.nativeSessionId);
  const summary = toolSummary(item.detail);
  const offset = reference ? summary.indexOf(reference.title) : -1;
  const toggleLabel = <><span className="agent-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span><TimelineTitle disclose={toggle}><strong>{item.name}</strong></TimelineTitle></>;
  const linkedSummary = references?.length ? <span className="agent-tool-summary agent-tool-references">
    {summary}{' '}{references.map((entry, index) => {
      const destination = resolveSessionLink?.(entry.nativeSessionId);
      const title = entry.title === entry.nativeSessionId ? destination?.title || entry.title : entry.title;
      return <Fragment key={`${entry.nativeSessionId}-${index}`}>
        {index > 0 ? ', ' : ''}{destination ? <a href={destination.href} title={title} className="agent-session-reference" onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setFailure(undefined);
          void destination.open().catch(error => setFailure(error instanceof Error ? error.message : 'This session could not be opened.'));
        }}>{title}</a> : <span>{title}</span>}
      </Fragment>;
    })}
  </span> : reference && target ? <span className="agent-tool-summary">
    {offset >= 0 ? summary.slice(0, offset) : `${summary} `}
    <a href={target.href} title={reference.title} className="agent-session-reference" onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setFailure(undefined);
      void target.open().catch(error => setFailure(error instanceof Error ? error.message : 'This session could not be opened.'));
    }}>{reference.title}</a>
    {offset >= 0 ? summary.slice(offset + reference.title.length) : ''}
  </span> : null;
  return <article className={`agent-timeline-item agent-tool agent-state-${item.status}`}>
    <header className="agent-item-header">
      {linkedSummary ? <div className="agent-tool-toggle agent-tool-linked">
        <button type="button" className="agent-tool-name-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={toggle}>{toggleLabel}</button>
        {linkedSummary}
        <span className="agent-state-label">{statusLabels[item.status]}</span>
      </div> : <button
        className="agent-tool-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={toggle}
      >
        <span className="agent-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <TimelineTitle disclose={toggle}><strong>{item.name}</strong></TimelineTitle>
        <span className={`agent-tool-summary${item.detail.type === 'other' ? ' agent-tool-description' : ''}`}>{toolSummary(item.detail)}</span>
        <span className="agent-state-label">{statusLabels[item.status]}</span>
      </button>}
    </header>
    {preview ? <div className="agent-tool-preview">
      {item.detail.type === 'shell' ? <ContentPreview code text={item.detail.command} /> : null}
      {item.result ? <ToolResultPreview result={item.result} fileEdit={item.detail.type === 'edit' || item.detail.type === 'write'} search={item.detail.type === 'search'} /> : null}
      <button className="agent-preview-expand" type="button" aria-controls={detailsId} aria-expanded={false} onClick={toggle}>
        {item.result ? 'Show full result' : 'Show details'}
      </button>
    </div> : null}
    <div id={detailsId} className="agent-tool-details" hidden={!expanded}>
      {expanded ? <><ToolCallDetails detail={item.detail} />
      {item.result ? <ToolResultView result={item.result} fileEdit={item.detail.type === 'edit' || item.detail.type === 'write'} /> : null}</> : null}
    </div>
    {failure ? <p className="agent-history-error" role="alert">{failure}</p> : null}
    {item.error ? <pre className="agent-tool-error" role="alert" tabIndex={0}>{item.error}</pre> : null}
  </article>;
}

function toolSummary(detail: AgentToolDetail): string {
  switch (detail.type) {
    case 'shell': return detail.command.replace(/\s+/g, ' ').trim();
    case 'read':
    case 'edit':
    case 'write': return detail.filePath;
    case 'search': return detail.query;
    case 'fetch': return detail.url;
    case 'other': return detail.description;
  }
}

export function ToolCallDetails({ detail }: { readonly detail: AgentToolDetail }) {
  switch (detail.type) {
    case 'shell':
      return <div className="agent-tool-detail"><code>{detail.command}</code>{detail.cwd ? <small>{detail.cwd}</small> : null}</div>;
    case 'read':
    case 'edit':
    case 'write':
      return <div className="agent-tool-detail"><span>{detail.type}</span><code>{detail.filePath}</code></div>;
    case 'search':
      return <div className="agent-tool-detail"><span>query</span><code>{detail.query}</code></div>;
    case 'fetch':
      return <div className="agent-tool-detail"><span>URL</span><code>{detail.url}</code></div>;
    case 'other':
      return <p className="agent-tool-detail">{detail.description}{detail.sessionReferences?.length ? ` ${detail.sessionReferences.map(reference => reference.title).join(', ')}` : ''}</p>;
  }
}

export const ToolDetail = ToolCallDetails;
