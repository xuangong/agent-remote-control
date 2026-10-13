import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const short = Type.String({ maxLength: 2048 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
export const TeamSource = Type.Object({ hostId: id, providerId: id, nativeSessionId: id, title: Type.String({ minLength: 1, maxLength: 256 }) }, object);
export type TeamSource = Static<typeof TeamSource>;
export const TeamMember = Type.Object({
  id, hostId: id, providerId: id, role: enumOf('leader', 'member'), name: Type.String({ minLength: 1, maxLength: 256 }),
  responsibility: short, cwd: Type.Optional(short), nativeSessionId: Type.Optional(id),
  creation: enumOf('reserved', 'ready', 'unknown', 'abandoned'), activity: enumOf('unknown', 'idle', 'busy'),
  summary: short, updatedAt: Type.Number(), error: Type.Optional(short),
}, object);
export type TeamMember = Static<typeof TeamMember>;
export const TeamResource = Type.Object({ resourceId: id, name: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }), byteLength: Type.Integer({ minimum: 0, maximum: 50 * 1024 * 1024 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, object);
export type TeamResource = Static<typeof TeamResource>;
export const TeamResourceUpload = Type.Object({ ownerMemberId: id, expiresAt: Type.Number(), resource: TeamResource }, object);
export type TeamResourceUpload = Static<typeof TeamResourceUpload>;
export const TeamMessage = Type.Object({ id, from: id, to: id, text, resources: Type.Optional(Type.Array(TeamResource, { minItems: 1, maxItems: 8 })),
  status: enumOf('queued', 'dispatching', 'accepted', 'rejected', 'unknown', 'canceled'),
  acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), createdAt: Type.Number(), error: Type.Optional(short),
}, object);
export type TeamMessage = Static<typeof TeamMessage>;
export const Team = Type.Object({ id, operationId: id, revision: Type.Integer({ minimum: 1 }), source: TeamSource,
  title: Type.String({ minLength: 1, maxLength: 256 }), status: enumOf('active', 'archiving', 'archived'),
  members: Type.Array(TeamMember, { minItems: 1, maxItems: 12 }), messages: Type.Array(TeamMessage, { maxItems: 200 }),
  resourceUploads: Type.Optional(Type.Array(TeamResourceUpload, { maxItems: 1024 })),
  createdAt: Type.Number(), updatedAt: Type.Number(),
}, object);
export type Team = Static<typeof Team>;
export const TeamCreate = Type.Object({ operationId: id, source: TeamSource }, object);
export type TeamCreate = Static<typeof TeamCreate>;
export const TeamAction = Type.Union([
  Type.Object({ teamId: id, action: Type.Literal('add_member'), operationId: id, hostId: id, providerId: id,
    cwd: short, name: Type.String({ minLength: 1, maxLength: 256 }), responsibility: short }, object),
  Type.Object({ teamId: id, action: enumOf('archive', 'restore') }, object),
  Type.Object({ teamId: id, action: Type.Literal('rename'), title: Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' }) }, object),
  Type.Object({ teamId: id, action: Type.Literal('retry_creation'), memberId: id }, object),
  Type.Object({ teamId: id, action: Type.Literal('abandon_creation'), memberId: id }, object),
  Type.Object({ teamId: id, action: Type.Literal('resolve_message'), messageId: id, outcome: enumOf('accepted', 'rejected') }, object),
]);
export type TeamAction = Static<typeof TeamAction>;
export const TeamHostCall = Type.Union([
  Type.Object({ action: Type.Literal('poll') }, object),
  Type.Object({ action: Type.Literal('resource_begin'), teamId: id, memberId: id, operationId: id,
    name: TeamResource.properties.name, mediaType: TeamResource.properties.mediaType, byteLength: TeamResource.properties.byteLength, sha256: TeamResource.properties.sha256 }, object),
  Type.Object({ action: Type.Literal('resource_chunk'), teamId: id, memberId: id, operationId: id, offset: Type.Integer({ minimum: 0 }), contentBase64: Type.String({ maxLength: 43692 }) }, object),
  Type.Object({ action: Type.Literal('resource_finish'), teamId: id, memberId: id, operationId: id }, object),
  Type.Object({ action: Type.Literal('resource_metadata'), teamId: id, memberId: id, resourceId: id }, object),
  Type.Object({ action: Type.Literal('resource_read'), teamId: id, memberId: id, resourceId: id, offset: Type.Integer({ minimum: 0 }) }, object),
  Type.Object({ action: Type.Literal('read'), teamId: id, memberId: id }, object),
  Type.Object({ action: Type.Literal('send'), teamId: id, memberId: id, to: id, operationId: id, text, resources: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 8, uniqueItems: true })) }, object),
  Type.Object({ action: Type.Literal('describe_member'), teamId: id, memberId: id, target: id, responsibility: short }, object),
  Type.Object({ action: Type.Literal('report'), teamId: id, memberId: id, summary: short }, object),
  Type.Object({ action: Type.Literal('presence'), teamId: id, memberId: id, activity: enumOf('idle', 'busy', 'unknown') }, object),
  Type.Object({ action: Type.Literal('claim'), teamId: id, memberId: id, messageId: id }, object),
  Type.Object({ action: Type.Literal('settle'), teamId: id, memberId: id, messageId: id, outcome: enumOf('accepted', 'rejected', 'unknown'), acceptance: Type.Optional(enumOf('started', 'queued', 'handled')), error: Type.Optional(short) }, object),
]);
export type TeamHostCall = Static<typeof TeamHostCall>;
export const TeamSeat = Type.Object({ teamId: id, source: TeamSource, member: TeamMember }, object);
export type TeamSeat = Static<typeof TeamSeat>;
export const isTeam = (value: unknown): value is Team => Value.Check(Team, value)
  && value.members[0]?.role === 'leader' && value.members.slice(1).every(member => member.role === 'member')
  && value.members[0].hostId === value.source.hostId
  && value.members.every(member => member.creation !== 'ready' || !!member.nativeSessionId)
  && new Set(value.members.map(member => member.id)).size === value.members.length
  && new Set(value.messages.map(message => message.id)).size === value.messages.length
  && new Set(value.resourceUploads?.map(upload => upload.resource.resourceId) ?? []).size === (value.resourceUploads?.length ?? 0)
  && (value.resourceUploads ?? []).every(upload => value.members.some(member => member.id === upload.ownerMemberId))
  && value.messages.every(message => !message.resources || message.resources.reduce((total, resource) => total + resource.byteLength, 0) <= 100 * 1024 * 1024
    && new Set(message.resources.map(resource => resource.resourceId)).size === message.resources.length
    && message.resources.every(resource => value.resourceUploads?.some(upload => (['resourceId', 'name', 'mediaType', 'byteLength', 'sha256'] as const).every(key => upload.resource[key] === resource[key]))))
  && value.messages.every(message => value.members.some(member => member.id === message.from) && value.members.some(member => member.id === message.to));
export const isTeamCreate = (value: unknown): value is TeamCreate => Value.Check(TeamCreate, value);
export const isTeamAction = (value: unknown): value is TeamAction => Value.Check(TeamAction, value);
export const isTeamHostCall = (value: unknown): value is TeamHostCall => Value.Check(TeamHostCall, value);
export const isTeamSeat = (value: unknown): value is TeamSeat => Value.Check(TeamSeat, value);

export const isTeamMember = (value: unknown): value is TeamMember => Value.Check(TeamMember, value);

export const isTeamResource = (value: unknown): value is TeamResource => Value.Check(TeamResource, value);
