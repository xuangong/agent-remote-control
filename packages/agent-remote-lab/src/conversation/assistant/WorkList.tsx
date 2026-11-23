import { useContext } from 'react';
import type { WorkItem } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow } from './SessionsList.js';

const DONE_SHOWN = 5;

/** A standing bot's work items as it keeps them: the open ones with their phase and next step, then the latest done. */
export function WorkList({ work }: { work: readonly WorkItem[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const shown = [...work.filter(item => item.phase !== 'done'), ...work.filter(item => item.phase === 'done').slice(0, DONE_SHOWN)];
  return <div className="lab-assistant-sessions lab-assistant-work">
    <ul className="lab-assistant-chain">{shown.map(item => <SessionRow key={item.id} title={item.title} moreLabel={t('details.taskMore', { title: item.title })}
      meta={[replyTime(item.updatedAt, undefined, dateLocale(locale), t), t(`details.workPhase.${item.phase}`)]}
      heading={<span className="lab-assistant-session-title">{item.title}</span>}>
      <p>{item.summary}</p>
      {item.next ? <p>{t('details.workNext', { text: item.next })}</p> : null}
      {item.acceptance ? <p>{t('details.workAcceptance', { text: item.acceptance })}</p> : null}
    </SessionRow>)}</ul>
  </div>;
}
