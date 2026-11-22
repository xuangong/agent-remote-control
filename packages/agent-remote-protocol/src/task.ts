import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Team } from './team.js';

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

/**
 * working: the worker has the brief or is being created; needs_input: it waits on its owner or the person (see TaskWaiting);
 * done and failed: it reported, or the owner or the person marked it; cancelled: stopped before it reported.
 */
export const TaskState = Type.Union([Type.Literal('working'), Type.Literal('needs_input'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('cancelled')]);
export type TaskState = Static<typeof TaskState>;
export const TaskReportStatus = Type.Union([Type.Literal('done'), Type.Literal('failed')]);
export type TaskReportStatus = Static<typeof TaskReportStatus>;
export const TaskResult = Type.Object({ status: TaskReportStatus, summary: Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT }), reportedAt: Type.Number() }, object);
export type TaskResult = Static<typeof TaskResult>;
export const TaskTitle = Type.String({ minLength: 1, maxLength: TASK_TITLE_LIMIT, pattern: '\\S' });
export const TaskBrief = Type.String({ minLength: 1, maxLength: TASK_BRIEF_LIMIT, pattern: '\\S' });
export const TaskDoneWhen = Type.String({ minLength: 1, maxLength: TASK_DONE_WHEN_LIMIT, pattern: '\\S' });

export const TASK_QUESTION_LIMIT = 2000;
/** What the owner reads of the person's words to a worker, and of a pending interaction. */
export const TASK_TOLD_LIMIT = 280;
/**
 * Why a task needs input. question: the worker asked its owner (ask_owner); interaction: the worker waits on an approval or a
 * question only the person can answer; no_report: the worker stopped twice without reporting; brief_unknown: whether the worker was
 * created, or received its brief, is unknown.
 */
export const TaskWaiting = Type.Object({ reason: Type.Union([Type.Literal('question'), Type.Literal('interaction'), Type.Literal('no_report'), Type.Literal('brief_unknown')]),
  text: Type.String({ minLength: 1, maxLength: TASK_QUESTION_LIMIT }), since: Type.Number() }, object);
export type TaskWaiting = Static<typeof TaskWaiting>;
/** Where a task's worker works: the owner's directory, the same read-only, or its own worktree at a commit of the owner's repository. */
export const TaskWorkspace = Type.Union([Type.Literal('same'), Type.Literal('read_only'), Type.Literal('worktree')]);
export type TaskWorkspace = Static<typeof TaskWorkspace>;
/** The task a Team carries. reminded: when the worker was last reminded to report. */
export const TeamTask = Type.Object({ title: TaskTitle, brief: TaskBrief, doneWhen: Type.Optional(TaskDoneWhen), state: TaskState,
  waiting: Type.Optional(TaskWaiting), workspace: Type.Optional(TaskWorkspace), reminded: Type.Optional(Type.Number()),
  result: Type.Optional(TaskResult), createdAt: Type.Number(), updatedAt: Type.Number() }, object);
export type TeamTask = Static<typeof TeamTask>;
export const isTeamTask = (value: unknown): value is TeamTask => Value.Check(TeamTask, value)
  && (value.state === 'done' || value.state === 'failed' ? value.result?.status === value.state : value.result === undefined)
  && (value.state === 'needs_input') === (value.waiting !== undefined);

/** The main session that owns a task, named by the session that calls on its Host. */
export const TaskOwner = Type.Object({ providerId: id, nativeSessionId: id, title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, object);
export type TaskOwner = Static<typeof TaskOwner>;

/**
 * What the main session and the website see of a task. queued: the worker session is not created yet; working, done, failed and
 * cancelled as in TaskState.
 */
export const TaskView = Type.Object({ taskId: id, title: TaskTitle, state: Type.Union([Type.Literal('queued'), TaskState]),
  doneWhen: Type.Optional(TaskDoneWhen), result: Type.Optional(TaskResult), waiting: Type.Optional(TaskWaiting), workspace: Type.Optional(TaskWorkspace),
  worker: Type.Object({ hostId: id, providerId: id, nativeSessionId: Type.Optional(id), error: Type.Optional(Type.String({ maxLength: 2048 })) }, object),
  owner: Type.Object({ hostId: id, providerId: id, nativeSessionId: id }, object), createdAt: Type.Number(), updatedAt: Type.Number() }, object);
export type TaskView = Static<typeof TaskView>;
export const isTaskView = (value: unknown): value is TaskView => Value.Check(TaskView, value);
/** A task Team as the owner and the website see it; a working task whose worker session is not created yet is queued. */
export function taskView(team: Team): TaskView {
  const item = team.task!, worker = team.members[0]!, main = team.members[1]!;
  const state = item.state === 'working' && worker.creation !== 'ready' ? 'queued' : item.state;
  return { taskId: team.id, title: item.title, state, ...(item.doneWhen ? { doneWhen: item.doneWhen } : {}), ...(item.result ? { result: structuredClone(item.result) } : {}),
    ...(item.waiting ? { waiting: { ...item.waiting } } : {}), ...(item.workspace ? { workspace: item.workspace } : {}),
    worker: { hostId: worker.hostId, providerId: worker.providerId, ...(worker.nativeSessionId ? { nativeSessionId: worker.nativeSessionId } : {}), ...(worker.error ? { error: worker.error } : {}) },
    owner: { hostId: main.hostId, providerId: main.providerId, nativeSessionId: main.nativeSessionId ?? team.source.nativeSessionId }, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

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

/**
 * What a task's frame says. To the worker: brief, message (from its owner or the person), reminder. To the owner: done, failed,
 * question (the worker asks), needs_you (the worker waits on the person, or stopped without reporting), told (the person wrote to
 * the worker).
 */
export type TaskInputKind = 'brief' | 'message' | 'reminder' | 'done' | 'failed' | 'cancelled' | 'question' | 'needs_you' | 'told';
const kindWords: Record<TaskInputKind, string> = { brief: 'brief', message: 'message', reminder: 'report', done: 'done', failed: 'failed', cancelled: 'stopped', question: 'question',
  needs_you: 'needs the person', told: 'the person wrote' };
export const TASK_GUIDANCE: Record<TaskInputKind, string> = {
  brief: 'Do the work with your own tools, where your instructions say. '
    + 'Read the owner\'s conversation with read_source_session only when the brief is not enough. '
    + 'When you finish, call report_task once with status done or failed and a summary the owner can act on without reading your conversation.',
  message: 'This is input about your task. Continue it; when you finish, call report_task once.',
  reminder: 'Your last turn ended without a report. If the task is done or cannot be done, call report_task now; if you need something, ask with ask_owner.',
  done: 'This is the worker\'s report. Check what matters before relying on it, then tell the person what it means for their request.',
  failed: 'This is the worker\'s report. Check what matters before relying on it, then tell the person what it means for their request.',
  cancelled: 'The person stopped this task; its worker does no more. Take it into account for their request.',
  question: 'The worker waits for your answer. Answer with message_task, or ask the person first if only they can decide.',
  needs_you: 'The worker waits on the person, who sees the request in the task. Tell the person if they may not have noticed; do not answer it yourself.',
  told: 'The person wrote this to the worker directly. Take it into account; the worker already has it.',
};
/** Kept for the brief and result callers. */
export const TASK_BRIEF_GUIDANCE = TASK_GUIDANCE.brief;
export const TASK_RESULT_GUIDANCE = TASK_GUIDANCE.done;

/** The worker's first input: what to do, how to tell it is done, and how to report. */
export function taskBriefText(input: { taskId: string; from: string; title: string; brief: string; doneWhen?: string }): string {
  // A brief line that would read as the done-when line is reworded, so the done-when line is only ever the task's own.
  const lines = [`[Task ${input.taskId} · brief · from ${heading(input.from)}]`, `Task: ${heading(input.title)}`, quoteFrames(input.brief).replace(/^Done when: /gm, 'Done when — ')];
  if (input.doneWhen) lines.push(`Done when: ${heading(input.doneWhen)}`);
  lines.push(TASK_GUIDANCE.brief);
  return lines.join('\n');
}
/** The owner's view of a report: the worker's summary, labelled with the task. */
export function taskResultText(input: { taskId: string; status: TaskReportStatus; title: string; summary: string }): string {
  return taskUpdateText({ taskId: input.taskId, kind: input.status, label: input.title, body: input.summary });
}
/** Any other task input. label: the task's title, or for a message, who sends it. */
export function taskUpdateText(input: { taskId: string; kind: Exclude<TaskInputKind, 'brief'>; label: string; body: string }): string {
  return [`[Task ${input.taskId} · ${kindWords[input.kind]} · ${input.kind === 'message' ? `from ${heading(input.label)}` : heading(input.label)}]`, quoteFrames(input.body), TASK_GUIDANCE[input.kind]].join('\n');
}
export type TaskInput =
  | { kind: 'brief'; taskId: string; from: string; title: string; brief: string; doneWhen?: string }
  | { kind: 'message'; taskId: string; from: string; body: string }
  | { kind: Exclude<TaskInputKind, 'brief' | 'message'>; taskId: string; title: string; body: string };
const wordKinds = new Map(Object.entries(kindWords).map(([kind, word]) => [word, kind as TaskInputKind]));
const framePattern = new RegExp(`^\\[Task (\\S+) · (${Object.values(kindWords).join('|')}) · (.+)\\]$`);
/** Reads one brief or update the Relay framed; any other text, or a frame without its closing guidance, is not a task input. */
function parseOne(lines: string[]): TaskInput | undefined {
  const frame = framePattern.exec(lines[0] ?? '');
  const kind = frame && wordKinds.get(frame[2]!);
  if (!frame || !kind || lines.length < 3 || lines.at(-1) !== TASK_GUIDANCE[kind]) return undefined;
  const taskId = frame[1]!, label = frame[3]!;
  if (kind === 'brief') {
    const from = /^from (.+)$/.exec(label), title = /^Task: (.+)$/.exec(lines[1] ?? '');
    if (!from || !title || lines.length < 4) return undefined;
    const body = lines.slice(2, -1), done = /^Done when: (.+)$/.exec(body.at(-1) ?? '');
    return { kind, taskId, from: from[1]!, title: title[1]!, brief: (done ? body.slice(0, -1) : body).join('\n'), ...(done ? { doneWhen: done[1]! } : {}) };
  }
  const body = lines.slice(1, -1).join('\n');
  if (kind === 'message') { const from = /^from (.+)$/.exec(label); return from ? { kind, taskId, from: from[1]!, body } : undefined; }
  return { kind, taskId, title: label, body };
}
/** Several task inputs delivered as one: each keeps its own frame and guidance. */
export const joinTaskInputs = (texts: readonly string[]): string => texts.join('\n\n');
/** Reads one or several task inputs the Relay framed and the Controller joined; anything else is not task input. */
export function parseTaskInputs(text: string): TaskInput[] | undefined {
  const lines = text.split('\n'), starts = lines.flatMap((line, index) => framePattern.test(line) && (index === 0 || lines[index - 1] === '') ? [index] : []);
  if (starts[0] !== 0) return undefined;
  const inputs: TaskInput[] = [];
  for (const [position, start] of starts.entries()) {
    const end = position + 1 < starts.length ? starts[position + 1]! - 1 : lines.length;
    const input = parseOne(lines.slice(start, end));
    if (!input) return undefined;
    inputs.push(input);
  }
  return inputs;
}
/** Reads exactly one task input. */
export function parseTaskInput(text: string): TaskInput | undefined {
  const inputs = parseTaskInputs(text);
  return inputs?.length === 1 ? inputs[0] : undefined;
}
