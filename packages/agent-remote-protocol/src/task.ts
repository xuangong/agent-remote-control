import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * A task an assistant's main session handed to a worker session. It travels as a Team whose Leader is the worker and whose
 * requester is the main session: the brief reaches the worker and the result reaches the main session as Team messages.
 */
const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });

export const TASK_TITLE_LIMIT = 200;
export const TASK_BRIEF_LIMIT = 8000;
export const TASK_DONE_WHEN_LIMIT = 1000;
export const TASK_SUMMARY_LIMIT = 4000;
/** Tasks one main session may have running (queued or working) at once. */
export const TASK_RUNNING_LIMIT = 4;

/** working: the worker has the brief or is creating; done and failed: it reported; cancelled: stopped before it reported. */
export const TaskState = Type.Union([Type.Literal('working'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('cancelled')]);
export type TaskState = Static<typeof TaskState>;
export const TaskReportStatus = Type.Union([Type.Literal('done'), Type.Literal('failed')]);
export type TaskReportStatus = Static<typeof TaskReportStatus>;
export const TaskResult = Type.Object({ status: TaskReportStatus, summary: Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT }), reportedAt: Type.Number() }, object);
export type TaskResult = Static<typeof TaskResult>;
export const TaskTitle = Type.String({ minLength: 1, maxLength: TASK_TITLE_LIMIT, pattern: '\\S' });
export const TaskBrief = Type.String({ minLength: 1, maxLength: TASK_BRIEF_LIMIT, pattern: '\\S' });
export const TaskDoneWhen = Type.String({ minLength: 1, maxLength: TASK_DONE_WHEN_LIMIT, pattern: '\\S' });

/** The task a Team carries. */
export const TeamTask = Type.Object({ title: TaskTitle, brief: TaskBrief, doneWhen: Type.Optional(TaskDoneWhen), state: TaskState,
  result: Type.Optional(TaskResult), createdAt: Type.Number(), updatedAt: Type.Number() }, object);
export type TeamTask = Static<typeof TeamTask>;
export const isTeamTask = (value: unknown): value is TeamTask => Value.Check(TeamTask, value)
  && (value.state === 'done' || value.state === 'failed' ? value.result?.status === value.state : value.result === undefined);

/** The main session that owns a task, named by the session that calls on its Host. */
export const TaskOwner = Type.Object({ providerId: id, nativeSessionId: id, title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, object);
export type TaskOwner = Static<typeof TaskOwner>;

/**
 * What the main session and the website see of a task. queued: the worker session is not created yet; working, done, failed and
 * cancelled as in TaskState.
 */
export const TaskView = Type.Object({ taskId: id, title: TaskTitle, state: Type.Union([Type.Literal('queued'), TaskState]),
  doneWhen: Type.Optional(TaskDoneWhen), result: Type.Optional(TaskResult),
  worker: Type.Object({ hostId: id, providerId: id, nativeSessionId: Type.Optional(id), error: Type.Optional(Type.String({ maxLength: 2048 })) }, object),
  owner: Type.Object({ hostId: id, providerId: id, nativeSessionId: id }, object), createdAt: Type.Number(), updatedAt: Type.Number() }, object);
export type TaskView = Static<typeof TaskView>;
export const isTaskView = (value: unknown): value is TaskView => Value.Check(TaskView, value);

/** A payload line that would read as a frame is quoted, so only the Relay opens one. */
export const quoteFrames = (text: string) => text.replace(/^\[(?=(Task|Tasks|Team|Support|Message from|Room)\b)/gm, '(');
const heading = (text: string) => text.replace(/[\r\n\]]+/g, ' ').trim() || '…';
/**
 * How a brief names the session that started the task: the first line of its title, at most 80 characters. A CLI may title a
 * session after its latest input, which can be another frame; such a title, or none, names it the main session.
 */
export function taskSenderName(title: string | undefined): string {
  const line = title?.split('\n')[0]?.trim() ?? '';
  if (!line || /^[[(](Task|Tasks|Team|Support|Message from|Room)\b/.test(line)) return 'the main session';
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}
export const TASK_BRIEF_GUIDANCE = 'You work in the owner\'s working directory, which the owner may also change. Do the work with your own tools. '
  + 'Read the owner\'s conversation with read_source_session only when the brief is not enough. '
  + 'When you finish, call report_task once with status done or failed and a summary the owner can act on without reading your conversation.';
export const TASK_RESULT_GUIDANCE = 'This is the worker\'s report. Check what matters before relying on it, then tell the person what it means for their request.';

/** The worker's first input: what to do, how to tell it is done, and how to report. */
export function taskBriefText(input: { taskId: string; from: string; title: string; brief: string; doneWhen?: string }): string {
  // A brief line that would read as the done-when line is reworded, so the done-when line is only ever the task's own.
  const lines = [`[Task ${input.taskId} · brief · from ${heading(input.from)}]`, `Task: ${heading(input.title)}`, quoteFrames(input.brief).replace(/^Done when: /gm, 'Done when — ')];
  if (input.doneWhen) lines.push(`Done when: ${heading(input.doneWhen)}`);
  lines.push(TASK_BRIEF_GUIDANCE);
  return lines.join('\n');
}
/** The owner's view of a report: the worker's summary, labelled with the task. */
export function taskResultText(input: { taskId: string; status: TaskReportStatus; title: string; summary: string }): string {
  return [`[Task ${input.taskId} · ${input.status} · ${heading(input.title)}]`, quoteFrames(input.summary), TASK_RESULT_GUIDANCE].join('\n');
}
export type TaskInput =
  | { kind: 'brief'; taskId: string; from: string; title: string; brief: string; doneWhen?: string }
  | { kind: TaskReportStatus; taskId: string; title: string; summary: string };
/** Reads a brief or a result the Relay framed; any other text, or a frame without its closing guidance, is not a task input. */
export function parseTaskInput(text: string): TaskInput | undefined {
  const lines = text.split('\n');
  const result = /^\[Task (\S+) · (done|failed) · (.+)\]$/.exec(lines[0] ?? '');
  if (result) {
    if (lines.length < 3 || lines.at(-1) !== TASK_RESULT_GUIDANCE) return undefined;
    return { kind: result[2] as TaskReportStatus, taskId: result[1]!, title: result[3]!, summary: lines.slice(1, -1).join('\n') };
  }
  const brief = /^\[Task (\S+) · brief · from (.+)\]$/.exec(lines[0] ?? ''), title = /^Task: (.+)$/.exec(lines[1] ?? '');
  if (!brief || !title || lines.length < 4 || lines.at(-1) !== TASK_BRIEF_GUIDANCE) return undefined;
  const body = lines.slice(2, -1), done = /^Done when: (.+)$/.exec(body.at(-1) ?? '');
  return { kind: 'brief', taskId: brief[1]!, from: brief[2]!, title: title[1]!, brief: (done ? body.slice(0, -1) : body).join('\n'), ...(done ? { doneWhen: done[1]! } : {}) };
}
