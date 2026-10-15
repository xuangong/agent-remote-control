import { createHash } from 'node:crypto';
import { TEAM_DELIVERY_RECEIPT_LIMIT, isTeam, type Team, type TeamMessage } from '@orchardworks/agent-remote-protocol';

type DeliveryReceipt = Omit<TeamMessage, 'text' | 'resources'> & { fingerprint: string; settledAt: number };
type ResourceGrant = { resourceId: string; memberIds: string[] };

/** Relay-only evidence. Never included in the public Team catalog or Host poll. */
export interface SavedTeam extends Team {
  deliveryReceipts?: DeliveryReceipt[];
  resourceGrants?: ResourceGrant[];
}

const receiptLifetimeMs = 24 * 60 * 60 * 1000;
const receiptCount = TEAM_DELIVERY_RECEIPT_LIMIT;
const receiptBytes = 32 * 1024;
// Every native reference string can occupy six JSON bytes per code unit.
const recipientGrowthBytes = Buffer.byteLength(JSON.stringify({ resolvedTarget: { controllerId: '\u0000'.repeat(512), providerId: '\u0000'.repeat(512), nativeSessionId: '\u0000'.repeat(512) } })) - 1;
export const teamMessageBudgetBytes = (team: Team, reserveRecipients = false) => Buffer.byteLength(JSON.stringify(team.messages.map(({ resources: _resources, ...message }) => message)))
  + (reserveRecipients ? team.messages.filter(message => message.status === 'queued' && !message.resolvedTarget).length * recipientGrowthBytes : 0);

export function publicTeam(team: SavedTeam): Team {
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
export function trimTeamDeliveryReceipts(teams: SavedTeam[], maximumStateBytes: number): void {
  let excess = Buffer.byteLength(JSON.stringify(teams)) - maximumStateBytes;
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

export function validSavedTeam(value: unknown): value is SavedTeam {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const team = value as SavedTeam, visible = publicTeam(team);
  if (team.unresolvedReceipts !== undefined || !isTeam(visible) || !visible.members.every(member => member.creation !== 'ready' || !!member.nativeSessionId)) return false;
  const receipts = team.deliveryReceipts;
  if (receipts !== undefined) {
    if (!Array.isArray(receipts) || receipts.length > receiptCount || Buffer.byteLength(JSON.stringify(receipts)) > receiptBytes) return false;
    if (!receipts.every(receipt => receipt && typeof receipt === 'object'
      && Object.keys(receipt).every(key => ['id', 'from', 'to', 'status', 'acceptance', 'createdAt', 'error', 'fingerprint', 'settledAt', 'resolvedTarget'].includes(key))
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
  if (team.messages.length >= 200 || teamMessageBudgetBytes({ ...team, messages: [...team.messages, message] }, true) > 128 * 1024) {
    throw new Error('Team communication capacity reached. Wait for pending deliveries to settle.');
  }
}
