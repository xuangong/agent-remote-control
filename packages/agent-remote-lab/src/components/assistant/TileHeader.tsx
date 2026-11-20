import { useId, type ReactNode } from 'react';
import type { AssistantStatus } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionHeading } from '../SessionHeading.js';
import { IconButton } from '../../ui/IconButton.js';

/**
 * A Window tile's header (I3 plan, B4): the assistant's avatar, its name, the session's title when it differs from the
 * name (renamed and dragged as before), one sentence of what it is doing, its details, and the tile's own controls (fold or
 * close, star, ⋯). The title area keeps the drag handle the dock gives it.
 */
export function TileHeader({ name, avatar, title, titleText, status, detailsOpen, detailsId, onToggleDetails, trailing }: {
  name: string; avatar?: ReactNode; title?: ReactNode; titleText?: string; status?: Pick<AssistantStatus, 'state' | 'sentence'>;
  detailsOpen: boolean; detailsId: string; onToggleDetails(): void; trailing?: ReactNode;
}) {
  const t = useTranslate();
  const sentenceId = useId();
  // A bot is called by its session's title: the title is its name, renamed in place.
  const titleIsName = !!title && titleText === name;
  return <SessionHeading leading={avatar ? <span className="lab-tile-avatar">{avatar}</span> : undefined}
    trailing={<>{trailing}<IconButton icon="person" className="lab-tile-details-toggle" label={t('details.open', { name })} aria-expanded={detailsOpen} aria-controls={detailsId}
      aria-describedby={status?.sentence ? sentenceId : undefined} onClick={onToggleDetails} /></>}>
    <span className="lab-tile-identity">
      {titleIsName ? title : <span className="lab-tile-name">{name}</span>}
      <span className="lab-tile-subtitle">
        {!titleIsName && title ? title : null}
        {status?.sentence ? <span id={sentenceId} className="lab-tile-sentence" data-state={status.state}>{status.sentence}</span> : null}
      </span>
    </span>
  </SessionHeading>;
}
