import { useContext } from 'react';
import { LocaleContext, useTranslate, type WorkLogLine } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';

/** A bot's work log as the person reads it: a dated list, newest first, each entry opening to the answer; read only. */
export function WorkLogList({ entries }: { entries: readonly WorkLogLine[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  return <div className="lab-assistant-sessions">
    <p className="lab-assistant-hint">{t('details.workLogHint')}</p>
    <ul className="lab-assistant-chain">{entries.map(entry => <li key={entry.seq} data-work-log={entry.seq}>
      <details><summary className="lab-assistant-session-title">{t('details.workLogRow', { where: entry.where, question: entry.question })} · {replyTime(entry.at, undefined, dateLocale(locale), t)}</summary>
        <p>{entry.answer}</p></details>
    </li>)}</ul>
  </div>;
}
