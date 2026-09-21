import { isPairingPurpose, type PairingPurpose } from '@agent-remote-controller/agent-remote-protocol';

export interface SavedPairingKey {
  id: string; purpose: PairingPurpose; createdAt: number; expiresAt: number;
  usedAt?: number; revokedAt?: number; hostId?: string; hostName?: string;
}
export const MAX_PAIRING_HISTORY = 512;
export function pairingStatus(item: SavedPairingKey, now: number): 'unused' | 'used' | 'obsolete' | 'revoked' {
  return item.usedAt !== undefined ? 'used' : item.revokedAt !== undefined ? 'revoked' : item.expiresAt <= now ? 'obsolete' : 'unused';
}
export function visiblePairing(item: SavedPairingKey, now: number) {
  return { id: item.id, purpose: item.purpose, createdAt: new Date(item.createdAt).toISOString(), expiresAt: new Date(item.expiresAt).toISOString(),
    status: pairingStatus(item, now), ...(item.usedAt === undefined ? {} : { usedAt: new Date(item.usedAt).toISOString(), hostId: item.hostId, hostName: item.hostName }),
    ...(item.revokedAt === undefined ? {} : { revokedAt: new Date(item.revokedAt).toISOString() }) };
}
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
export function validPairingHistory(value: unknown): value is SavedPairingKey[] {
  return Array.isArray(value) && value.length <= MAX_PAIRING_HISTORY && value.every(item => item && typeof item === 'object'
    && text(item.id, 128) && isPairingPurpose(item.purpose) && time(item.createdAt) && time(item.expiresAt) && item.expiresAt >= item.createdAt
    && (item.usedAt === undefined ? item.hostId === undefined && item.hostName === undefined : time(item.usedAt) && item.usedAt >= item.createdAt && text(item.hostId, 512) && text(item.hostName, 512))
    && (item.revokedAt === undefined || item.usedAt === undefined && time(item.revokedAt) && item.revokedAt >= item.createdAt))
    && new Set(value.map(item => item.id)).size === value.length;
}
