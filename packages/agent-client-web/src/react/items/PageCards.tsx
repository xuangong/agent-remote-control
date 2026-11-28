import { useContext, useState } from 'react';
import { LocaleContext, useTranslate } from '../locale.js';
import { MarkdownContent } from '../MarkdownContent.js';
import type { PageView } from '../TaskDirectory.js';

/** When a page was written, as a person reads it: the time today, the date and time otherwise. */
export function pageTime(updatedAt: number, locale: string, now = Date.now()): string {
  const at = new Date(updatedAt), today = new Date(now), language = locale === 'zh' ? 'zh-CN' : 'en';
  const time = at.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === today.toDateString() ? time : `${at.toLocaleDateString(language, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * The team page of a bot as one card in its conversation and its chief's, read from the bot's record, so a rewrite changes the card
 * where it stands and adds no entry. It is closed to its title and who wrote it when; the person opens it to read the table.
 */
export function PageCards({ pages }: { readonly pages: readonly PageView[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!pages.length) return null;
  const toggle = (key: string) => setOpen(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  return <div className="agent-page-cards" data-page-cards="">
    {pages.map(page => {
      const key = `${page.botId}/${page.pageId}`, shown = open.has(key);
      return <article key={key} className="agent-page-card" data-page-card={page.pageId} data-open={shown || undefined} aria-label={t('timeline.page.label', { title: page.title })}>
        <header className="agent-page-card-header">
          <strong className="agent-page-card-title">{page.title}</strong>
          <span className="agent-page-card-updated">{t('timeline.page.updated', { name: page.bot, time: pageTime(page.updatedAt, locale) })}</span>
          <button type="button" className="agent-task-open" aria-expanded={shown} onClick={() => toggle(key)}>{t(shown ? 'timeline.page.close' : 'timeline.page.open')}</button>
        </header>
        {shown ? <div className="agent-page-card-body"><MarkdownContent markdown={page.contents} /></div> : null}
      </article>;
    })}
  </div>;
}
