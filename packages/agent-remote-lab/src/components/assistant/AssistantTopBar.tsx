import { forwardRef, useId, type ReactNode } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import type { AssistantStatus } from '@orchardworks/agent-client';
import { BotPicture } from '../BotRoster.js';

/**
 * The top of an assistant's conversation: its avatar, name and one sentence of what it is doing, in a title pill that
 * opens its details. The heading is the assistant's name; the sentence describes it. `leading` holds the phone's way back
 * to the list, `trailing` the conversation's own actions.
 */
export const AssistantTopBar = forwardRef<HTMLButtonElement, {
  id: string; picture?: WindowBotDetails['picture']; name: string; status?: Pick<AssistantStatus, 'state' | 'sentence' | 'mood'>;
  /** Whether its details are open, and the panel or sheet they open in. */
  detailsOpen: boolean; detailsId?: string; onToggleDetails?(): void;
  leading?: ReactNode; trailing?: ReactNode;
}>(function AssistantTopBar({ id, picture, name, status, detailsOpen, detailsId, onToggleDetails, leading, trailing }, ref) {
  const sentenceId = useId();
  const content = <>
    <BotPicture id={id} picture={picture} size={28} mood={status?.mood ?? 'idle'} />
    <span className="lab-assistant-title-text">
      <span className="lab-assistant-name">{name}</span>
      {status?.sentence ? <span id={sentenceId} className="lab-assistant-sentence" data-state={status.state}>{status.sentence}</span> : null}
    </span>
  </>;
  return <header className="lab-assistant-top-bar">
    <div className="lab-assistant-top-bar-leading">{leading}</div>
    <h2 className="lab-assistant-heading">
      {onToggleDetails ? <button ref={ref} type="button" className="lab-assistant-title" aria-label={name} aria-describedby={status?.sentence ? sentenceId : undefined}
        aria-expanded={detailsOpen} aria-controls={detailsId} onClick={onToggleDetails}>{content}</button>
        : <span className="lab-assistant-title">{content}</span>}
    </h2>
    <div className="lab-assistant-top-bar-trailing">{trailing}</div>
  </header>;
});
