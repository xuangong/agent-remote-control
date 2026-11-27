import { Type, type Static } from '@sinclair/typebox';
import { NativeSessionRef } from './session-succession.js';
import { Value } from '@sinclair/typebox/value';
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENTS_PER_MESSAGE, AttachmentId, BotAttachment, BotId, BotFact, BotMission, BotName, Board, BOARD_ITEM_LIMIT, BOARD_PLAN_LIMIT, BoardItem, BoardItemEdit, BoardPlanEdit, BotTimer } from './bots.js';
import { ChainId, StandingApproval, TurnCause } from './chains.js';
import { TaskBrief, ASK_LIMIT, TaskOwner, TaskWorkspace, AssistantMessageId, ASSISTANT_MESSAGE_LIMIT, ROOM_MINUTES_LIMIT, ROOM_TRANSCRIPT_LIMIT, ROOM_TURN_LIMIT, TaskOutcome, TaskTitle, TeamTask, TASK_BRIEF_LIMIT, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, SUB_SESSION_LINE_LIMIT, SUB_SESSION_NAME_LIMIT, isTeamTask } from './task.js';
const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const short = Type.String({ maxLength: 2048 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const gitObject = Type.String({ pattern: '^[0-9a-f]{7,64}$' });
export const TeamSource = Type.Object({ hostId: id, providerId: id, nativeSessionId: id, title: Type.String({ minLength: 1, maxLength: 256 }) }, object);
export type TeamSource = Static<typeof TeamSource>;
/** Where a sub-session works beside its bot: the same directory, its own worktree at a commit, or another machine's clone. */
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
  /** A bot's acknowledgement (message status `ack`): the Host is not given it until another input is queued for the same seat, and then it arrives with that input. */
  ack: Type.Optional(Type.Literal(true)),
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
  /** The bot's board and timers (bots design 6). */
  board: Type.Optional(Board),
  timers: Type.Optional(Type.Array(BotTimer, { maxItems: 8 })),
  /** A standing bot another bot created: its seat creates its session, then the Relay places it in its chief's group (bots design 2.2). */
  pending: Type.Optional(Type.Object({ name: BotName, mission: BotMission, chief: BotId, groupId: id, message: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }, object)) }, object);
export type TeamInbox = Static<typeof TeamInbox>;
/** An answer session stays this long without a follow-up from the conversation it answers; then it is retired. */
export const ASK_IDLE_MS = 60 * 60_000;
/** Asks and answers one answer session keeps for the page. */
export const ASK_ENTRY_LIMIT = 20;
/**
 * A bot's answer session for one conversation of the person (bots plan 8b): the Team's only seat is a session of the bot's provider,
 * created for the mention. from: the conversation the person asks from, where the page shows the entries. Each entry is one ask and
 * the answer the session's final text gave, cut at 300 characters.
 */
export const TeamAsk = Type.Object({ botId: BotId,
  from: Type.Object({ hostId: id, providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId, name: Type.String({ minLength: 1, maxLength: 256 }) }, object),
  /** The latest ask: the session is retired an hour after it. */
  lastAt: Type.Number(),
  entries: Type.Array(Type.Object({ id, text: Type.String({ minLength: 1, maxLength: ASK_LIMIT }), at: Type.Number(),
    answer: Type.Optional(Type.Object({ text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }), at: Type.Number() }, object)) }, object), { maxItems: ASK_ENTRY_LIMIT }) }, object);
export type TeamAsk = Static<typeof TeamAsk>;
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
  /** Set for a bot's answer session for one conversation of the person. */
  ask: Type.Optional(TeamAsk),
}, object);
export type Team = Static<typeof Team>;
/** The person starts a sub-session beside the source conversation (`/side`): its name and its first work. */
export const TeamCreate = Type.Object({ operationId: id, source: TeamSource, bot: Type.Object({ name: TaskTitle, mission: TaskBrief }, object) }, object);
export type TeamCreate = Static<typeof TeamCreate>;
/** The person mentions a bot (`@Name text`) in the conversation `source`: the bot answers in a session of its own for it. `bot`: the bot's id or name. */
export const TeamAskRequest = Type.Object({ operationId: id, source: TeamSource, bot: Type.String({ minLength: 1, maxLength: 300 }), text: Type.String({ minLength: 1, maxLength: ASK_LIMIT }) }, object);
export type TeamAskRequest = Static<typeof TeamAskRequest>;
export const TeamAction = Type.Union([
  // The person ends a sub-session: its running turn stops and its session is released.
  Type.Object({ teamId: id, action: Type.Literal('stop_sub_session') }, object),
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
  // A bot's sub-session tools, called as its main session (bots design 5.1). Work reaches a sub-session as input; its results come from its turns.
  // workspace: where it works (default same); worktree needs the commit it starts from. provider and model choose its agent.
  Type.Object({ action: Type.Literal('create_sub_session'), owner: TaskOwner, operationId: id, name: Type.String({ minLength: 1, maxLength: SUB_SESSION_NAME_LIMIT, pattern: '\\S' }), prompt: TaskBrief,
    workspace: Type.Optional(TaskWorkspace), commit: Type.Optional(gitObject), provider: Type.Optional(id), model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** The board items it takes up: it becomes their owner. */
    trackedTaskKeys: Type.Optional(Type.Array(BoardItem.properties.key, { maxItems: 10, uniqueItems: true })), cause: Type.Optional(TurnCause),
    /** Where it works: a Host the caller read from `list_hosts` (default: the caller's own), and in it one existing folder, or a new folder created under a workspace of that Host. */
    host: Type.Optional(id), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    newFolder: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), under: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, object)) }, object),
  // More work for a sub-session of the caller. title: one line naming this piece of work. delivery: queue (between turns) or interrupt (stop the running turn first).
  Type.Object({ action: Type.Literal('send_to_sub_session'), owner: BotCaller, subSessionId: id, operationId: id, text: Type.String({ minLength: 1, maxLength: TASK_BRIEF_LIMIT }),
    title: Type.String({ minLength: 1, maxLength: SUB_SESSION_LINE_LIMIT }), delivery: Type.Optional(enumOf('queue', 'interrupt')),
    trackedTaskKeys: Type.Optional(Type.Array(BoardItem.properties.key, { maxItems: 10, uniqueItems: true })), cause: Type.Optional(TurnCause) }, object),
  Type.Object({ action: Type.Literal('get_sub_session_status'), owner: BotCaller, subSessionIds: Type.Optional(Type.Array(id, { maxItems: 20 })) }, object),
  Type.Object({ action: Type.Literal('stop_sub_session'), owner: BotCaller, subSessionId: id }, object),
  // A sub-session's own report (communicate_update): what it is doing now, and the result of the piece of work it finished.
  Type.Object({ action: Type.Literal('sub_update'), owner: BotCaller, currentStep: Type.Optional(Type.String({ minLength: 1, maxLength: SUB_SESSION_LINE_LIMIT })),
    finalSummary: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT })) }, object),
  // A sub-session's turn ended: its Host sends the outcome and the final text, never the model.
  Type.Object({ action: Type.Literal('sub_turn_end'), teamId: id, memberId: id, outcome: TaskOutcome, text: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT })) }, object),
  // The person wrote to a sub-session directly: its Host says so.
  Type.Object({ action: Type.Literal('sub_told'), teamId: id, memberId: id, operationId: id, text: Type.String({ minLength: 1, maxLength: TASK_TOLD_LIMIT }) }, object),
  // Every bot's own calls, made as its main session (bots design 5.1). A bot creates standing bots: its recruits.
  Type.Object({ action: Type.Literal('create_bot'), owner: TaskOwner, operationId: id, name: TaskTitle, mission: TaskBrief,
    message: Type.Optional(BotText), provider: Type.Optional(id), model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** The item of the caller's board this bot is created for: it records the assignee and the brief, and the bot's input names it. */
    item: Type.Optional(BoardItem.properties.key), cause: Type.Optional(TurnCause),
    /** Where the bot works: a Host the caller read from `list_hosts` (default: the caller's own), and in it one existing folder, or a new folder created under a workspace of that Host. */
    host: Type.Optional(id), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    newFolder: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), under: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, object)) }, object),
  Type.Object({ action: Type.Literal('bot_message'), owner: BotCaller, operationId: id, to: Type.String({ minLength: 1, maxLength: 300 }), text: BotText, cause: Type.Optional(TurnCause),
    replyTo: Type.Optional(AssistantMessageId), status: Type.Optional(Type.Union([Type.Literal('progress'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('needs_input'), Type.Literal('ack')])),
    /** In a room: pass this turn instead of speaking. */
    pass: Type.Optional(Type.Boolean()),
    /** Files already uploaded with attachment_finish, which the message carries (bots design 3.4). */
    attachments: Type.Optional(Type.Array(AttachmentId, { minItems: 1, maxItems: ATTACHMENTS_PER_MESSAGE, uniqueItems: true })),
    /** Sent to a bot: the item of the sender's board it serves. Sent to the sender's chief with a status: the item of the chief's board it reports on. */
    item: Type.Optional(BoardItem.properties.key),
    /** A worktree bot's result: where its patch was saved on its Host, added to the report by the Relay. */
    patch: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, object),
  // A standing bot's turn ended: its final text answers the one message that started it (bots design 3.3). The Host sends it, never the model.
  Type.Object({ action: Type.Literal('bot_reply'), owner: BotCaller, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }),
    cause: Type.Object({ kind: Type.Literal('framed'), answers: AssistantMessageId }, object) }, object),
  // An answer session's turn ended: its final text answers what the person asked (bots plan 8b). The Host sends it, never the model.
  Type.Object({ action: Type.Literal('bot_answer'), owner: BotCaller, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }),
    cause: Type.Object({ kind: Type.Literal('framed'), asked: Type.Literal(true) }, object) }, object),
  // The person wrote into a standing bot's session: its chief, if a bot, hears it (bots design 3.5). The Host sends it from its record of the input.
  Type.Object({ action: Type.Literal('bot_told'), owner: BotCaller, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }),
    cause: Type.Object({ kind: Type.Literal('person'), messageId: Type.String({ minLength: 1, maxLength: 256 }) }, object) }, object),
  // A bot's files: uploaded in order in chunks and finished, then named by a message; downloaded by the receiver chunk by chunk (bots design 3.4).
  Type.Object({ action: Type.Literal('attachment_begin'), owner: BotCaller, name: BotAttachment.properties.name, mediaType: BotAttachment.properties.mediaType,
    byteLength: BotAttachment.properties.byteLength, sha256: BotAttachment.properties.sha256 }, object),
  Type.Object({ action: Type.Literal('attachment_chunk'), owner: BotCaller, attachment: AttachmentId, offset: Type.Integer({ minimum: 0 }),
    contentBase64: Type.String({ minLength: 4, maxLength: Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 }) }, object),
  Type.Object({ action: Type.Literal('attachment_finish'), owner: BotCaller, attachment: AttachmentId }, object),
  Type.Object({ action: Type.Literal('attachment_read'), owner: BotCaller, attachment: AttachmentId, offset: Type.Integer({ minimum: 0 }) }, object),
  Type.Object({ action: Type.Literal('list_bots'), owner: BotCaller }, object),
  /** The Hosts the caller's account runs, with what each reports and its workspaces' folders, for choosing where a bot works. */
  Type.Object({ action: Type.Literal('list_hosts'), owner: BotCaller }, object),
  // A bot's turn ended: its Host counts the turn and its usage in the turn's chain.
  Type.Object({ action: Type.Literal('chain_turn'), owner: BotCaller, cause: TurnCause, tokens: Type.Integer({ minimum: 0 }), costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object),
  // A bot's native tool approval is pending, or the person chose "for this chain in this folder" for it: the Host asks whether a standing approval of the turn's chain covers the folder
  // (counting the use), or, with `grant`, records the person's choice. Only the person's recorded choice ever answers.
  Type.Object({ action: Type.Literal('chain_approval'), owner: BotCaller, cause: Type.Optional(TurnCause), cwd: StandingApproval.properties.cwd, grant: Type.Optional(Type.Literal(true)) }, object),
  Type.Object({ action: Type.Literal('update_mission'), owner: BotCaller, mission: BotMission }, object),
  // A bot keeps its own memory, and no one else's: the caller is the only bot a call names. `replace` is the id or the exact text of the fact the new text takes the place of.
  Type.Object({ action: Type.Literal('remember'), owner: BotCaller, text: BotFact.properties.text, replace: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }, object),
  Type.Object({ action: Type.Literal('forget'), owner: BotCaller, fact: Type.String({ minLength: 1, maxLength: 300 }) }, object),
  // A standing bot's chief moves it to another standing bot, or to the person (`chief` person).
  Type.Object({ action: Type.Literal('set_chief'), owner: BotCaller, bot: Type.String({ minLength: 1, maxLength: 300 }), chief: Type.String({ minLength: 1, maxLength: 300 }) }, object),
  // A bot reads its own board, or the board of a standing bot it is chief of (read only); item names one item with its whole brief.
  Type.Object({ action: Type.Literal('board'), owner: BotCaller, bot: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), item: Type.Optional(BoardItem.properties.key) }, object),
  // Every write names the version it read (bots design 6.1). A new item names none; `assignee` is a bot by name or id, or self. parent null clears it.
  Type.Object({ action: Type.Literal('update_board'), owner: BotCaller,
    items: Type.Optional(Type.Array(BoardItemEdit, { minItems: 1, maxItems: 10 })), plan: Type.Optional(BoardPlanEdit) }, object),
  Type.Object({ action: Type.Literal('set_timer'), owner: BotCaller, name: BotTimer.properties.name, minutes: Type.Integer({ minimum: 0, maximum: 7 * 24 * 60 }) }, object),
  Type.Object({ action: Type.Literal('bot_session'), owner: BotCaller, bot: Type.String({ minLength: 1, maxLength: 300 }) }, object),
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
  room: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, object)),
  /** The seat is a bot's answer session: it starts with the bot's mission and memory, and works where its main session works. */
  ask: Type.Optional(Type.Object({ botId: BotId, mission: Type.Optional(BotMission), memory: Type.Optional(Type.Array(BotFact, { maxItems: 50 })) }, object)) }, object);
export type TeamSeat = Static<typeof TeamSeat>;
/** What a member of a temporary bot's Team may carry about how its session works; any other member carries none. */
const workerFields = ['model', 'reasoningEffort', 'access', 'workspace'] as const;
const plainMember = (member: TeamMember) => workerFields.every(field => member[field] === undefined);
/** A task has its worker and then its owner; an inbox, a link and a room bind main sessions; an answer session is one seat. A Team is one of these five. */
const validShape = (value: Team) => {
  if (value.ask) return !value.task && !value.link && !value.room && !value.inbox && value.members.length === 1 && value.members[0]!.role === 'leader'
    && value.members[0]!.workspace === undefined;
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
  // A task's worker and an inbox's seat may run on another Host than the session that made them (source); any other Team lives on one Host.
  && (value.task !== undefined || value.inbox !== undefined || value.members[0]!.hostId === value.source.hostId)
  && new Set(value.members.map(member => member.id)).size === value.members.length
  && new Set([...value.messages, ...(value.unresolvedReceipts ?? [])].map(message => message.id)).size === value.messages.length + (value.unresolvedReceipts?.length ?? 0)
  && (value.unresolvedReceipts ?? []).every(receipt => value.members.some(member => member.id === receipt.from) && value.members.some(member => member.id === receipt.to && (!receipt.resolvedTarget || member.providerId === receipt.resolvedTarget.providerId)))
  && value.messages.every(message => !message.resolvedTarget || value.members.some(member => member.id === message.to && member.providerId === message.resolvedTarget!.providerId))
  && value.messages.every(message => value.members.some(member => member.id === message.from) && value.members.some(member => member.id === message.to));
export const isTeamAskRequest = (value: unknown): value is TeamAskRequest => Value.Check(TeamAskRequest, value);
export const isTeamCreate = (value: unknown): value is TeamCreate => Value.Check(TeamCreate, value);
export const isTeamAction = (value: unknown): value is TeamAction => Value.Check(TeamAction, value);
export const isTeamHostCall = (value: unknown): value is TeamHostCall => Value.Check(TeamHostCall, value);
export const isTeamSeat = (value: unknown): value is TeamSeat => Value.Check(TeamSeat, value);

export const isTeamMember = (value: unknown): value is TeamMember => Value.Check(TeamMember, value);

