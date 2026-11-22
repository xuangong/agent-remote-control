import { useId, type ReactNode } from 'react';
import { assistantStatus, type AssistantFacts } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionHeading } from '../SessionHeading.js';
import { useSharedFeed } from '../../kernel/shared-feeds.js';

/** A session as the shared feeds know it, for its latest reply. */
export interface TileSession { readonly hostId: string; readonly providerId: string; readonly nativeSessionId: string }

/**
 * A Window tile's header (I3 plan, B4; I3c): the assistant's avatar and name, which open its details as Bot mode's title
 * does, one line under them with the session's title (renamed and dragged as before) and what the assistant is doing, and
 * one ⋯ menu with the tile's controls. The sentence says the latest reply as Bot mode's row does; it follows the shared
 * feeds itself, so their frames render this header and not the conversation.
 */
export function TileHeader({ name, avatar, title, facts, session, detailsOpen, detailsId, onToggleDetails, menu }: {
  name: string; avatar?: ReactNode; title?: ReactNode; facts: Omit<AssistantFacts, 'replyPreview'>; session?: TileSession;
  detailsOpen: boolean; detailsId: string; onToggleDetails(): void; menu?: ReactNode;
}) {
  const t = useTranslate();
  const sentenceId = useId();
  const reply = useSharedFeed(snapshot => session ? snapshot.states?.reply(session)?.preview : undefined);
  const status = assistantStatus({ ...facts, ...(reply ? { replyPreview: reply } : {}) }, t);
  return <SessionHeading className="lab-tile-heading" trailing={menu}>
    <span className="lab-tile-identity">
      <button type="button" className="lab-tile-who" aria-label={t('details.open', { name })} aria-expanded={detailsOpen} aria-controls={detailsId}
        aria-describedby={status.sentence ? sentenceId : undefined} onClick={onToggleDetails}>
        {avatar ? <span className="lab-tile-avatar">{avatar}</span> : null}<span className="lab-tile-name">{name}</span>
      </button>
      <span className="lab-tile-subtitle">
        {title}
        {status.sentence ? <span id={sentenceId} className="lab-tile-sentence" data-state={status.state}>{status.sentence}</span> : null}
      </span>
    </span>
  </SessionHeading>;
}
