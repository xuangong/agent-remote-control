import { Type, type Static } from '@sinclair/typebox';
import { NativeSessionRef } from './session-succession.js';
import { Value } from '@sinclair/typebox/value';
import { TeamResource } from './team-resource.js';
import { CallForSupportCallInput, CallForSupportFinding, CallForSupportGroup, CallForSupportMandate, CallForSupportReportStatus, CallForSupportRosterProposal,
  isCallForSupportGroup } from './call-for-support.js';
import { TaskBrief, TaskDoneWhen, TaskOwner, TaskWorkspace, AssistantMessageId, ASSISTANT_MESSAGE_HOP_LIMIT, ASSISTANT_MESSAGE_LIMIT, ROOM_MINUTES_LIMIT, ROOM_TRANSCRIPT_LIMIT, ROOM_TURN_LIMIT, TaskReportStatus, TaskTitle, TeamTask, TASK_BRIEF_LIMIT, TASK_QUESTION_LIMIT, TASK_SUMMARY_LIMIT, TASK_TOLD_LIMIT, isTeamTask } from './task.js';
const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const short = Type.String({ maxLength: 2048 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const gitObject = Type.String({ pattern: '^[0-9a-f]{7,64}$' });
export const TeamSource = Type.Object({ hostId: id, providerId: id, nativeSessionId: id, title: Type.String({ minLength: 1, maxLength: 256 }) }, object);
export type TeamSource = Static<typeof TeamSource>;
/** Where a Call For Support supporter works: the worker's directory read-only, or its own worktree at a commit. */
export const TeamMemberWorkspace = Type.Union([
  Type.Object({ kind: Type.Literal('shared') }, object),
  Type.Object({ kind: Type.Literal('worktree'), commit: gitObject }, object),
  Type.Object({ kind: Type.Literal('remote'), commit: gitObject, repository: Type.String({ minLength: 1, maxLength: 2048 }),
    /** The bundle of the commit the worker's Host uploaded, granted to this member. */
    bundle: Type.Optional(id) }, object),
]);
export type TeamMemberWorkspace = Static<typeof TeamMemberWorkspace>;
export const TeamMember = Type.Object({
  /** requester: the worker of a Call For Support group, bound to its existing session. */
  id, hostId: id, providerId: id, role: enumOf('leader', 'member', 'requester'), name: Type.String({ minLength: 1, maxLength: 256 }),
  responsibility: short, cwd: Type.Optional(short), nativeSessionId: Type.Optional(NativeSessionRef.properties.nativeSessionId),
  /** released: a supporter no longer in the group; its session is kept for history and receives nothing. */
  creation: enumOf('reserved', 'ready', 'unknown', 'abandoned', 'released'), activity: enumOf('unknown', 'idle', 'busy'),
  summary: short, updatedAt: Type.Number(), error: Type.Optional(short),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), reasoningEffort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  /** The session must not write its working directory. */
  access: Type.Optional(Type.Literal('read_only')), workspace: Type.Optional(TeamMemberWorkspace),
  usage: Type.Optional(Type.Object({ tokens: Type.Integer({ minimum: 0 }), costUsd: Type.Optional(Type.Number({ minimum: 0 })), updatedAt: Type.Number() }, object)),
}, object);
export type TeamMember = Static<typeof TeamMember>;
export { TeamResource };
export const TeamResourceUpload = Type.Object({ ownerMemberId: id, expiresAt: Type.Number(), resource: TeamResource }, object);
export type TeamResourceUpload = Static<typeof TeamResourceUpload>;
export const TeamMessage = Type.Object({ id, from: id, to: id, text, resources: Type.Optional(Type.Array(TeamResource, { minItems: 1, maxItems: 8 })),
  status: enumOf('queued', 'dispatching', 'accepted', 'rejected', 'unknown', 'canceled'),
  resolvedTarget: Type.Optional(NativeSessionRef), acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), createdAt: Type.Number(), error: Type.Optional(short),
  /** The Call For Support call this message carries or reports. */
  callForSupportCallId: Type.Optional(id),
}, object);
export type TeamMessage = Static<typeof TeamMessage>;
export const TEAM_DELIVERY_RECEIPT_LIMIT = 200;
/** Recoverable legacy delivery evidence whose original body has already been compacted. */
export const TeamUnresolvedReceipt = Type.Object({ ...Type.Omit(TeamMessage, ['text', 'resources', 'status', 'acceptance']).properties, status: Type.Literal('accepted') }, object);
export type TeamUnresolvedReceipt = Static<typeof TeamUnresolvedReceipt>;
/**
 * Two assistants' link: their keys in member order, and the latest messages between them with their hop along a reply chain,
 * so a reply names a message it answers and a chain stops at the hop limit.
 */
export const TeamLink = Type.Object({ assistants: Type.Tuple([id, id]),
  recent: Type.Array(Type.Object({ id: AssistantMessageId, from: id, hop: Type.Integer({ minimum: 1, maximum: ASSISTANT_MESSAGE_HOP_LIMIT }), operationId: id }, object), { maxItems: 64 }) }, object);
export type TeamLink = Static<typeof TeamLink>;
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
  resourceUploads: Type.Optional(Type.Array(TeamResourceUpload, { maxItems: 1024 })),
  createdAt: Type.Number(), updatedAt: Type.Number(),
  /** Set for a Call For Support group: the Leader coordinates and the requester is the worker. */
  callForSupport: Type.Optional(CallForSupportGroup),
  /** Set for a task: the Leader is the worker session and the requester is the main session that owns the task. */
  task: Type.Optional(TeamTask),
  /** Set for the link between two assistants: each member is one assistant's main session, bound where it is. */
  link: Type.Optional(TeamLink),
  /** Set for a room of assistants and people; every member is an assistant's main session. */
  room: Type.Optional(TeamRoom),
}, object);
export type Team = Static<typeof Team>;
export const TeamCreate = Type.Object({ operationId: id, source: TeamSource,
  callForSupport: Type.Optional(Type.Object({ profileId: id, call: CallForSupportCallInput, fresh: Type.Optional(Type.Boolean()) }, object)) }, object);
export type TeamCreate = Static<typeof TeamCreate>;
export const TeamAction = Type.Union([
  Type.Object({ teamId: id, action: Type.Literal('add_member'), operationId: id, hostId: id, providerId: id,
    cwd: short, name: Type.String({ minLength: 1, maxLength: 256 }), responsibility: short }, object),
  Type.Object({ teamId: id, action: enumOf('archive', 'restore') }, object),
  Type.Object({ teamId: id, action: Type.Literal('rename'), title: Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' }) }, object),
  Type.Object({ teamId: id, action: Type.Literal('retry_creation'), memberId: id }, object),
  Type.Object({ teamId: id, action: Type.Literal('abandon_creation'), memberId: id }, object),
  Type.Object({ teamId: id, action: Type.Literal('resolve_message'), messageId: id, outcome: enumOf('accepted', 'rejected') }, object),
  Type.Object({ teamId: id, action: Type.Literal('call_for_support'), operationId: id, ...CallForSupportCallInput.properties, followUpOf: Type.Optional(id) }, object),
  Type.Object({ teamId: id, action: Type.Literal('resolve_roster'), rosterId: id, decision: enumOf('approve', 'reject'), note: Type.Optional(short) }, object),
  Type.Object({ teamId: id, action: Type.Literal('release_member'), memberId: id }, object),
  Type.Object({ teamId: id, action: Type.Literal('update_mandate'), mandate: CallForSupportMandate, profileRevision: Type.Optional(Type.Integer({ minimum: 1 })) }, object),
  Type.Object({ teamId: id, action: Type.Literal('resume_group') }, object),
  // The person stops a task, or takes it as done.
  Type.Object({ teamId: id, action: Type.Literal('cancel_task') }, object),
  Type.Object({ teamId: id, action: Type.Literal('mark_task_done') }, object),
  // The person writes in a room, or ends it.
  Type.Object({ teamId: id, action: Type.Literal('room_post'), operationId: id, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }) }, object),
  Type.Object({ teamId: id, action: Type.Literal('close_room') }, object),
]);
export type TeamAction = Static<typeof TeamAction>;
/** Removes an archived Call For Support group for good, so its worker's next call for the profile starts a new group. */
export const TeamDelete = Type.Object({ teamId: id }, object);
export type TeamDelete = Static<typeof TeamDelete>;
export const TeamHostCall = Type.Union([
  Type.Object({ action: Type.Literal('poll') }, object),
  Type.Object({ action: Type.Literal('resource_begin'), teamId: id, memberId: id, operationId: id,
    name: TeamResource.properties.name, mediaType: TeamResource.properties.mediaType, byteLength: TeamResource.properties.byteLength, sha256: TeamResource.properties.sha256 }, object),
  Type.Object({ action: Type.Literal('resource_chunk'), teamId: id, memberId: id, operationId: id, offset: Type.Integer({ minimum: 0 }), contentBase64: Type.String({ maxLength: 43692 }) }, object),
  Type.Object({ action: Type.Literal('resource_finish'), teamId: id, memberId: id, operationId: id }, object),
  Type.Object({ action: Type.Literal('resource_metadata'), teamId: id, memberId: id, resourceId: id }, object),
  Type.Object({ action: Type.Literal('resource_read'), teamId: id, memberId: id, resourceId: id, offset: Type.Integer({ minimum: 0 }) }, object),
  Type.Object({ action: Type.Literal('read'), teamId: id, memberId: id }, object),
  Type.Object({ action: Type.Literal('acknowledge'), teamId: id, memberId: id,
    messageIds: Type.Array(id, { minItems: 1, maxItems: 32, uniqueItems: true }), expectedNativeSessionId: NativeSessionRef.properties.nativeSessionId }, object),
  Type.Object({ action: Type.Literal('send'), teamId: id, memberId: id, to: id, operationId: id, text, resources: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 8, uniqueItems: true })) }, object),
  Type.Object({ action: Type.Literal('describe_member'), teamId: id, memberId: id, target: id, responsibility: short }, object),
  Type.Object({ action: Type.Literal('report'), teamId: id, memberId: id, summary: short }, object),
  Type.Object({ action: Type.Literal('presence'), teamId: id, memberId: id, activity: enumOf('idle', 'busy', 'unknown'),
    // A task worker's pending native interaction, which only the person answers.
    interaction: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_TOLD_LIMIT })) }, object),
  Type.Object({ action: Type.Literal('claim'), teamId: id, memberId: id, messageId: id, expectedNativeSessionId: Type.Optional(NativeSessionRef.properties.nativeSessionId) }, object),
  Type.Object({ action: Type.Literal('settle'), teamId: id, memberId: id, messageId: id, resolvedTarget: Type.Optional(NativeSessionRef), outcome: enumOf('accepted', 'rejected', 'unknown'), acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), error: Type.Optional(short) }, object),
  // Call For Support coordinator.
  Type.Object({ action: Type.Literal('propose_roster'), teamId: id, memberId: id, operationId: id, ...CallForSupportRosterProposal.properties }, object),
  Type.Object({ action: Type.Literal('report_support'), teamId: id, memberId: id, callId: id, operationId: id,
    report: Type.Object({ status: CallForSupportReportStatus, summary: Type.String({ minLength: 1, maxLength: 4000 }), findings: Type.Array(CallForSupportFinding, { maxItems: 64 }),
      resources: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 8, uniqueItems: true })) }, object) }, object),
  Type.Object({ action: Type.Literal('write_ledger'), teamId: id, memberId: id, revision: Type.Integer({ minimum: 0 }), text: Type.String({ maxLength: 16000 }) }, object),
  Type.Object({ action: Type.Literal('release_supporter'), teamId: id, memberId: id, target: id }, object),
  Type.Object({ action: Type.Literal('collect_supporter_patch'), teamId: id, memberId: id, target: id, operationId: id }, object),
  // A Controller reports cumulative usage of one of its members' sessions.
  Type.Object({ action: Type.Literal('report_usage'), teamId: id, memberId: id, tokens: Type.Integer({ minimum: 0 }), costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object),
  // A worker's own tools, by the worker's session on the calling Host.
  Type.Object({ action: Type.Literal('call_for_support'), worker: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId, title: Type.Optional(TeamSource.properties.title) }, object),
    operationId: id, roleId: Type.Optional(id), profileId: Type.Optional(id), ...CallForSupportCallInput.properties, followUpOf: Type.Optional(id), fresh: Type.Optional(Type.Boolean()) }, object),
  Type.Object({ action: Type.Literal('support_status'), worker: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object),
    roleId: Type.Optional(id), callId: Type.Optional(id) }, object),
  // Which of the calling Host's sessions may call for support.
  Type.Object({ action: Type.Literal('support_enablement') }, object),
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
  // A task's worker reports its result once.
  Type.Object({ action: Type.Literal('report_task'), teamId: id, memberId: id, status: TaskReportStatus, summary: Type.String({ minLength: 1, maxLength: TASK_SUMMARY_LIMIT }) }, object),
  // An assistant's main session lists the account's other assistants, and messages one.
  Type.Object({ action: Type.Literal('list_assistants'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object) }, object),
  Type.Object({ action: Type.Literal('message_assistant'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object),
    to: Type.String({ minLength: 1, maxLength: 300 }), operationId: id, text: Type.String({ minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT }), replyTo: Type.Optional(AssistantMessageId) }, object),
  // An assistant opens a room with others, and speaks or passes when the room asks it.
  Type.Object({ action: Type.Literal('open_room'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), operationId: id,
    name: Type.String({ minLength: 1, maxLength: 120 }), topic: roomText, members: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 7 }),
    minutes: Type.Integer({ minimum: 1, maximum: ROOM_MINUTES_LIMIT }) }, object),
  Type.Object({ action: Type.Literal('room_say'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), roomId: id, text: roomText,
    done: Type.Optional(Type.Boolean()) }, object),
  Type.Object({ action: Type.Literal('room_pass'), owner: Type.Object({ providerId: id, nativeSessionId: NativeSessionRef.properties.nativeSessionId }, object), roomId: id }, object),
  // A task's worker asks its owner, and the worker's Host says what the person wrote to the worker directly.
  Type.Object({ action: Type.Literal('ask_owner'), teamId: id, memberId: id, question: Type.String({ minLength: 1, maxLength: TASK_QUESTION_LIMIT }) }, object),
  Type.Object({ action: Type.Literal('tell_task'), teamId: id, memberId: id, operationId: id, text: Type.String({ minLength: 1, maxLength: TASK_TOLD_LIMIT }) }, object),
  // The status of groups the calling Host holds seats in, so it can forget the seats of archived and removed groups.
  Type.Object({ action: Type.Literal('support_group_states'), teamIds: Type.Array(id, { minItems: 1, maxItems: 64, uniqueItems: true }) }, object),
]);
export type TeamHostCall = Static<typeof TeamHostCall>;
export const TeamSeat = Type.Object({ teamId: id, source: TeamSource, member: TeamMember,
  /** The seat belongs to a Call For Support group serving this role. */
  callForSupport: Type.Optional(Type.Object({ role: Type.String({ minLength: 1, maxLength: 256 }), description: Type.String({ maxLength: 4000 }) }, object)),
  /** The seat belongs to a task: its worker as Leader, or the main session that owns it as requester. */
  task: Type.Optional(Type.Object({ title: TaskTitle }, object)),
  /** The seat is one assistant's main session in a link: bound where it is, it only receives messages. */
  link: Type.Optional(Type.Object({ peer: Type.String({ minLength: 1, maxLength: 256 }) }, object)),
  /** The seat is one assistant's main session in a room. */
  room: Type.Optional(Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, object)) }, object);
export type TeamSeat = Static<typeof TeamSeat>;
const groupFields = ['model', 'reasoningEffort', 'access', 'workspace', 'usage'] as const;
/** A Call For Support group has exactly one requester after its Leader; a task has its worker and then its owner; other Teams have no requester and no group fields. */
const validGroupShape = (value: Team) => {
  const group = value.callForSupport, requesters = value.members.filter(member => member.role === 'requester');
  if (value.room) return !group && !value.task && !value.link && value.members.length >= 2 && value.members.every(member => member.role === 'requester' && member.creation !== 'released'
    && groupFields.every(field => member[field] === undefined)) && value.messages.every(message => message.callForSupportCallId === undefined)
    && (value.unresolvedReceipts ?? []).every(receipt => receipt.callForSupportCallId === undefined);
  if (value.link) return !group && !value.task && value.members.length === 2 && value.members.every(member => member.role === 'requester')
    && value.members.every(member => member.creation !== 'released' && groupFields.every(field => member[field] === undefined))
    && value.messages.every(message => message.callForSupportCallId === undefined) && (value.unresolvedReceipts ?? []).every(receipt => receipt.callForSupportCallId === undefined);
  if (value.task) return !group && isTeamTask(value.task) && value.members.length === 2 && value.members[1]!.role === 'requester'
    && value.members.every(member => member.creation !== 'released') && value.members[1]!.access === undefined && value.members[1]!.workspace === undefined
    && (value.members[0]!.workspace === undefined || value.members[0]!.workspace.kind === 'worktree')
    && value.messages.every(message => message.callForSupportCallId === undefined) && (value.unresolvedReceipts ?? []).every(receipt => receipt.callForSupportCallId === undefined);
  if (!group) return !requesters.length && value.members.every(member => groupFields.every(field => member[field] === undefined) && member.creation !== 'released')
    && value.messages.every(message => message.callForSupportCallId === undefined) && (value.unresolvedReceipts ?? []).every(receipt => receipt.callForSupportCallId === undefined);
  return isCallForSupportGroup(group) && requesters.length === 1 && value.members[0]?.role !== 'requester'
    && value.members.every(member => member.workspace?.kind !== 'shared' || member.access === 'read_only' && member.hostId === value.source.hostId)
    && value.messages.every(message => message.status !== 'queued' || value.members.find(member => member.id === message.to)?.creation !== 'released');
};
export const isTeam = (value: unknown): value is Team => Value.Check(Team, value)
  // A link binds two main sessions; every other Team starts with its Leader.
  && (value.link || value.room ? true : value.members[0]?.role === 'leader' && value.members.slice(1).every(member => member.role === 'member' || member.role === 'requester')) && validGroupShape(value)
  && value.members[0]!.hostId === value.source.hostId
  && new Set(value.members.map(member => member.id)).size === value.members.length
  && new Set([...value.messages, ...(value.unresolvedReceipts ?? [])].map(message => message.id)).size === value.messages.length + (value.unresolvedReceipts?.length ?? 0)
  && (value.unresolvedReceipts ?? []).every(receipt => value.members.some(member => member.id === receipt.from) && value.members.some(member => member.id === receipt.to && (!receipt.resolvedTarget || member.providerId === receipt.resolvedTarget.providerId)))
  && new Set(value.resourceUploads?.map(upload => upload.resource.resourceId) ?? []).size === (value.resourceUploads?.length ?? 0)
  && (value.resourceUploads ?? []).every(upload => value.members.some(member => member.id === upload.ownerMemberId))
  && value.messages.every(message => !message.resources || message.resources.reduce((total, resource) => total + resource.byteLength, 0) <= 100 * 1024 * 1024
    && new Set(message.resources.map(resource => resource.resourceId)).size === message.resources.length
    && message.resources.every(resource => value.resourceUploads?.some(upload => (['resourceId', 'name', 'mediaType', 'byteLength', 'sha256'] as const).every(key => upload.resource[key] === resource[key]))))
  && value.messages.every(message => !message.resolvedTarget || value.members.some(member => member.id === message.to && member.providerId === message.resolvedTarget!.providerId))
  && value.messages.every(message => value.members.some(member => member.id === message.from) && value.members.some(member => member.id === message.to));
export const isTeamCreate = (value: unknown): value is TeamCreate => Value.Check(TeamCreate, value);
export const isTeamAction = (value: unknown): value is TeamAction => Value.Check(TeamAction, value);
export const isTeamDelete = (value: unknown): value is TeamDelete => Value.Check(TeamDelete, value);
export const isTeamHostCall = (value: unknown): value is TeamHostCall => Value.Check(TeamHostCall, value);
export const isTeamSeat = (value: unknown): value is TeamSeat => Value.Check(TeamSeat, value);

export const isTeamMember = (value: unknown): value is TeamMember => Value.Check(TeamMember, value);

export const isTeamResource = (value: unknown): value is TeamResource => Value.Check(TeamResource, value);
