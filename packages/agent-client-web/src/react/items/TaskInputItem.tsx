import { splitItemTag, type TaskInput } from '@orchardworks/agent-remote-protocol';
import { Card } from '../../primitives/Card.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { useTranslate } from '../locale.js';
import type { MarkdownResourceContext } from '../markdown-resources.js';
import { useTaskDirectory } from '../TaskDirectory.js';

/**
 * Sub-session work and results, which the Relay wrote into a session as input: cards in the conversation, never the person's bubble. A
 * sub-session reads its first work and more work; its bot reads results, what needs the person and what the person wrote to it. Several
 * updates that arrived together are one group of cards.
 */
export function TaskInputItem({ inputs, resourceContext }: { readonly inputs: readonly TaskInput[]; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  // Other assistants' messages fold into one line per sender; task updates are cards.
  const messages = new Map<string, AssistantInput[]>();
  for (const input of inputs) if (input.kind === 'assistant') messages.set(input.from, [...messages.get(input.from) ?? [], input]);
  const rooms = inputs.filter((input): input is RoomInput => input.kind === 'room');
  const standing = inputs.filter((input): input is StandingInput => input.kind === 'standing');
  const timers = inputs.filter((input): input is TimerInput => input.kind === 'timer');
  const wrote = inputs.filter((input): input is PersonWroteInput => input.kind === 'person_wrote');
  const logged = inputs.filter((input): input is WorkLogInput => input.kind === 'work_log');
  const asked = inputs.filter((input): input is AskInput => input.kind === 'ask');
  const changes = inputs.filter((input): input is ItemChangedInput | ChiefChangedInput => input.kind === 'item_changed' || input.kind === 'chief_changed');
  return <div className="agent-timeline-item agent-task-inputs">
    {standing.map((input, index) => <details key={`standing:${index}`} className="agent-assistant-messages" data-standing-version={input.version}>
      <summary>{t('timeline.standingInstructions')}</summary><MarkdownContent markdown={input.body} resourceContext={resourceContext} /></details>)}
    {inputs.map((input, index) => input.kind === 'assistant' || input.kind === 'room' || input.kind === 'standing' || input.kind === 'timer' || input.kind === 'person_wrote' || input.kind === 'ask' || input.kind === 'work_log' || input.kind === 'item_changed' || input.kind === 'chief_changed' ? null : <TaskInputCard key={`${input.taskId}:${index}`} input={input} resourceContext={resourceContext} />)}
    {[...messages].map(([from, items]) => <AssistantMessages key={from} from={from} items={items} resourceContext={resourceContext} />)}
    {rooms.map(room => <details key={room.roomId} className="agent-assistant-messages" data-room-id={room.roomId}>
      <summary>{t('timeline.roomTurn', { name: room.name, count: room.count })}</summary><MarkdownContent markdown={room.body} resourceContext={resourceContext} /></details>)}
    {wrote.map((input, index) => <details key={`wrote:${index}`} className="agent-assistant-messages" data-person-wrote={input.bot}>
      <summary>{t('timeline.personWrote', { bot: input.bot })}</summary><MarkdownContent markdown={input.body} resourceContext={resourceContext} /></details>)}
    {logged.map((input, index) => <details key={`log:${index}`} className="agent-assistant-messages" data-work-log-new={input.count}>
      <summary>{t('timeline.workLog', { count: input.count })}</summary><MarkdownContent markdown={input.body} resourceContext={resourceContext} /></details>)}
    {asked.map((input, index) => <details key={`ask:${index}`} className="agent-assistant-messages" data-asked-from={input.from}>
      <summary>{t('timeline.personAsks', { from: input.from })}</summary><MarkdownContent markdown={input.body} resourceContext={resourceContext} /></details>)}
    {changes.map((change, index) => <details key={`change:${index}`} className="agent-assistant-messages" data-item-change={change.kind}>
      <summary>{change.kind === 'item_changed' ? t('timeline.itemChanged', { title: change.title }) : t('timeline.chiefChanged')}</summary>
      <MarkdownContent markdown={change.kind === 'item_changed' ? change.what : change.body} resourceContext={resourceContext} /></details>)}
    {timers.map((timer, index) => <details key={`timer:${index}`} className="agent-assistant-messages" data-timer={timer.name}>
      <summary>{t('timeline.timerDue', { name: timer.name })}</summary>{timer.body ? <MarkdownContent markdown={timer.body} resourceContext={resourceContext} /> : null}</details>)}
  </div>;
}
type AssistantInput = Extract<TaskInput, { kind: 'assistant' }>;
type RoomInput = Extract<TaskInput, { kind: 'room' }>;
type StandingInput = Extract<TaskInput, { kind: 'standing' }>;
type TimerInput = Extract<TaskInput, { kind: 'timer' }>;
type PersonWroteInput = Extract<TaskInput, { kind: 'person_wrote' }>;
type AskInput = Extract<TaskInput, { kind: 'ask' }>;
type WorkLogInput = Extract<TaskInput, { kind: 'work_log' }>;
type ItemChangedInput = Extract<TaskInput, { kind: 'item_changed' }>;
type ChiefChangedInput = Extract<TaskInput, { kind: 'chief_changed' }>;

/** Messages from another assistant: one quiet line that opens to the messages. */
function AssistantMessages({ from, items, resourceContext }: { readonly from: string; readonly items: readonly AssistantInput[]; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  const keys = [...new Set(items.flatMap(item => splitItemTag(item.body).item?.key ?? []))];
  return <details className="agent-assistant-messages" data-message-ids={items.map(item => item.messageId).join(' ')}>
    <summary>{t('timeline.assistantMessages', { count: items.length, from })}{keys.length ? ` · ${keys.map(key => t('timeline.itemKey', { key })).join(', ')}` : ''}</summary>
    {items.map(item => <TaggedBody key={item.messageId} body={item.body} resourceContext={resourceContext} />)}
  </details>;
}

function TaskInputCard({ input, resourceContext }: { readonly input: Exclude<TaskInput, AssistantInput | RoomInput | StandingInput | TimerInput | PersonWroteInput | AskInput | WorkLogInput | ItemChangedInput | ChiefChangedInput>; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  const directory = useTaskDirectory();
  const kicker = input.kind === 'brief' ? t('timeline.sub.brief', { from: input.from }) : input.kind === 'message' ? t('timeline.sub.message', { from: input.from })
    : t(`timeline.sub.${input.kind === 'needs_you' ? 'needsYou' : input.kind}`);
  const title = input.kind === 'message' ? undefined : input.title;
  const { item, body } = splitItemTag(input.kind === 'brief' ? input.brief : input.body);
  return <article className="agent-task-input" data-task-kind={input.kind} data-task-id={input.taskId} aria-label={title ? t('timeline.sub.label', { title }) : kicker}>
    <Card tone="tint" className="agent-task-card">
      <header className="agent-task-header">
        <span className="agent-task-kicker">{kicker}</span>
        {title ? <span className="agent-task-title">{title}</span> : null}
        {item ? <span className="agent-task-item" data-item-key={item.key}>{t('timeline.itemTag', { key: item.key, title: item.title })}</span> : null}
        {toOwner(input.kind) && directory?.canOpen(input.taskId) ? <button type="button" className="agent-task-open" onClick={() => directory.open(input.taskId)}>{t('timeline.sub.open')}</button> : null}
      </header>
      <MarkdownContent markdown={body} resourceContext={resourceContext} />
    </Card>
  </article>;
}

/** Work reaches the sub-session, whose conversation is already on screen; the rest reaches its bot, whose card opens the sub-session. */
const toOwner = (kind: TaskInput['kind']) => kind !== 'brief' && kind !== 'message';

/** A message body whose first line may name the board item it serves: the line shows as a quiet note above the text, never as part of it. */
function TaggedBody({ body, resourceContext }: { readonly body: string; readonly resourceContext?: MarkdownResourceContext }) {
  const t = useTranslate();
  const { item, body: text } = splitItemTag(body);
  return <>{item ? <p className="agent-task-item" data-item-key={item.key}>{t('timeline.itemTag', { key: item.key, title: item.title })}</p> : null}<MarkdownContent markdown={text} resourceContext={resourceContext} /></>;
}
