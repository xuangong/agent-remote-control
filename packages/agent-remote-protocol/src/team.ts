import { Type, type Static } from '@sinclair/typebox';
import { NativeSessionRef } from './session-succession.js';
import { Value } from '@sinclair/typebox/value';
import { BotId, BotMission, BotName, BotTimer, WorkItem, WORK_ITEM_LIMIT } from './bots.js';
import { ChainId, TurnCause } from './chains.js';
import { TaskBrief, TaskDoneWhen, TaskOwner, TaskWorkspace, AssistantMessageId, ASSISTANT_MESSAGE_LIMIT, ROOM_MINUTES_LIMIT, ROOM_TRANSCRIPT_LIMIT, ROOM_TURN_LIMIT, TaskReportStatus, TaskTitle, TeamTask, TASK_BRIEF_LIMIT, TASK_QUESTION_LIMIT, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, isTeamTask } from './task.js';
const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const short = Type.String({ maxLength: 2048 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const gitObject = Type.String({ pattern: '^[0-9a-f]{7,64}$' });
export const TeamSource = Type.Object({ hostId: id, providerId: id, nativeSessionId: id, title: Type.String({ minLength: 1, maxLength: 256 }) }, object);
export type TeamSource = Static<typeof TeamSource>;
/** Where a temporary bot works beside its chief: the same directory, its own worktree at a commit, or another machine's clone. */
export const TeamMemberWorkspace = Type.Union([
  Type.Object({ kind: Type.Literal('shared') }, object),
  Type.Object({ kind: Type.Literal('worktree'), commit: gitObject }, object),
  Type.Object({ kind: Type.Literal('remote'), commit: gitObject, repository: Type.String({ minLength: 1, maxLength: 2048 }),
    /** The bundle of the commit the worker's Host uploaded, granted to this member. */
    bundle: Type.Optional(id) }, object),
]);
export type TeamMemberWorkspace = Static<typeof TeamMemberWorkspace>;
export const TeamMember = Type.Object({
  /** requester: an existing main session, bound where it is (a task's owner, a link's or room's assistant, a bot's inbox). */
  id, hostId: id, providerId: id, role: enumOf('leader', 'member', 'requester'), name: Type.String({ minLength: 1, maxLength: 256 }),
  responsibility: short, cwd: Type.Optional(short), nativeSessionId: Type.Optional(NativeSessionRef.properties.nativeSessionId),
  creation: enumOf('reserved', 'ready', 'unknown', 'abandoned'), activity: enumOf('unknown', 'idle', 'busy'),
  summary: short, updatedAt: Type.Number(), error: Type.Optional(short),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), reasoningEffort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  /** The session must not write its working directory. */
  access: Type.Optional(Type.Literal('read_only')), workspace: Type.Optional(TeamMemberWorkspace),
  /** The chain of the latest input the Relay delivered to this member's session, and when (bots design 7). */
  chain: Type.Optional(Type.Object({ id: ChainId, at: Type.Number() }, object)),
  /** The person stopped what this member's session runs: its Host stops a running turn once for each value. */
  interrupt: Type.Optional(Type.Number()),
}, object);
export type TeamMember = Static<typeof TeamMember>;
export const TeamMessage = Type.Object({ id, from: id, to: id, text,
  status: enumOf('queued', 'dispatching', 'accepted', 'rejected', 'unknown', 'canceled'),
  resolvedTarget: Type.Optional(NativeSessionRef), acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), createdAt: Type.Number(), error: Type.Optional(short),
  /** The chain this message belongs to (bots design 7). */
  chain: Type.Optional(ChainId),
}, object);
export type TeamMessage = Static<typeof TeamMessage>;
export const TEAM_DELIVERY_RECEIPT_LIMIT = 200;
/** Recoverable legacy delivery evidence whose original body has already been compacted. */
export const TeamUnresolvedReceipt = Type.Object({ ...Type.Omit(TeamMessage, ['text', 'status', 'acceptance']).properties, status: Type.Literal('accepted') }, object);
export type TeamUnresolvedReceipt = Static<typeof TeamUnresolvedReceipt>;
/**
 * Two assistants' link: their keys in member order, and the latest messages between them with their hop along a reply chain,
 * so a reply names a message it answers; the chain records the depth.
 */
export const TeamLink = Type.Object({ assistants: Type.Tuple([id, id]),
  recent: Type.Array(Type.Object({ id: AssistantMessageId, from: id, hop: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), operationId: id }, object), { maxItems: 64 }) }, object);
export type TeamLink = Static<typeof TeamLink>;
/**
 * One bot's inbox (bots design 3): its main session as the only seat, bound where it is. Whatever reaches the bot arrives here as a
 * message the Relay framed, delivered between turns. `instructions`: the hash of the standing instructions it was last sent.
 */
export const TeamInbox = Type.Object({ botId: BotId, instructions: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  /** The latest messages other bots sent here, with their hop along a reply chain, so a reply names a message it answers. */
  recent: Type.Optional(Type.Array(Type.Object({ id: AssistantMessageId, from: BotId, hop: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), operationId: id,
    /** The bot answered its sender during the turn this message started, so that turn's final text sends no reply. */
    answered: Type.Optional(Type.Literal(true)) }, object), { maxItems: 64 })),
  /** The person paused the bot: its messages wait until resumed (bots design 7). */
  paused: Type.Optional(Type.Literal(true)),
  /** The bot's work items and timers (bots design 6). */
  work: Type.Optional(Type.Array(WorkItem, { maxItems: WORK_ITEM_LIMIT })),
  timers: Type.Optional(Type.Array(BotTimer, { maxItems: 8 })),
  /** A standing bot another bot created: its seat creates its session, then the Relay places it in its chief's group (bots design 2.2). */
  pending: Type.Optional(Type.Object({ name: BotName, mission: BotMission, chief: BotId, groupId: id, message: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }, object)) }, object);
export type TeamInbox = Static<typeof TeamInbox>;
const roomText = Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT });
/**
 * A room: assistants' main sessions, bound where they are, and the people of the account, talking one member at a time. speaker: the
 * member asked to speak now; seen: how many transcript entries each member was given; passed: members that passed since the last
 * message. open until a member says it is done, the person ends it, or its turns or time run out (closed).
 */
export const TeamRoom = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), topic: roomText, state: Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('closed')]),
  deadline: Type.Number(), turns: Type.Integer({ minimum: 0, maximum: ROOM_TURN_LIMIT }), speaker: Type.Optional(id), askedAt: Type.Optional(Type.Number()),
  seen: Type.Record(id, Type.Integer({ minimum: 0 })), passed: Type.Array(id, { maxItems: 12 }),
  transcript: Type.Array(Type.Object({ id, from: id, name: Type.String({ minLength: 1, maxLength: 120 }), text: roomText, at: Type.Number() }, object), { maxItems: ROOM_TRANSCRIPT_LIMIT }),
  result: Type.Optional(Type.Object({ from: id, text: roomText }, object)) }, object);
export type TeamRoom = Static<typeof TeamRoom>;
export const Team = Type.Object({ id, operationId: id, revision: Type.Integer({ minimum: 1 }), source: TeamSource,
  title: Type.String({ minLength: 1, maxLength: 256 }), status: enumOf('active', 'archiving', 'archived'),
  members: Type.Array(TeamMember, { minItems: 1, maxItems: 12 }), messages: Type.Array(TeamMessage, { maxItems: 200 }),
  unresolvedReceipts: Type.Optional(Type.Array(TeamUnresolvedReceipt, { maxItems: TEAM_DELIVERY_RECEIPT_LIMIT })),
  createdAt: Type.Number(), updatedAt: Type.Number(),
  /** Set for a task: the Leader is the worker session and the requester is the main session that owns the task. */
  task: Type.Optional(TeamTask),
  /** Set for the link between two assistants: each member is one assistant's main session, bound where it is. */
  link: Type.Optional(TeamLink),
  inbox: Type.Optional(TeamInbox),
  /** Set for a room of assistants and people; every member is an assistant's main session. */
  room: Type.Optional(TeamRoom),
}, object);
export type Team = Static<typeof Team>;
/** The person starts a temporary bot whose chief is the source session (`/side`, bots design 9): its name and its mission. */
export const TeamCreate = Type.Object({ operationId: id, source: TeamSource, bot: Type.Object({ name: TaskTitle, mission: TaskBrief }, object) }, object);
export type TeamCreate = Static<typeof TeamCreate>;
export const TeamAction = Type.Union([
  // The person stops a task, or takes it as done.
  Type.Object({ teamId: id, action: Type.Literal('cancel_task') }, object),
  Type.Object({ teamId: id, action: Type.Literal('mark_task_done') }, object),
  // The person keeps a temporary bot as a standing bot of its chief's group (bots design 10).
  Type.Object({ teamId: id, action: Type.Literal('keep_task') }, object),
  // The person writes in a room, or ends it.
  Type.Object({ teamId: id, action: Type.Literal('room_post'), operationId: id, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }) }, object),
  Type.Object({ teamId: id, action: Type.Literal('close_room') }, object),
]);
export type TeamAction = Static<typeof TeamAction>;
/** A bot calling as its own main session. */
const BotCaller = Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object);
/** A message that crosses from one bot to another (bots design 3.4). */
export const BOT_MESSAGE_LIMIT = 300;
const BotText = Type.String({ minLength: 1, maxLength: BOT_MESSAGE_LIMIT });
export const TeamHostCall = Type.Union([
  Type.Object({ action: Type.Literal('poll') }, object),
  Type.Object({ action: Type.Literal('read'), teamId: id, memberId: id }, object),
  Type.Object({ action: Type.Literal('presence'), teamId: id, memberId: id, activity: enumOf('idle', 'busy', 'unknown'),
    // A task worker's pending native interaction, which only the person answers.
    interaction: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_TOLD_LIMIT })) }, object),
  Type.Object({ action: Type.Literal('claim'), teamId: id, memberId: id, messageId: id, expectedNativeSessionId: Type.Optional(NativeSessionRef.properties.nativeSessionId) }, object),
  Type.Object({ action: Type.Literal('settle'), teamId: id, memberId: id, messageId: id, resolvedTarget: Type.Optional(NativeSessionRef), outcome: enumOf('accepted', 'rejected', 'unknown'), acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), error: Type.Optional(short) }, object),
  // The calling Host's sessions that are bots, with their missions: they get the bots' tools and standing instructions.
  Type.Object({ action: Type.Literal('bot_enablement') }, object),
  // A main session's task tools, by the main session on the calling Host.
  // workspace: where the worker works (default same); worktree needs the commit it starts from. provider and model choose the worker's agent.
  Type.Object({ action: Type.Literal('create_task'), owner: TaskOwner, operationId: id, title: TaskTitle, brief: TaskBrief, doneWhen: Type.Optional(TaskDoneWhen),
    workspace: Type.Optional(TaskWorkspace), commit: Type.Optional(gitObject), provider: Type.Optional(id), model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, object),
  Type.Object({ action: Type.Literal('task_status'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), taskId: Type.Optional(id) }, object),
  Type.Object({ action: Type.Literal('message_task'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), taskId: id, operationId: id,
    text: Type.String({ minLength: 1, maxLength: TASK_BRIEF_LIMIT }) }, object),
  Type.Object({ action: Type.Literal('cancel_task'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), taskId: id }, object),
  Type.Object({ action: Type.Literal('mark_task_done'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), taskId: id,
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT })) }, object),
  // Every bot's own calls, made as its main session (bots design 5.1). A temporary bot is a task: its chief is the task's owner.
  Type.Object({ action: Type.Literal('create_bot'), owner: TaskOwner, operationId: id, name: TaskTitle, mission: TaskBrief, lifetime: Type.Union([Type.Literal('temporary'), Type.Literal('standing')]),
    message: Type.Optional(BotText), workspace: Type.Optional(TaskWorkspace), commit: Type.Optional(gitObject), provider: Type.Optional(id), model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    cause: Type.Optional(TurnCause) }, object),
  Type.Object({ action: Type.Literal('bot_message'), owner: BotCaller, operationId: id, to: Type.String({ minLength: 1, maxLength: 300 }), text: BotText, cause: Type.Optional(TurnCause),
    replyTo: Type.Optional(AssistantMessageId), status: Type.Optional(Type.Union([Type.Literal('progress'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('needs_input')])),
    /** In a room: pass this turn instead of speaking. */
    pass: Type.Optional(Type.Boolean()),
    /** A worktree bot's result: where its patch was saved on its Host, added to the report by the Relay. */
    patch: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, object),
  // A standing bot's turn ended: its final text answers the one message that started it (bots design 3.3). The Host sends it, never the model.
  Type.Object({ action: Type.Literal('bot_reply'), owner: BotCaller, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }),
    cause: Type.Object({ kind: Type.Literal('framed'), answers: AssistantMessageId }, object) }, object),
  Type.Object({ action: Type.Literal('list_bots'), owner: BotCaller }, object),
  // A bot's turn ended: its Host counts the turn and its usage in the turn's chain.
  Type.Object({ action: Type.Literal('chain_turn'), owner: BotCaller, cause: TurnCause, tokens: Type.Integer({ minimum: 0 }), costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object),
  Type.Object({ action: Type.Literal('update_mission'), owner: BotCaller, mission: BotMission }, object),
  Type.Object({ action: Type.Literal('update_work'), owner: BotCaller, work: Type.Optional(WorkItem.properties.id), title: Type.Optional(WorkItem.properties.title), phase: Type.Optional(WorkItem.properties.phase),
    summary: Type.Optional(WorkItem.properties.summary), next: Type.Optional(WorkItem.properties.summary), acceptance: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }, object),
  Type.Object({ action: Type.Literal('complete_work'), owner: BotCaller, work: WorkItem.properties.id, summary: WorkItem.properties.summary }, object),
  Type.Object({ action: Type.Literal('set_timer'), owner: BotCaller, name: BotTimer.properties.name, minutes: Type.Integer({ minimum: 0, maximum: 7 * 24 * 60 }) }, object),
  Type.Object({ action: Type.Literal('stop_bot'), owner: BotCaller, bot: Type.String({ minLength: 1, maxLength: 300 }) }, object),
  Type.Object({ action: Type.Literal('retire_bot'), owner: BotCaller, bot: Type.String({ minLength: 1, maxLength: 300 }) }, object),
  Type.Object({ action: Type.Literal('bot_session'), owner: BotCaller, bot: Type.String({ minLength: 1, maxLength: 300 }) }, object),
  // A task's worker reports its result once.
  Type.Object({ action: Type.Literal('report_task'), teamId: id, memberId: id, status: TaskReportStatus, summary: Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT }) }, object),
  // An assistant's main session lists the account's other assistants, and messages one.
  Type.Object({ action: Type.Literal('list_assistants'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object) }, object),
  Type.Object({ action: Type.Literal('message_assistant'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object),
    to: Type.String({ minLength: 1, maxLength: 300 }), operationId: id, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }), replyTo: Type.Optional(AssistantMessageId) }, object),
  // An assistant opens a room with others, and speaks or passes when the room asks it.
  Type.Object({ action: Type.Literal('open_room'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), operationId: id,
    name: Type.String({ minLength: 1, maxLength: 120 }), topic: roomText, members: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 7 }),
    minutes: Type.Integer({ minimum: 1, maximum: ROOM_MINUTES_LIMIT }), cause: Type.Optional(TurnCause) }, object),
  Type.Object({ action: Type.Literal('room_say'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), roomId: id, text: roomText,
    done: Type.Optional(Type.Boolean()) }, object),
  Type.Object({ action: Type.Literal('room_pass'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), roomId: id }, object),
  // A task's worker asks its owner, and the worker's Host says what the person wrote to the worker directly.
  Type.Object({ action: Type.Literal('ask_owner'), teamId: id, memberId: id, question: Type.String({ minLength: 1, maxLength: TASK_QUESTION_LIMIT }) }, object),
  Type.Object({ action: Type.Literal('tell_task'), teamId: id, memberId: id, operationId: id, text: Type.String({ minLength: 1, maxLength: TASK_TOLD_LIMIT }) }, object),
]);
export type TeamHostCall = Static<typeof TeamHostCall>;
export const TeamSeat = Type.Object({ teamId: id, source: TeamSource, member: TeamMember,
  /** The seat belongs to a task: its worker as Leader, or the main session that owns it as requester. */
  task: Type.Optional(Type.Object({ title: TaskTitle }, object)),
  /** The seat is one assistant's main session in a link: bound where it is, it only receives messages. */
  link: Type.Optional(Type.Object({ peer: Type.String({ minLength: 1, maxLength: 256 }) }, object)),
  /** The seat is one bot's main session, receiving its inbox; mission: a bot this seat creates, which starts with it. */
  inbox: Type.Optional(Type.Object({ botId: BotId, mission: Type.Optional(BotMission) }, object)),
  /** The seat is one assistant's main session in a room. */
  room: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, object)) }, object);
export type TeamSeat = Static<typeof TeamSeat>;
/** What a member of a temporary bot's Team may carry about how its session works; any other member carries none. */
const workerFields = ['model', 'reasoningEffort', 'access', 'workspace'] as const;
const plainMember = (member: TeamMember) => workerFields.every(field => member[field] === undefined);
/** A task has its worker and then its owner; an inbox, a link and a room bind main sessions. A Team is one of these four. */
const validShape = (value: Team) => {
  if (value.inbox) return !value.task && !value.link && !value.room && value.members.length === 1
    // Bound where the bot already is (requester), or created for a bot another bot made (leader).
    && (value.members[0]!.role === 'requester' || value.members[0]!.role === 'leader') && plainMember(value.members[0]!);
  if (value.room) return !value.task && !value.link && value.members.length >= 2 && value.members.every(member => member.role === 'requester' && plainMember(member));
  if (value.link) return !value.task && value.members.length === 2 && value.members.every(member => member.role === 'requester' && plainMember(member));
  if (value.task) return isTeamTask(value.task) && value.members.length === 2 && value.members[1]!.role === 'requester' && plainMember(value.members[1]!)
    && (value.members[0]!.workspace === undefined || value.members[0]!.workspace.kind === 'worktree');
  return false;
};
export const isTeam = (value: unknown): value is Team => Value.Check(Team, value)
  // A link binds two main sessions; every other Team starts with its Leader.
  && (value.link || value.room || value.inbox ? true : value.members[0]?.role === 'leader' && value.members.slice(1).every(member => member.role === 'member' || member.role === 'requester')) && validShape(value)
  && value.members[0]!.hostId === value.source.hostId
  && new Set(value.members.map(member => member.id)).size === value.members.length
  && new Set([...value.messages, ...(value.unresolvedReceipts ?? [])].map(message => message.id)).size === value.messages.length + (value.unresolvedReceipts?.length ?? 0)
  && (value.unresolvedReceipts ?? []).every(receipt => value.members.some(member => member.id === receipt.from) && value.members.some(member => member.id === receipt.to && (!receipt.resolvedTarget || member.providerId === receipt.resolvedTarget.providerId)))
  && value.messages.every(message => !message.resolvedTarget || value.members.some(member => member.id === message.to && member.providerId === message.resolvedTarget!.providerId))
  && value.messages.every(message => value.members.some(member => member.id === message.from) && value.members.some(member => member.id === message.to));
export const isTeamCreate = (value: unknown): value is TeamCreate => Value.Check(TeamCreate, value);
export const isTeamAction = (value: unknown): value is TeamAction => Value.Check(TeamAction, value);
export const isTeamHostCall = (value: unknown): value is TeamHostCall => Value.Check(TeamHostCall, value);
export const isTeamSeat = (value: unknown): value is TeamSeat => Value.Check(TeamSeat, value);

export const isTeamMember = (value: unknown): value is TeamMember => Value.Check(TeamMember, value);

