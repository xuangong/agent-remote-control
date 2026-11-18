import { useContext, useRef, useState } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { CommunicationNavigationContext } from './CommunicationNavigation.js';
import { CommunicationContent, CommunicationTitle } from './CommunicationContent.js';
import type { MarkdownResourceContext } from './markdown-resources.js';

export function CommunicationLetter({ entry, resourceContext }: { entry: ProjectedTimelineEntry; resourceContext?: MarkdownResourceContext }) {
  const navigation = useContext(CommunicationNavigationContext);
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
    catch (error) { setFailure(error instanceof Error ? error.message : 'The linked session could not be opened.'); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="agent-letter-position"><article className="agent-communication-letter" aria-label="Agent communication" data-direction={direction} aria-busy={pending}
    onClick={event => {
      const selection = window.getSelection();
      if (!navigation || (event.target as HTMLElement).closest('button, a, details, input, textarea, select, [contenteditable]') || (selection && !selection.isCollapsed)) return;
      void open();
    }}>
    <CommunicationContent item={item} timestamp={entry.timestamp} resourceContext={resourceContext} heading={
      <button type="button" className="agent-letter-open" disabled={!navigation || pending} onClick={() => void open()}
        aria-label={`Open letter from ${item.sender} to ${item.recipient}`} title="Go to the linked session at this message">
        <CommunicationTitle sender={item.sender} recipient={item.recipient} />
        {direction ? <span className="agent-letter-direction" aria-label={`Recipient on the ${direction}`}>{direction === 'left' ? '←' : '→'}</span> : null}
      </button>
    } />
    {pending ? <small role="status">Opening linked session…</small> : null}
    {failure ? <small role="alert">{failure}</small> : null}
  </article></div>;
}
