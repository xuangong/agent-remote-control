import { useContext } from 'react';
import { boardItemOpen, type BoardItem } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow } from './SessionsList.js';

const FINISHED_SHOWN = 5;

/** The items of a standing bot's board: the open ones with their status and latest report, then the latest finished. */
export function BoardList({ board }: { board: readonly BoardItem[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const shown = [...board.filter(item => boardItemOpen(item.status)), ...board.filter(item => !boardItemOpen(item.status)).slice(0, FINISHED_SHOWN)];
  return <div className="lab-assistant-sessions lab-assistant-work">
    <ul className="lab-assistant-chain">{shown.map(item => <SessionRow key={item.key} title={item.title} moreLabel={t('details.taskMore', { title: item.title })}
      meta={[replyTime(item.updatedAt, undefined, dateLocale(locale), t), t(`details.boardStatus.${item.status}`)]}
      heading={<span className="lab-assistant-session-title">{item.title}</span>}>
      {item.report ? <p>{item.report}</p> : null}
      {item.result ? <p>{t('details.boardResult', { text: item.result })}</p> : null}
    </SessionRow>)}</ul>
  </div>;
}
