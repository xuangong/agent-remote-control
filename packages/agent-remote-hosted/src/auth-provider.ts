import { authenticateGatewayRequest, type HostedGrant } from './auth.js';
import { queryGatewayAuthority, type AuthorityDiagnostic, type AuthorityResult } from './authority.js';
import { localAuthorityLifetimeMs, normalizeAllowedEmail, type ResolvedHostedAuth } from './hosted-auth.js';
import type { RelayState } from './state.js';

/** Provider authority, independent of opaque browser session and device management. */
export interface HostedAuthenticationProvider {
  persistent(grant: HostedGrant): boolean;
  legacy(request: Request): import('./auth.js').GatewayGrant | undefined;
  renew(grant: HostedGrant): Promise<AuthorityResult>;
  userStatus(subject: string, observe?: (diagnostic: AuthorityDiagnostic) => void): Promise<AuthorityResult>;
}
export function createAuthenticationProvider(auth: ResolvedHostedAuth, state: RelayState): HostedAuthenticationProvider {
  if (auth.provider === 'mainsite') return {
    persistent: grant => grant.provider !== 'google' && !!grant.continuation,
    legacy: request => authenticateGatewayRequest(request, auth),
    renew: grant => grant.provider !== 'google' && grant.continuation ? queryGatewayAuthority(auth, 'renew', { continuation: grant.continuation }) : Promise.resolve({ status: 'denied' }),
    userStatus: (subject, observe) => queryGatewayAuthority(auth, 'user-status', { subject }, observe),
  };
  const allowed = new Set(auth.google.allowedEmails);
  const admitted = (subject: string) => {
    const identity = state.read().googleIdentities?.find(value => value.subject === subject);
    return identity && allowed.has(normalizeAllowedEmail(identity.email)) ? identity : undefined;
  };
  return {
    persistent: () => true,
    legacy: () => undefined,
    async renew(grant) {
      const identity = admitted(grant.subject);
      if (!identity || grant.provider !== 'google' || !grant.sessionExpiresAt || grant.sessionExpiresAt <= Date.now()) return { status: 'denied' };
      return { status: 'active', subject: grant.subject, profile: { name: grant.profile?.name ?? identity.email, email: identity.email }, authenticatedAt: grant.authenticatedAt,
        expiresAt: grant.sessionExpiresAt, validUntil: Math.min(grant.sessionExpiresAt, Date.now() + localAuthorityLifetimeMs) };
    },
    async userStatus(subject, observe) {
      const active = !!admitted(subject);
      try { observe?.({ reason: active ? 'authority_active' : 'access_revoked', durationMs: 0 }); } catch { /* Diagnostics cannot alter authorization. */ }
      return active ? { status: 'active', subject, validUntil: Date.now() + localAuthorityLifetimeMs } : { status: 'denied' };
    },
  };
}
