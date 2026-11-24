import { useState } from 'react';
import { useTranslate } from '../locale.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { useTaskDirectory, type SideCard } from '../TaskDirectory.js';

/**
 * What a `/side` bot answered: a card beside the conversation it was asked from, never an input of that conversation's bot. Open goes to
 * the side's own conversation; Bring back sends the answer into this conversation as the person's words.
 */
export function SideCards({ cards, agentId }: { readonly cards: readonly SideCard[]; readonly agentId?: string }) {
  const t = useTranslate();
  const directory = useTaskDirectory();
  const [brought, setBrought] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<string>();
  if (!cards.length) return null;
  const bringBack = async (card: SideCard) => {
    if (!directory?.bringBack || !agentId || pending) return;
    setPending(card.taskId);
    try { await directory.bringBack(card, agentId); setBrought(current => new Set(current).add(card.taskId)); }
    finally { setPending(undefined); }
  };
  return <div className="agent-timeline-item agent-task-inputs" data-side-cards="">
    {cards.map(card => <article key={card.taskId} className="agent-task-input" data-side-card={card.taskId} data-status={card.status}
      aria-label={t(card.status === 'done' ? 'timeline.side.answered' : 'timeline.side.failed', { title: card.title })}>
      <header className="agent-task-header">
        <span className="agent-task-kicker">{t(card.status === 'done' ? 'timeline.side.answered' : 'timeline.side.failed', { title: card.title })}</span>
        {directory?.canOpen(card.taskId) ? <button type="button" className="agent-task-open" onClick={() => directory.open(card.taskId)}>{t('timeline.side.open')}</button> : null}
        {directory?.bringBack && agentId ? <button type="button" className="agent-task-open" data-bring-back="" disabled={brought.has(card.taskId) || pending === card.taskId}
          onClick={() => void bringBack(card)}>{t(brought.has(card.taskId) ? 'timeline.side.broughtBack' : 'timeline.side.bringBack')}</button> : null}
      </header>
      <MarkdownContent markdown={card.summary} />
    </article>)}
  </div>;
}
