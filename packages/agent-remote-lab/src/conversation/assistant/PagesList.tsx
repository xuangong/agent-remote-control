import { useContext } from 'react';
import { LocaleContext, MarkdownContent, useTranslate, type PageView } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow } from './SessionsList.js';

/** The pages a standing bot keeps, newest write first: a row shows its title and when it was written, and opens to the page. Read only: only the bot edits a page. */
export function PagesList({ pages }: { pages: readonly PageView[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  return <div className="lab-assistant-sessions">
    <p className="lab-assistant-hint">{t('details.pagesHint')}</p>
    <ul className="lab-assistant-chain" data-pages="">{pages.map(page => <SessionRow key={page.pageId} title={page.title} moreLabel={t('timeline.page.label', { title: page.title })}
      meta={[t('details.pageUpdated', { time: replyTime(page.updatedAt, undefined, dateLocale(locale), t) }), page.team ? t('details.pageTeam') : undefined]}
      heading={<span className="lab-assistant-session-title">{page.title}</span>}>
      <MarkdownContent markdown={page.contents} />
    </SessionRow>)}</ul>
  </div>;
}
