import { useContext, useRef, useState } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { CommunicationNavigationContext } from './CommunicationNavigation.js';
import { TimelineTimeContext } from './TimelineTitle.js';
import { MarkdownContent } from './MarkdownContent.js';
import type { MarkdownResourceContext } from './markdown-resources.js';

export function CommunicationLetter({ entry, resourceContext }: { entry: ProjectedTimelineEntry; resourceContext?: MarkdownResourceContext }) {
  const navigation = useContext(CommunicationNavigationContext);
  const time = useContext(TimelineTimeContext);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const inFlight = useRef(false);
  const item = entry.item;
  if (item.type !== 'agent_communication') return null;
  const direction = navigation?.direction(entry);
  async function open() {
    if (!navigation || inFlight.current) return;
    inFlight.current = true; setPending(true); setFailure(undefined);
    try { await navigation.open(entry); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'The receiving session could not be opened.'); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="agent-letter-position"><article className="agent-communication-letter" aria-label="Agent communication" data-direction={direction} aria-busy={pending}
    onClick={event => {
      const selection = window.getSelection();
      if (!navigation || (event.target as HTMLElement).closest('button, a, summary, input, textarea, select, [contenteditable]') || (selection && !selection.isCollapsed)) return;
      void open();
    }}>
    <header className="agent-letter-heading">
      <button type="button" className="agent-letter-open" disabled={!navigation || pending} onClick={() => void open()}
        aria-label={`Open letter from ${item.sender} to ${item.recipient}`} title="Go to the receiving session at this message">
        <svg className="agent-letter-envelope" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>
        <span className="agent-letter-participants">{item.sender} → {item.recipient}</span>
        {direction ? <span className="agent-letter-direction" aria-label={`Recipient on the ${direction}`}>{direction === 'left' ? '←' : '→'}</span> : null}
      </button>
      <time dateTime={entry.timestamp} title={time ? `${time.date} ${time.time}` : entry.timestamp}>{time?.time ?? entry.timestamp}</time>
    </header>
    <div className="agent-letter-body"><MarkdownContent markdown={item.text} resourceContext={resourceContext} /></div>
    {pending ? <small role="status">Opening receiving session…</small> : null}
    {failure ? <small role="alert">{failure}</small> : null}
  </article></div>;
}
