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
  // Other assistants' messages fold into one line per sender; task updates are cards.
  const messages = new Map<string, AssistantInput[]>();
  for (const input of inputs) if (input.kind === 'assistant') messages.set(input.from, [...messages.get(input.from) ?? [], input]);
  return <div className="agent-timeline-item agent-task-inputs">
    {inputs.map((input, index) => input.kind === 'assistant' ? null : <TaskInputCard key={`${input.taskId}:${index}`} input={input} resourceContext={resourceContext} />)}
    {[...messages].map(([from, items]) => <AssistantMessages key={from} from={from} items={items} resourceContext={resourceContext} />)}
  </div>;
}
type AssistantInput = Extract<TaskInput, { kind: 'assistant' }>;

/** Messages from another assistant: one quiet line that opens to the messages. */
function AssistantMessages({ from, items, resourceContext }: { readonly from: string; readonly items: readonly AssistantInput[]; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  return <details className="agent-assistant-messages" data-message-ids={items.map(item => item.messageId).join(' ')}>
    <summary>{t('timeline.assistantMessages', { count: items.length, from })}</summary>
    {items.map(item => <MarkdownContent key={item.messageId} markdown={item.body} resourceContext={resourceContext} />)}
  </details>;
}

function TaskInputCard({ input, resourceContext }: { readonly input: Exclude<TaskInput, AssistantInput>; readonly resourceContext?: MarkdownResourceContext }) {
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
        {toOwner(input.kind) && directory?.canOpen(input.taskId) ? <button type="button" className="agent-task-open" onClick={() => directory.open(input.taskId)}>{t('timeline.task.open')}</button> : null}
      </header>
      <MarkdownContent markdown={body} resourceContext={resourceContext} />
      {input.kind === 'brief' && input.doneWhen ? <p className="agent-task-done-when">{t('timeline.task.doneWhen', { text: input.doneWhen })}</p> : null}
    </Card>
  </article>;
}

/** Briefs and messages reach the worker, whose conversation is already on screen; the others reach the owner, whose card opens the worker. */
const toOwner = (kind: TaskInput['kind']) => kind !== 'brief' && kind !== 'message';
