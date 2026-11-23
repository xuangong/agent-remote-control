import { createHash } from 'node:crypto';
import { TEAM_DELIVERY_RECEIPT_LIMIT, isTeam, type Team, type TeamMessage } from '@orchardworks/agent-remote-protocol';
import { plain } from './drafts.js';

type DeliveryReceipt = Omit<TeamMessage, 'text'> & { fingerprint: string; settledAt: number };

/** Stored role anchors and Relay-only evidence, without client projection evidence. */
export interface SavedTeam extends Omit<Team, 'unresolvedReceipts'> {
  unresolvedReceipts?: never;
  deliveryReceipts?: DeliveryReceipt[];
}

/** Teams an account may hold. Each is stored as its own record, and a commit encodes only the Teams it changed. */
export const ACCOUNT_TEAM_LIMIT = 1024;
/**
 * Bytes of one Team's record. Its parts have their own bounds (128 KiB of message input, 64 KiB of a support group,
 * 32 KiB of receipts); this one bounds the rest, such as delivery evidence, as the account's Team state did
 * before each Team had its own record, so no Team has less room than it had then.
 */
export const TEAM_RECORD_BYTES = 2 * 1024 * 1024;
const receiptLifetimeMs = 24 * 60 * 60 * 1000;
const receiptCount = TEAM_DELIVERY_RECEIPT_LIMIT;
const receiptBytes = 32 * 1024;
// Input capacity stays stable while delivery evidence grows. Recipients,
// and settlement metadata remain bounded by their schemas and the full state limit.
export const teamMessageBudgetBytes = (team: Team) => Buffer.byteLength(JSON.stringify(team.messages.map(({ id, from, to, text, createdAt }) => ({ id, from, to, text, createdAt }))));

export function stripPrivateTeamEvidence(team: SavedTeam): Omit<Team, 'unresolvedReceipts'> {
  const { deliveryReceipts: _receipts, ...value } = team;
  return value;
}

export function unresolvedTeamDelivery(message: Pick<TeamMessage, 'status' | 'acceptance'>): boolean {
  return ['dispatching', 'unknown'].includes(message.status) || message.status === 'accepted' && !['started', 'handled'].includes(message.acceptance ?? '');
}

export function pendingTeamMessage(message: TeamMessage): boolean {
  return message.status === 'queued' || unresolvedTeamDelivery(message);
}

/** The third element is the attachment list receipts of earlier builds hashed; it stays so their stored fingerprints still match. */
export function deliveryFingerprint(input: { to: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify([input.to, input.text, []])).digest('hex');
}

/** Migrate old inline history and release settled bodies in the same durable commit. */
export function compactTeamDeliveries(team: SavedTeam, now: number): void {
  const receipts = new Map((team.deliveryReceipts ?? []).filter(receipt => unresolvedTeamDelivery(receipt) || receipt.settledAt + receiptLifetimeMs > now).map(receipt => [receipt.id, receipt]));
  const pending: TeamMessage[] = [];
  for (const message of team.messages) {
    if (pendingTeamMessage(message)) { pending.push(message); continue; }
    // A receipt keeps what proves the delivery; the chain was recorded on the member that took the message.
    const { text, chain: _chain, ...result } = message;
    receipts.set(message.id, { ...result, fingerprint: deliveryFingerprint({ to: message.to, text }), settledAt: now });
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

/**
 * Settled retry evidence is expendable; legacy unresolved effects remain authoritative. Drops the Team's oldest settled
 * receipts until it is within maximumBytes, or none is left to drop.
 */
export function trimTeamDeliveryReceipts(team: SavedTeam, maximumBytes: number, bytes = Buffer.byteLength(JSON.stringify(team))): void {
  let excess = bytes - maximumBytes;
  if (excess <= 0) return;
  // Read the plain receipts: team may be a draft.
  const receipts = plain(team).deliveryReceipts ?? [], dropped = new Set<DeliveryReceipt>();
  for (const receipt of receipts.filter(receipt => !unresolvedTeamDelivery(receipt)).sort((a, b) => a.settledAt - b.settledAt)) {
    if (excess <= 0) break;
    dropped.add(receipt); excess -= Buffer.byteLength(JSON.stringify(receipt)) + 1;
  }
  if (!dropped.size) return;
  const kept = receipts.filter(receipt => !dropped.has(receipt));
  if (kept.length) team.deliveryReceipts = kept;
  else delete team.deliveryReceipts;
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
/** Buffer.byteLength(JSON.stringify(team)), measured once for a frozen Team. */
export const teamBytes = (team: SavedTeam) => frozenBytes(team);
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
      && Object.keys(receipt).every(key => ['id', 'from', 'to', 'status', 'acceptance', 'createdAt', 'error', 'fingerprint', 'settledAt', 'resolvedTarget'].includes(key))
      && typeof receipt.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(receipt.fingerprint)
      && Number.isSafeInteger(receipt.settledAt) && receipt.settledAt >= 0)) return false;
    // Older versions compacted accepted input without a native disposition. Keep that evidence unresolved.
    const messages = receipts.map(({ fingerprint: _hash, settledAt: _time, ...receipt }) => ({ ...receipt, text: 'receipt' }));
    if (!isTeam({ ...visible, messages }) || messages.some(message => pendingTeamMessage(message) && !(message.status === 'accepted' && message.acceptance === undefined))
      || messages.some(receipt => team.messages.some(message => message.id === receipt.id))) return false;
  }
  return true;
}

export function assertTeamQueueCapacity(team: Team, message: TeamMessage): void {
  if (team.messages.length >= 200 || teamMessageBudgetBytes({ ...team, messages: [...team.messages, message] }) > 128 * 1024) {
    throw new Error('Team communication capacity reached. Wait for pending deliveries to settle.');
  }
}
