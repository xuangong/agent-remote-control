import { useContext, useMemo, type ReactNode } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent } from './MarkdownContent.js';
import type { MarkdownResourceContext } from './markdown-resources.js';
import { TimelineTimeContext } from './TimelineTitle.js';

// Recognize only a complete leading envelope; retain the original item for search and navigation.
const envelopePrefix = /^(Message Type:[ \t]*[A-Z][A-Z0-9_]*[ \t]*\r?\nTask name:[ \t]*\S[^\r\n]*\r?\nSender:[ \t]*\S[^\r\n]*\r?\nPayload:)(?:[ \t]*\r?\n|[ \t]?)/;

export function CommunicationContent({ item, timestamp, resourceContext, action }: {
  item: Extract<AgentTimelineItem, { type: 'agent_communication' }>;
  timestamp?: string;
  resourceContext?: MarkdownResourceContext;
  action?: ReactNode;
}) {
  const time = useContext(TimelineTimeContext);
  const content = useMemo(() => {
    const match = envelopePrefix.exec(item.text);
    return match ? { header: match[1], payload: item.text.slice(match[0].length) } : { payload: item.text };
  }, [item.text]);
  const dateTime = timestamp ?? time?.timestamp;
  return <>
    <div className="agent-letter-body"><MarkdownContent markdown={content.payload} resourceContext={resourceContext} /></div>
    <div className="agent-letter-footer">
      {action}
      <details className="agent-letter-details">
        <summary>Details</summary>
        <div className="agent-letter-metadata">
          <span className="agent-letter-participants">{item.sender} → {item.recipient}</span>
          {dateTime ? <time dateTime={dateTime}>{time ? `${time.date} ${time.time}` : dateTime}</time> : null}
          {content.header ? <pre>{content.header}</pre> : null}
        </div>
      </details>
    </div>
  </>;
}
