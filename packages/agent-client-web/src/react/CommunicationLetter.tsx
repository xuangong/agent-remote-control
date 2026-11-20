import { useContext, useRef, useState } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { CommunicationNavigationContext } from './CommunicationNavigation.js';
import { CommunicationContent, CommunicationTitle } from './CommunicationContent.js';
import type { MarkdownResourceContext } from './markdown-resources.js';
import { useTranslate } from './locale.js';

export function CommunicationLetter({ entry, resourceContext }: { entry: ProjectedTimelineEntry; resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
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
    catch (error) { setFailure(error instanceof Error ? error.message : t('timeline.letter.openFailed')); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="agent-letter-position"><article className="agent-communication-letter" aria-label={t('timeline.message.agent')} data-direction={direction} aria-busy={pending}
    onClick={event => {
      const selection = window.getSelection();
      if (!navigation || (event.target as HTMLElement).closest('button, a, details, input, textarea, select, [contenteditable]') || (selection && !selection.isCollapsed)) return;
      void open();
    }}>
    <CommunicationContent item={item} timestamp={entry.timestamp} resourceContext={resourceContext} heading={
      <button type="button" className="agent-letter-open" disabled={!navigation || pending} onClick={() => void open()}
        aria-label={t('timeline.letter.open', { sender: item.sender, recipient: item.recipient })} title={t('timeline.letter.goTo')}>
        <CommunicationTitle sender={item.sender} recipient={item.recipient} />
        {direction ? <span className="agent-letter-direction" aria-label={t(direction === 'left' ? 'timeline.letter.recipientLeft' : 'timeline.letter.recipientRight')}>{direction === 'left' ? '←' : '→'}</span> : null}
      </button>
    } />
    {pending ? <small role="status">{t('timeline.letter.opening')}</small> : null}
    {failure ? <small role="alert">{failure}</small> : null}
  </article></div>;
}
