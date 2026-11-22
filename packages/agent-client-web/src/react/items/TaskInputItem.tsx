import type { TaskInput } from '@orchardworks/agent-remote-protocol';
import { Card } from '../../primitives/Card.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { useTranslate } from '../locale.js';
import type { MarkdownResourceContext } from '../markdown-resources.js';

/**
 * A task's brief or result, which the Relay wrote into a session as input: a card in the conversation, never the person's bubble.
 * The main session reads the worker's result; a worker reads its brief.
 */
export function TaskInputItem({ input, resourceContext }: { readonly input: TaskInput; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  const kicker = input.kind === 'brief' ? t('timeline.task.brief', { from: input.from }) : t(input.kind === 'done' ? 'timeline.task.done' : 'timeline.task.failed');
  return <article className="agent-timeline-item agent-task-input" data-task-kind={input.kind} data-task-id={input.taskId} aria-label={t('timeline.task.label', { title: input.title })}>
    <Card tone="tint" className="agent-task-card">
      <header className="agent-task-header">
        <span className="agent-task-kicker">{kicker}</span>
        <span className="agent-task-title">{input.title}</span>
      </header>
      <MarkdownContent markdown={input.kind === 'brief' ? input.brief : input.summary} resourceContext={resourceContext} />
      {input.kind === 'brief' && input.doneWhen ? <p className="agent-task-done-when">{t('timeline.task.doneWhen', { text: input.doneWhen })}</p> : null}
    </Card>
  </article>;
}
