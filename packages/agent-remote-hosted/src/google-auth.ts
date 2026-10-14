import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { gatewayCookieName, readGatewayCookie, type GoogleGrant } from './auth.js';
import { hostedAuthNamespace, localAuthorityLifetimeMs, normalizeAllowedEmail, type ResolvedHostedAuth } from './hosted-auth.js';
import { readRequestBytes } from './request.js';
import { browserIdentity } from './browser-devices.js';
import type { LoginChallenge, RelayState } from './state.js';

type GoogleAuth = Extract<ResolvedHostedAuth, { provider: 'google' }>;
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function createGoogleLogin(auth: GoogleAuth, state: RelayState) {
  const keys = createRemoteJWKSet(new URL(auth.google.endpoints.jwks), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    [customFetch]: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'manual' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Google signing keys are unavailable.'); }
      return new Response(new TextDecoder().decode(await readRequestBytes(response, 65_536)), { status: response.status, headers: response.headers });
    } });
  const allowed = new Set(auth.google.allowedEmails);
  const browserIdentityReader = browserIdentity(auth);
  return {
    async begin(request: Request, returnPath: string, hostId: string | undefined, reauthenticate: boolean): Promise<Response> {
      const id = opaque(), browser = opaque(), verifier = opaque(), nonce = opaque();
      const browserId = browserIdentityReader.read(request);
      const added = await state.mutate(draft => {
        draft.loginChallenges = draft.loginChallenges.filter(([, challenge]) => challenge.expiresAt > Date.now());
        if (draft.loginChallenges.length >= 4096) return false;
        draft.loginChallenges.push([id, { expiresAt: Date.now() + 300_000, returnPath, ...(hostId ? { hostId } : {}), google: { verifier, nonce, browserHash: digest(browser), ...(browserId ? { browserId } : {}) } }]);
        return true;
      });
      if (!added) return new Response('Too many pending sign-ins.', { status: 429 });
      const destination = new URL(auth.google.endpoints.authorization);
      const parameters = { client_id: auth.google.clientId, redirect_uri: auth.origin + '/auth/callback', response_type: 'code', scope: 'openid email profile', state: id, nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(reauthenticate ? { prompt: 'select_account' } : {}) };
      for (const [name, value] of Object.entries(parameters)) destination.searchParams.set(name, value);
      // The cross-site, top-level OAuth callback needs Lax; access cookies remain Strict.
      return new Response(null, { status: 303, headers: { location: destination.href,
        'set-cookie': `${gatewayCookieName(auth.origin, 'login')}=${browser}; Path=/; HttpOnly; SameSite=Lax${auth.origin.startsWith('https:') ? '; Secure' : ''}; Max-Age=300` } });
    },
    async callback(request: Request): Promise<{ status: 'active'; grant: GoogleGrant; pending: LoginChallenge } | { status: 'denied' | 'unavailable' | 'capacity'; returnPath?: string }> {
      const url = new URL(request.url), id = url.searchParams.get('state'), code = url.searchParams.get('code');
      const browser = readGatewayCookie(request, gatewayCookieName(auth.origin, 'login'));
      if (!validOpaque(id) || !validOpaque(browser) || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) return { status: 'denied' };
      // Consume durably before contacting the provider, so concurrent callbacks and restarts cannot replay the code.
      const pending = await state.mutate(draft => {
        const entry = draft.loginChallenges.find(([key, value]) => key === id && value.expiresAt > Date.now() && value.google?.browserHash === digest(browser));
        if (!entry) return undefined;
        draft.loginChallenges = draft.loginChallenges.filter(([key]) => key !== id); return entry[1];
      });
      const failure = (status: 'denied' | 'unavailable' | 'capacity') => ({ status, ...(pending ? { returnPath: pending.returnPath } : {}) });
      if (!pending?.google || !code || code.length > 4096 || url.searchParams.has('error')) return failure('denied');
      let token: string;
      try {
        const response = await fetch(auth.google.endpoints.token, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: auth.google.clientId, client_secret: auth.google.clientSecret, grant_type: 'authorization_code', redirect_uri: auth.origin + '/auth/callback', code, code_verifier: pending.google.verifier }) });
        if (!response.ok) { await response.body?.cancel(); return failure(response.status === 400 || response.status === 401 ? 'denied' : 'unavailable'); }
        const value: unknown = JSON.parse(new TextDecoder().decode(await readRequestBytes(response, 32_768)));
        if (!value || typeof value !== 'object' || !('id_token' in value) || typeof value.id_token !== 'string' || value.id_token.length > 16_384) return failure('denied');
        token = value.id_token;
      } catch { return failure('unavailable'); }
      let identity: { subject: string; email: string; name: string };
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: auth.google.clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'], maxTokenAge: 600, clockTolerance: 0 });
        if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || payload.nonce !== pending.google.nonce || payload.email_verified !== true || typeof payload.email !== 'string' ||
          payload.azp !== undefined && payload.azp !== auth.google.clientId || Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== auth.google.clientId) return failure('denied');
        const email = normalizeAllowedEmail(payload.email);
        if (!allowed.has(email)) return failure('denied');
        const name = typeof payload.name === 'string' && payload.name.trim() && payload.name.length <= 512 ? payload.name : email;
        identity = { subject: payload.sub, email, name };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        return failure(code === 'ERR_JWKS_TIMEOUT' || !code ? 'unavailable' : 'denied');
      }
      const admitted = await state.mutate(draft => {
        const identities = draft.googleIdentities ??= [];
        const existing = identities.find(value => value.subject === identity.subject);
        if (existing) existing.email = identity.email;
        else { if (identities.length >= 1024) return false; identities.push({ subject: identity.subject, email: identity.email }); }
        return true;
      });
      if (!admitted) return failure('capacity');
      const now = Date.now(), sessionExpiresAt = now + auth.google.sessionLifetimeMs;
      return { status: 'active', pending, grant: { provider: 'google', subject: identity.subject, namespace: hostedAuthNamespace(auth, identity.subject), profile: { name: identity.name, email: identity.email },
        // This is a new locally verified sign-in, not proof of a new Google password challenge.
        authenticatedAt: now, sessionExpiresAt, expiresAt: Math.min(sessionExpiresAt, now + localAuthorityLifetimeMs) } };
    },
  };
}
