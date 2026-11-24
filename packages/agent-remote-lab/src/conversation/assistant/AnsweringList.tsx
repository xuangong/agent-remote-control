import { useContext } from 'react';
import { LocaleContext, useTranslate, type AnswerSession } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';

/** The sessions a bot has open to answer the person's mentions, one per conversation it was asked from; read only. */
export function AnsweringList({ sessions }: { sessions: readonly AnswerSession[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  return <div className="lab-assistant-sessions">
    <p className="lab-assistant-hint">{t('details.answeringHint')}</p>
    <ul className="lab-assistant-chain">{sessions.map(session => <li key={session.teamId} data-answering={session.teamId}>
      <span className="lab-assistant-session-title">{t('details.answeringRow', { conversation: session.conversation, count: session.count, time: replyTime(session.lastAt, undefined, dateLocale(locale), t) })}</span>
    </li>)}</ul>
  </div>;
}
