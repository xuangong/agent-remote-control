import { useContext, useState } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import type { TaskView } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTaskDirectory, useTranslate } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow, Copyable } from './SessionsList.js';

type Translate = ReturnType<typeof useTranslate>;
const ENDED_SHOWN = 10;

/**
 * The sub-sessions a bot started: those needing the person, those working, those idle (still holding their context) and the latest
 * ended ones. A row opens its session; Stop ends it. There is no Keep: a sub-session is never a bot.
 */
export function SubSessionsList({ subSessions }: { subSessions: readonly TaskView[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const directory = useTaskDirectory();
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  async function stop(taskId: string) {
    if (!directory || pending) return;
    setPending(true); setError(undefined);
    try { await directory.act(taskId, 'stop_sub_session'); } catch (reason) { setError(errorWords(reason, t, 'details.subSessionActionFailed')); } finally { setPending(false); }
  }
  const groups: Array<[string, TaskView[]]> = [
    [t('state.needsYou'), subSessions.filter(item => item.state === 'needs_input')],
    [t('state.working'), subSessions.filter(item => item.state === 'working' || item.state === 'queued')],
    [t('details.subSessionsIdle'), subSessions.filter(item => item.state === 'idle')],
    [t('details.subSessionsEnded'), subSessions.filter(item => item.state === 'ended').slice(0, ENDED_SHOWN)],
  ];
  return <div className="lab-assistant-sessions lab-assistant-tasks">{groups.filter(([, items]) => items.length).map(([title, items]) => <section key={title} aria-label={title}>
    <h4>{title}</h4>
    <ul className="lab-assistant-chain">{items.map(item => <SessionRow key={item.taskId} title={item.title} moreLabel={t('details.subSessionMore', { title: item.title })}
      meta={[replyTime(item.updatedAt, undefined, dateLocale(locale), t), stateWords(item, t)]}
      heading={directory?.canOpen(item.taskId)
        ? <button type="button" className="lab-assistant-session-title" onClick={() => directory.open(item.taskId)}>{item.title}</button>
        : <span className="lab-assistant-session-title">{item.title}</span>}>
      {item.waiting ? <p>{item.waiting.text}</p> : null}
      {item.currentStep ? <p data-current-step="">{t('details.subSessionStep', { text: item.currentStep })}</p> : null}
      {!item.currentStep && item.lastWork ? <p data-last-work="">{t('details.subSessionLastWork', { text: item.lastWork.title })}</p> : null}
      {item.result ? <p>{item.result.text}</p> : null}
      {directory && item.state !== 'ended' ? <div className="lab-assistant-task-actions">
        <button type="button" className="lab-assistant-action" disabled={pending} onClick={() => void stop(item.taskId)}>{t('details.subSessionStop')}</button></div> : null}
      {item.worker.nativeSessionId ? <Copyable label={t('details.sessionId')} value={item.worker.nativeSessionId} /> : null}
    </SessionRow>)}</ul>
  </section>)}{error ? <p role="alert">{error}</p> : null}</div>;
}

function stateWords(item: TaskView, t: Translate): string | undefined {
  if (item.state === 'idle') return t('details.subSessionIdle', { time: idleFor(Date.now() - item.updatedAt) });
  return item.result?.outcome === 'failed' ? t('state.failed') : item.result?.outcome === 'interrupted' ? t('details.subSessionInterrupted') : undefined;
}
/** How long a sub-session has been idle, in the unit that reads best. */
function idleFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / (24 * 60))} d`;
}
