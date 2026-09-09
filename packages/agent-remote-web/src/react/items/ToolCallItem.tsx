import { ToolResultView } from './ToolResultView.js';
import { useId, useState } from 'react';
import type { AgentTimelineItem, AgentToolDetail } from '@borgee/agent-remote-protocol';

const statusLabels = {
  running: 'Running', completed: 'Completed', failed: 'Failed', canceled: 'Canceled',
} as const;

export function ToolCallItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'tool_call' }> }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <article className={`agent-timeline-item agent-tool agent-state-${item.status}`}>
    <header className="agent-item-header">
      <button
        className="agent-tool-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="agent-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <strong>{item.name}</strong>
        <span className="agent-tool-summary">{toolSummary(item.detail)}</span>
        <span className="agent-state-label">{statusLabels[item.status]}</span>
      </button>
    </header>
    <div id={detailsId} className="agent-tool-details" hidden={!expanded}>
      <ToolCallDetails detail={item.detail} />
      {item.result ? <ToolResultView result={item.result} /> : null}
    </div>
    {item.error ? <p className="agent-tool-error" role="alert">{item.error}</p> : null}
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
      return <p className="agent-tool-detail">{detail.description}</p>;
  }
}

export const ToolDetail = ToolCallDetails;
