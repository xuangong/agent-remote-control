import { createHash } from 'node:crypto';

export class SharingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface Grant { hostId: string; subject: string; label: string; sessionLimit: number; revoked: boolean }
interface Reservation { key: string; hostId: string; subject: string; fingerprint: string; nativeRequestId: string; agentId?: string }
export interface HostSharingState { grants: Grant[]; reservations: Reservation[] }
export class HostSharing {
  private readonly grants: Grant[];
  private readonly reservations: Map<string, Reservation>;
  constructor(state: HostSharingState | undefined, private readonly changed: () => void) {
    this.grants = structuredClone(state?.grants ?? []);
    this.reservations = new Map((state?.reservations ?? []).map(value => [value.key, { ...value }]));
  }
  snapshot(): HostSharingState { return { grants: structuredClone(this.grants), reservations: [...this.reservations.values()].map(value => ({ ...value })) }; }
  allowed(hostId: string, subject: string): boolean { return this.grants.some(value => value.hostId === hostId && value.subject === subject && !value.revoked); }
  quota(hostId: string, subject: string) {
    const grant = this.grants.find(value => value.hostId === hostId && value.subject === subject);
    return { limit: grant?.sessionLimit ?? 0, used: [...this.reservations.values()].filter(value => value.hostId === hostId && value.subject === subject).length };
  }
  list(hostId: string) { return this.grants.filter(value => value.hostId === hostId).map(({ hostId: _hostId, ...value }) => ({ ...value, used: this.quota(hostId, value.subject).used })); }
  set(hostId: string, subject: string, label: string, sessionLimit: number) {
    if (!subject || subject.length > 256 || !label || label.length > 320 || !Number.isSafeInteger(sessionLimit) || sessionLimit < 0 || sessionLimit > 10000) {
      throw new SharingError(400, 'invalid_share', 'A recipient and a session limit from 0 to 10000 are required.');
    }
    let grant = this.grants.find(value => value.hostId === hostId && value.subject === subject);
    if (!grant) {
      if (this.grants.length >= 4096) throw new SharingError(429, 'share_capacity', 'Host share capacity reached.');
      grant = { hostId, subject, label, sessionLimit, revoked: false }; this.grants.push(grant);
    } else Object.assign(grant, { label, sessionLimit, revoked: false });
    this.changed();
  }
  revoke(hostId: string, subject: string) {
    const grant = this.grants.find(value => value.hostId === hostId && value.subject === subject);
    if (!grant) throw new SharingError(404, 'share_not_found', 'Host share is unavailable.');
    grant.revoked = true; this.changed();
  }
  reserve(hostId: string, subject: string, providerId: string, requestId: string, fingerprint: string) {
    if (!this.allowed(hostId, subject)) throw new SharingError(403, 'host_forbidden', 'Host access is unavailable.');
    const key = JSON.stringify([hostId, subject, providerId, requestId]);
    const previous = this.reservations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new SharingError(409, 'request_conflict', 'This creation request has different settings.');
      return { ...previous, fresh: false };
    }
    const quota = this.quota(hostId, subject);
    if (quota.used >= quota.limit) throw new SharingError(409, 'session_quota_exceeded', 'Session creation quota reached. Continue an existing session or ask the Host owner to increase your limit.');
    if (this.reservations.size >= 10000) throw new SharingError(429, 'quota_ledger_full', 'The session creation ledger is full.');
    const value: Reservation = { key, hostId, subject, fingerprint, nativeRequestId: `shared:${createHash('sha256').update(key).digest('hex')}` };
    this.reservations.set(key, value);
    this.changed();
    return { ...value, fresh: true };
  }
  complete(key: string, agentId: string) { const entry = this.reservations.get(key); if (entry) { entry.agentId = agentId; this.changed(); } }
  release(key: string) { this.reservations.delete(key); this.changed(); }
}
