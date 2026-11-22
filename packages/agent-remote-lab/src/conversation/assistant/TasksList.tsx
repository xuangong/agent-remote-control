import { useContext } from 'react';
import type { TaskView } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTaskDirectory, useTranslate } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { SessionRow, Copyable } from './SessionsList.js';

type Translate = ReturnType<typeof useTranslate>;
const FINISHED_SHOWN = 10;

/** The tasks a main session owns: those needing the person, those working, and the latest finished ones; a row opens its worker. */
export function TasksList({ tasks }: { tasks: readonly TaskView[] }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const directory = useTaskDirectory();
  const groups: Array<[string | undefined, TaskView[]]> = [
    [t('state.needsYou'), tasks.filter(task => task.state === 'needs_input')],
    [t('state.working'), tasks.filter(task => task.state === 'working' || task.state === 'queued')],
    [t('details.tasksDone'), tasks.filter(task => task.state === 'done' || task.state === 'failed' || task.state === 'cancelled').slice(0, FINISHED_SHOWN)],
  ];
  return <div className="lab-assistant-tasks">{groups.filter(([, items]) => items.length).map(([title, items]) => <section key={title} aria-label={title}>
    <h4>{title}</h4>
    <ul className="lab-assistant-chain">{items.map(task => <SessionRow key={task.taskId} title={task.title} moreLabel={t('details.taskMore', { title: task.title })}
      meta={[replyTime(task.updatedAt, undefined, dateLocale(locale), t), stateWords(task, t)]}
      heading={directory?.canOpen(task.taskId)
        ? <button type="button" className="lab-assistant-session-title" onClick={() => directory.open(task.taskId)}>{task.title}</button>
        : <span className="lab-assistant-session-title">{task.title}</span>}>
      {task.waiting ? <p>{task.waiting.text}</p> : null}
      {task.result ? <p>{task.result.summary}</p> : null}
      {task.worker.nativeSessionId ? <Copyable label={t('details.sessionId')} value={task.worker.nativeSessionId} /> : null}
    </SessionRow>)}</ul>
  </section>)}</div>;
}

function stateWords(task: TaskView, t: Translate): string | undefined {
  return task.state === 'failed' ? t('state.failed') : task.state === 'cancelled' ? t('state.ended') : undefined;
}
