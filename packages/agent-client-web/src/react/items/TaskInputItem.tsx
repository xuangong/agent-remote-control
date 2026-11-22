import type { TaskInput } from '@orchardworks/agent-remote-protocol';
import { Card } from '../../primitives/Card.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { useTranslate } from '../locale.js';
import type { MarkdownResourceContext } from '../markdown-resources.js';
import { useTaskDirectory } from '../TaskDirectory.js';

/**
 * Task briefs and updates, which the Relay wrote into a session as input: cards in the conversation, never the person's bubble. A
 * worker reads its brief and the messages about its task; the main session reads results, questions and notes. Several updates that
 * arrived together are one group of cards.
 */
export function TaskInputItem({ inputs, resourceContext }: { readonly inputs: readonly TaskInput[]; readonly resourceContext?: MarkdownResourceContext }) {
  return <div className="agent-timeline-item agent-task-inputs">{inputs.map((input, index) => <TaskInputCard key={`${input.taskId}:${index}`} input={input} resourceContext={resourceContext} />)}</div>;
}

function TaskInputCard({ input, resourceContext }: { readonly input: TaskInput; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  const directory = useTaskDirectory();
  const kicker = input.kind === 'brief' ? t('timeline.task.brief', { from: input.from }) : input.kind === 'message' ? t('timeline.task.message', { from: input.from })
    : t(`timeline.task.${input.kind === 'needs_you' ? 'needsYou' : input.kind}`);
  const title = input.kind === 'message' ? undefined : input.title;
  const body = input.kind === 'brief' ? input.brief : input.body;
  return <article className="agent-task-input" data-task-kind={input.kind} data-task-id={input.taskId} aria-label={title ? t('timeline.task.label', { title }) : kicker}>
    <Card tone="tint" className="agent-task-card">
      <header className="agent-task-header">
        <span className="agent-task-kicker">{kicker}</span>
        {title ? <span className="agent-task-title">{title}</span> : null}
        {directory?.canOpen(input.taskId) ? <button type="button" className="agent-task-open" onClick={() => directory.open(input.taskId)}>{t('timeline.task.open')}</button> : null}
      </header>
      <MarkdownContent markdown={body} resourceContext={resourceContext} />
      {input.kind === 'brief' && input.doneWhen ? <p className="agent-task-done-when">{t('timeline.task.doneWhen', { text: input.doneWhen })}</p> : null}
    </Card>
  </article>;
}
