import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TeamResource } from './team-resource.js';
import { utf8ByteLength } from './session-context.js';

const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const short = Type.String({ maxLength: 2048 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const gitObject = Type.String({ pattern: '^[0-9a-f]{7,64}$' });
const model = Type.String({ minLength: 1, maxLength: 256 });
const effort = Type.String({ minLength: 1, maxLength: 64 });

export const CALL_FOR_SUPPORT_PROFILE_LIMIT = 32;
/** A report's JSON; larger material belongs in resources. */
export const CALL_FOR_SUPPORT_REPORT_BYTES = 24 * 1024;
/** A group's Call For Support state after compaction. */
export const CALL_FOR_SUPPORT_GROUP_BYTES = 64 * 1024;
export const CALL_FOR_SUPPORT_CALL_LIMIT = 64;

export const CallForSupportWorkspaceKind = enumOf('shared', 'worktree', 'remote');
export type CallForSupportWorkspaceKind = Static<typeof CallForSupportWorkspaceKind>;
export const CallForSupportSupporterConfiguration = Type.Object({ providerId: id, model, reasoningEffort: Type.Optional(effort) }, object);
export type CallForSupportSupporterConfiguration = Static<typeof CallForSupportSupporterConfiguration>;
export const CallForSupportMandate = Type.Object({
  supporters: Type.Array(CallForSupportSupporterConfiguration, { minItems: 1, maxItems: 8 }),
  maxSupporters: Type.Integer({ minimum: 1, maximum: 6 }),
  workspaces: Type.Array(CallForSupportWorkspaceKind, { minItems: 1, maxItems: 3, uniqueItems: true }),
  remoteHosts: Type.Array(Type.Object({ hostId: id, workspace: Type.String({ minLength: 1, maxLength: 2048 }) }, object), { maxItems: 8 }),
  approval: enumOf('every_roster', 'within_mandate'),
  budget: Type.Optional(Type.Object({ tokensPerCall: Type.Optional(Type.Integer({ minimum: 1 })), tokensTotal: Type.Optional(Type.Integer({ minimum: 1 })),
    costUsdTotal: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }, object)),
}, object);
export type CallForSupportMandate = Static<typeof CallForSupportMandate>;
export const CallForSupportCoordinatorConfiguration = Type.Object({ providerId: Type.Optional(id), model: Type.Optional(model), reasoningEffort: Type.Optional(effort) }, object);
export type CallForSupportCoordinatorConfiguration = Static<typeof CallForSupportCoordinatorConfiguration>;
export const CallForSupportProfile = Type.Object({
  id, name: Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' }), description: Type.String({ maxLength: 4000 }),
  mandate: CallForSupportMandate, coordinator: CallForSupportCoordinatorConfiguration,
  /** Sessions without an explicit enablement may call for this profile. */
  enableByDefault: Type.Boolean(), revision: Type.Integer({ minimum: 1 }), updatedAt: Type.Number(),
}, object);
export type CallForSupportProfile = Static<typeof CallForSupportProfile>;
/** What the user defines; the Relay assigns the identity and revision. */
export const CallForSupportProfileInput = Type.Omit(CallForSupportProfile, ['id', 'revision', 'updatedAt']);
export type CallForSupportProfileInput = Static<typeof CallForSupportProfileInput>;

export const CallForSupportContext = Type.Object({ commit: Type.Optional(gitObject), base: Type.Optional(gitObject),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 })), conversation: Type.Optional(Type.Boolean()) }, object);
export type CallForSupportContext = Static<typeof CallForSupportContext>;
export const CallForSupportDeliverable = enumOf('findings', 'answer', 'test_report', 'patch');
export type CallForSupportDeliverable = Static<typeof CallForSupportDeliverable>;
export const CallForSupportFinding = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), severity: enumOf('blocking', 'major', 'minor', 'note'),
  location: Type.Optional(short), problem: Type.String({ minLength: 1, maxLength: 4000 }), suggestion: Type.Optional(Type.String({ maxLength: 4000 })),
  agreement: Type.Optional(Type.String({ maxLength: 256 })), evidence: Type.Optional(Type.String({ maxLength: 4000 })) }, object);
export type CallForSupportFinding = Static<typeof CallForSupportFinding>;
export const CallForSupportReportStatus = enumOf('reported', 'needs_input', 'failed');
export const CallForSupportReport = Type.Object({ status: CallForSupportReportStatus, summary: Type.String({ minLength: 1, maxLength: 4000 }),
  findings: Type.Array(CallForSupportFinding, { maxItems: 64 }), resources: Type.Optional(Type.Array(TeamResource, { minItems: 1, maxItems: 8 })),
  /** Findings or evidence were removed to keep the group within its storage bound. */
  compacted: Type.Optional(Type.Literal(true)) }, object);
export type CallForSupportReport = Static<typeof CallForSupportReport>;
export const CallForSupportUsage = Type.Object({ tokens: Type.Integer({ minimum: 0 }), costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object);
export type CallForSupportUsage = Static<typeof CallForSupportUsage>;
export const CallForSupportCallInput = Type.Object({ task: Type.String({ minLength: 1, maxLength: 12000 }), context: Type.Optional(CallForSupportContext), deliverable: CallForSupportDeliverable }, object);
export type CallForSupportCallInput = Static<typeof CallForSupportCallInput>;
export const CallForSupportCall = Type.Object({ id, ...CallForSupportCallInput.properties, followUpOf: Type.Optional(id), origin: enumOf('user', 'worker'),
  status: enumOf('open', 'queued', 'reported', 'needs_input', 'failed'), createdAt: Type.Number(), reportedAt: Type.Optional(Type.Number()),
  usage: CallForSupportUsage, report: Type.Optional(CallForSupportReport) }, object);
export type CallForSupportCall = Static<typeof CallForSupportCall>;
export const CallForSupportRosterMember = Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), responsibility: short,
  ...CallForSupportSupporterConfiguration.properties, workspace: CallForSupportWorkspaceKind, hostId: Type.Optional(id) }, object);
export type CallForSupportRosterMember = Static<typeof CallForSupportRosterMember>;
export const CallForSupportRosterProposal = Type.Object({ members: Type.Array(CallForSupportRosterMember, { minItems: 1, maxItems: 6 }),
  release: Type.Optional(Type.Array(id, { maxItems: 12, uniqueItems: true })), rationale: Type.String({ maxLength: 4000 }) }, object);
export type CallForSupportRosterProposal = Static<typeof CallForSupportRosterProposal>;
export const CallForSupportRoster = Type.Object({ id, status: enumOf('pending', 'approved', 'rejected', 'provisioned'), ...CallForSupportRosterProposal.properties,
  withinMandate: Type.Boolean(), createdAt: Type.Number(), decidedAt: Type.Optional(Type.Number()), note: Type.Optional(short) }, object);
export type CallForSupportRoster = Static<typeof CallForSupportRoster>;
export const CallForSupportGroup = Type.Object({
  profileId: Type.Optional(id), profileRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  role: Type.String({ minLength: 1, maxLength: 256 }), description: Type.String({ maxLength: 4000 }),
  mandate: CallForSupportMandate, coordinator: Type.Object({ providerId: id, model: Type.Optional(model), reasoningEffort: Type.Optional(effort) }, object),
  status: enumOf('active', 'paused_budget'), pauseReason: Type.Optional(short),
  calls: Type.Array(CallForSupportCall, { maxItems: CALL_FOR_SUPPORT_CALL_LIMIT }), roster: Type.Optional(CallForSupportRoster),
  ledger: Type.Object({ text: Type.String({ maxLength: 16000 }), revision: Type.Integer({ minimum: 0 }) }, object), usage: CallForSupportUsage,
}, object);
export type CallForSupportGroup = Static<typeof CallForSupportGroup>;

const configurationKey = (value: CallForSupportSupporterConfiguration) => JSON.stringify([value.providerId, value.model, value.reasoningEffort ?? null]);
export const isCallForSupportMandate = (value: unknown): value is CallForSupportMandate => Value.Check(CallForSupportMandate, value)
  && (!value.workspaces.includes('remote') || value.remoteHosts.length > 0)
  && new Set(value.supporters.map(configurationKey)).size === value.supporters.length
  && new Set(value.remoteHosts.map(host => host.hostId)).size === value.remoteHosts.length;
export const isCallForSupportProfile = (value: unknown): value is CallForSupportProfile => Value.Check(CallForSupportProfile, value) && isCallForSupportMandate(value.mandate);
export const isCallForSupportProfileInput = (value: unknown): value is CallForSupportProfileInput => Value.Check(CallForSupportProfileInput, value) && isCallForSupportMandate(value.mandate);
export const isCallForSupportRosterProposal = (value: unknown): value is CallForSupportRosterProposal => Value.Check(CallForSupportRosterProposal, value)
  && value.members.every(member => (member.workspace === 'remote') === (member.hostId !== undefined));
export const isCallForSupportRoster = (value: unknown): value is CallForSupportRoster => Value.Check(CallForSupportRoster, value)
  && isCallForSupportRosterProposal({ members: value.members, ...(value.release ? { release: value.release } : {}), rationale: value.rationale });
export const isCallForSupportReport = (value: unknown): value is CallForSupportReport => Value.Check(CallForSupportReport, value)
  && new Set(value.findings.map(finding => finding.id)).size === value.findings.length;
export const callForSupportReportBytes = (report: CallForSupportReport): number => utf8ByteLength(JSON.stringify(report));
export const isCallForSupportGroup = (value: unknown): value is CallForSupportGroup => Value.Check(CallForSupportGroup, value)
  && isCallForSupportMandate(value.mandate) && (value.roster === undefined || isCallForSupportRoster(value.roster))
  && new Set(value.calls.map(call => call.id)).size === value.calls.length
  && value.calls.filter(call => call.status === 'open').length <= 1
  && value.calls.every(call => (call.followUpOf === undefined || call.followUpOf !== call.id)
    && (call.report === undefined ? call.status === 'open' || call.status === 'queued' : call.report.status === call.status && isCallForSupportReport(call.report))
    && (call.reportedAt === undefined) === (call.report === undefined));
export const isCallForSupportCallInput = (value: unknown): value is CallForSupportCallInput => Value.Check(CallForSupportCallInput, value);
