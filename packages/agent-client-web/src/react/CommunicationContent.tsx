import { useContext, useMemo, type ReactNode } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent } from './MarkdownContent.js';
import type { MarkdownResourceContext } from './markdown-resources.js';
import { TimelineTimeContext } from './TimelineTitle.js';

// Recognize only a complete leading envelope; retain the original item for search and navigation.
const envelopePrefix = /^(Message Type:[ \t]*[A-Z][A-Z0-9_]*[ \t]*\r?\nTask name:[ \t]*\S[^\r\n]*\r?\nSender:[ \t]*\S[^\r\n]*\r?\nPayload:)(?:[ \t]*\r?\n|[ \t]?)/;

export function CommunicationTitle({ sender, recipient }: { sender: string; recipient: string }) {
  return <>
    <svg className="agent-letter-envelope" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>
    <span className="agent-letter-participants">{sender} → {recipient}</span>
  </>;
}

export function CommunicationContent({ item, timestamp, resourceContext, heading }: {
  item: Extract<AgentTimelineItem, { type: 'agent_communication' }>;
  timestamp?: string;
  resourceContext?: MarkdownResourceContext;
  heading?: ReactNode;
}) {
  const time = useContext(TimelineTimeContext);
  const content = useMemo(() => {
    const match = envelopePrefix.exec(item.text);
    return match ? { header: match[1], payload: item.text.slice(match[0].length) } : { payload: item.text };
  }, [item.text]);
  const dateTime = timestamp ?? time?.timestamp;
  return <>
    <header className="agent-letter-heading">
      {heading ?? <div className="agent-letter-title"><CommunicationTitle sender={item.sender} recipient={item.recipient} /></div>}
    </header>
    <div className="agent-letter-body"><MarkdownContent markdown={content.payload} resourceContext={resourceContext} /></div>
    {dateTime || content.header ? <div className="agent-letter-footer">
      <details className="agent-letter-details">
        <summary>Details</summary>
        <div className="agent-letter-metadata">
          {dateTime ? <time dateTime={dateTime}>{time ? `${time.date} ${time.time}` : dateTime}</time> : null}
          {content.header ? <pre>{content.header}</pre> : null}
        </div>
      </details>
    </div> : null}
  </>;
}
