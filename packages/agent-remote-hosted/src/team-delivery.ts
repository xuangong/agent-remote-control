import { createHash } from 'node:crypto';
import { TEAM_DELIVERY_RECEIPT_LIMIT, isTeam, type Team, type TeamMessage } from '@orchardworks/agent-remote-protocol';

type DeliveryReceipt = Omit<TeamMessage, 'text' | 'resources'> & { fingerprint: string; settledAt: number };
type ResourceGrant = { resourceId: string; memberIds: string[] };

/** Stored role anchors and Relay-only evidence, without client projection evidence. */
export interface SavedTeam extends Omit<Team, 'unresolvedReceipts'> {
  unresolvedReceipts?: never;
  deliveryReceipts?: DeliveryReceipt[];
  resourceGrants?: ResourceGrant[];
}

/**
 * Teams an account may hold. Each is stored as its own record, and a commit encodes only the Teams it changed;
 * the account's Team state stays within 2 MiB.
 */
export const ACCOUNT_TEAM_LIMIT = 1024;
const receiptLifetimeMs = 24 * 60 * 60 * 1000;
const receiptCount = TEAM_DELIVERY_RECEIPT_LIMIT;
const receiptBytes = 32 * 1024;
// Input capacity stays stable while delivery evidence grows. Resources, recipients,
// and settlement metadata remain bounded by their schemas and the full state limit.
export const teamMessageBudgetBytes = (team: Team) => Buffer.byteLength(JSON.stringify(team.messages.map(({ id, from, to, text, createdAt }) => ({ id, from, to, text, createdAt }))));

export function stripPrivateTeamEvidence(team: SavedTeam): Omit<Team, 'unresolvedReceipts'> {
  const { deliveryReceipts: _receipts, resourceGrants: _grants, ...value } = team;
  return value;
}

export function unresolvedTeamDelivery(message: Pick<TeamMessage, 'status' | 'acceptance'>): boolean {
  return ['dispatching', 'unknown'].includes(message.status) || message.status === 'accepted' && !['started', 'handled'].includes(message.acceptance ?? '');
}

export function pendingTeamMessage(message: TeamMessage): boolean {
  return message.status === 'queued' || unresolvedTeamDelivery(message);
}

export function deliveryFingerprint(input: { to: string; text: string; resources?: string[] }): string {
  return createHash('sha256').update(JSON.stringify([input.to, input.text, input.resources ?? []])).digest('hex');
}

/** Migrate old inline history and release settled bodies in the same durable commit. */
export function compactTeamDeliveries(team: SavedTeam, now: number): void {
  const grants = new Map((team.resourceGrants ?? []).map(grant => [grant.resourceId, grant]));
  for (const message of team.messages.filter(message => !pendingTeamMessage(message))) for (const resource of message.resources ?? []) {
    let grant = grants.get(resource.resourceId);
    if (!grant) { grant = { resourceId: resource.resourceId, memberIds: [] }; grants.set(resource.resourceId, grant); }
    if (!grant.memberIds.includes(message.to)) grant.memberIds.push(message.to);
  }
  if (grants.size) team.resourceGrants = [...grants.values()];
  const receipts = new Map((team.deliveryReceipts ?? []).filter(receipt => unresolvedTeamDelivery(receipt) || receipt.settledAt + receiptLifetimeMs > now).map(receipt => [receipt.id, receipt]));
  const pending: TeamMessage[] = [];
  for (const message of team.messages) {
    if (pendingTeamMessage(message)) { pending.push(message); continue; }
    const { text, resources, ...result } = message;
    receipts.set(message.id, { ...result, fingerprint: deliveryFingerprint({ to: message.to, text, resources: resources?.map(resource => resource.resourceId) }), settledAt: now });
  }
  team.messages = pending;
  const retained = [...receipts.values()];
  while (retained.length > receiptCount || Buffer.byteLength(JSON.stringify(retained)) > receiptBytes) {
    const expendable = retained.findIndex(receipt => !unresolvedTeamDelivery(receipt));
    if (expendable < 0) break;
    retained.splice(expendable, 1);
  }
  if (retained.length) team.deliveryReceipts = retained;
  else delete team.deliveryReceipts;
}

/** Settled retry evidence is expendable; legacy unresolved effects remain authoritative. */
export function trimTeamDeliveryReceipts(teams: SavedTeam[], maximumStateBytes: number, stateBytes = Buffer.byteLength(JSON.stringify(teams))): void {
  let excess = stateBytes - maximumStateBytes;
  if (excess <= 0) return;
  const oldest = teams.flatMap(team => (team.deliveryReceipts ?? []).filter(receipt => !unresolvedTeamDelivery(receipt)).map(receipt => ({ team, receipt })))
    .sort((a, b) => a.receipt.settledAt - b.receipt.settledAt);
  for (const { team, receipt } of oldest) {
    team.deliveryReceipts = team.deliveryReceipts!.filter(item => item !== receipt);
    excess -= Buffer.byteLength(JSON.stringify(receipt)) + 1;
    if (!team.deliveryReceipts.length) delete team.deliveryReceipts;
    if (excess <= 0) break;
  }
}

/** Bytes of a frozen value, which never changes. */
const sizes = new WeakMap<object, number>();
function frozenBytes(value: object): number {
  let bytes = sizes.get(value);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(value));
    if (Object.isFrozen(value)) sizes.set(value, bytes);
  }
  return bytes;
}
/** Buffer.byteLength(JSON.stringify(teams)), measuring only the Teams not measured before. */
export function teamStateBytes(teams: readonly SavedTeam[]): number {
  let bytes = 2 + Math.max(0, teams.length - 1);
  for (const team of teams) bytes += frozenBytes(team);
  return bytes;
}

/**
 * Whether compactTeamDeliveries would change the Team. It must agree with that function: a Team it reports unchanged is
 * left as it is, so a change copies and measures only the Teams it touches.
 */
export function teamNeedsCompaction(team: SavedTeam, now: number): boolean {
  if (team.messages.some(message => !pendingTeamMessage(message))) return true;
  if (team.resourceGrants && new Set(team.resourceGrants.map(grant => grant.resourceId)).size !== team.resourceGrants.length) return true;
  const receipts = team.deliveryReceipts;
  if (!receipts) return false;
  return !receipts.length || receipts.some(receipt => !unresolvedTeamDelivery(receipt) && receipt.settledAt + receiptLifetimeMs <= now)
    || new Set(receipts.map(receipt => receipt.id)).size !== receipts.length
    || receipts.length > receiptCount || frozenBytes(receipts) > receiptBytes;
}

export function validSavedTeam(value: unknown): value is SavedTeam {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const team = value as SavedTeam, visible = stripPrivateTeamEvidence(team);
  if (team.unresolvedReceipts !== undefined || !isTeam(visible) || !visible.members.every(member => member.creation !== 'ready' || !!member.nativeSessionId)) return false;
  const receipts = team.deliveryReceipts;
  if (receipts !== undefined) {
    if (!Array.isArray(receipts) || receipts.length > receiptCount || Buffer.byteLength(JSON.stringify(receipts)) > receiptBytes) return false;
    if (!receipts.every(receipt => receipt && typeof receipt === 'object'
      && Object.keys(receipt).every(key => ['id', 'from', 'to', 'status', 'acceptance', 'createdAt', 'error', 'fingerprint', 'settledAt', 'resolvedTarget', 'callForSupportCallId'].includes(key))
      && typeof receipt.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(receipt.fingerprint)
      && Number.isSafeInteger(receipt.settledAt) && receipt.settledAt >= 0)) return false;
    // Older versions compacted accepted input without a native disposition. Keep that evidence unresolved.
    const messages = receipts.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => ({ ...receipt, text: 'receipt' }));
    if (!isTeam({ ...visible, messages }) || messages.some(message => pendingTeamMessage(message) && !(message.status === 'accepted' && message.acceptance === undefined))
      || messages.some(receipt => team.messages.some(message => message.id === receipt.id))) return false;
  }
  const grants = team.resourceGrants;
  if (grants !== undefined && (!Array.isArray(grants) || grants.length > 1024 || new Set(grants.map(grant => grant?.resourceId)).size !== grants.length
    || !grants.every(grant => grant && Object.keys(grant).every(key => ['resourceId', 'memberIds'].includes(key))
      && team.resourceUploads?.some(upload => upload.resource.resourceId === grant.resourceId)
      && Array.isArray(grant.memberIds) && grant.memberIds.length > 0 && grant.memberIds.length <= team.members.length
      && new Set(grant.memberIds).size === grant.memberIds.length && grant.memberIds.every(id => team.members.some(member => member.id === id))))) return false;
  return true;
}

export function replayTeamDelivery(team: SavedTeam, id: string, input: { to: string; text: string; resources?: string[] }): TeamMessage | undefined {
  const receipt = team.deliveryReceipts?.find(receipt => receipt.id === id);
  if (!receipt) return;
  if (receipt.fingerprint !== deliveryFingerprint(input)) throw new Error('Message identity has different input.');
  const { fingerprint: _hash, settledAt: _time, ...result } = receipt;
  return { ...result, text: input.text, ...(input.resources?.length ? { resources: input.resources.map(id => {
    const upload = team.resourceUploads?.find(upload => upload.resource.resourceId === id);
    if (!upload) throw new Error('Message resource is unavailable.');
    return upload.resource;
  }) } : {}) };
}

export function assertTeamQueueCapacity(team: Team, message: TeamMessage): void {
  if (team.messages.length >= 200 || teamMessageBudgetBytes({ ...team, messages: [...team.messages, message] }) > 128 * 1024) {
    throw new Error('Team communication capacity reached. Wait for pending deliveries to settle.');
  }
}
