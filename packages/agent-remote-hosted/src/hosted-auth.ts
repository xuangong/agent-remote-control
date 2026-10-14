import { createHash } from 'node:crypto';
import { validateGatewayOrigin, type GatewayAuthOptions } from './auth.js';

export interface GoogleAuthConfiguration {
  clientId: string;
  clientSecret: string;
  allowedEmails: readonly string[];
  /** Local browser lifetime, independent of the Google token and account session. Defaults to 12 hours. */
  sessionLifetimeMs?: number;
  /** Trusted operator configuration; never taken from a browser request or token. */
  endpoints?: { authorization: string; token: string; jwks: string };
}
export type HostedAuthOptions = (GatewayAuthOptions & { provider?: 'mainsite' | 'gateway' }) |
  { provider: 'google'; origin: string; secret: string; google: GoogleAuthConfiguration };
export type ResolvedHostedAuth = (GatewayAuthOptions & { provider: 'mainsite' }) |
  (GatewayAuthOptions & { provider: 'google'; google: GoogleAuthConfiguration & { sessionLifetimeMs: number; endpoints: NonNullable<GoogleAuthConfiguration['endpoints']> } });
export interface HostedAuthEnvironment {
  AGENT_REMOTE_AUTH_PROVIDER?: string;
  AGENT_REMOTE_RELAY_URL?: string;
  AGENT_REMOTE_ISSUER?: string;
  AGENT_REMOTE_SIGNING_SECRET?: string;
  AGENT_REMOTE_GOOGLE_CLIENT_ID?: string;
  AGENT_REMOTE_GOOGLE_CLIENT_SECRET?: string;
  AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS?: string;
}
export const googleIssuer = 'https://accounts.google.com';
export const googleSessionLifetimeMs = 12 * 60 * 60_000;
export const localAuthorityLifetimeMs = 120_000;
export function normalizeAllowedEmail(email: string): string { return email.trim().toLowerCase(); }
export function validAllowedEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 320 && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email);
}
export function resolveHostedAuth(options: HostedAuthOptions): ResolvedHostedAuth {
  const origin = validateGatewayOrigin(options.origin);
  if (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32) throw new Error('Relay signing secret must contain at least 32 bytes.');
  if (options.provider === undefined || options.provider === 'mainsite' || options.provider === 'gateway') return { provider: 'mainsite', origin, issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (options.provider !== 'google') throw new Error('Unsupported authentication provider.');
  const input = options.google;
  if (!input || !input.clientId?.trim() || input.clientId.length > 512 || !input.clientSecret?.trim() || input.clientSecret.length > 4096) throw new Error('Google client ID and client secret are required.');
  if (!Array.isArray(input.allowedEmails) || !input.allowedEmails.length || input.allowedEmails.length > 1024 || !input.allowedEmails.every(email => typeof email === 'string' && validAllowedEmail(normalizeAllowedEmail(email)))) throw new Error('Google requires an explicit allowlist of verified email addresses.');
  const allowedEmails = [...new Set(input.allowedEmails.map(normalizeAllowedEmail))];
  const sessionLifetimeMs = input.sessionLifetimeMs ?? googleSessionLifetimeMs;
  if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 60_000 || sessionLifetimeMs > 7 * 86_400_000) throw new Error('Google local session lifetime must be between one minute and seven days.');
  const endpoints = input.endpoints ?? { authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' };
  for (const endpoint of Object.values(endpoints)) {
    const url = new URL(endpoint); validateGatewayOrigin(url.origin);
    if (url.username || url.password || url.search || url.hash) throw new Error('Google endpoints must be trusted HTTPS URLs or loopback HTTP URLs without query parameters.');
  }
  return { provider: 'google', origin, issuer: googleIssuer, secret: options.secret, google: { clientId: input.clientId.trim(), clientSecret: input.clientSecret, allowedEmails, sessionLifetimeMs, endpoints: { ...endpoints } } };
}
export function hostedAuthFromEnv(env: HostedAuthEnvironment): ResolvedHostedAuth {
  const required = (name: keyof HostedAuthEnvironment) => { const value = env[name]; if (!value?.trim()) throw new Error(`${name} is required.`); return value; };
  const configuredProvider = env.AGENT_REMOTE_AUTH_PROVIDER ?? 'mainsite';
  const provider = configuredProvider === 'gateway' ? 'mainsite' : configuredProvider;
  if (provider !== 'mainsite' && provider !== 'google') throw new Error('AGENT_REMOTE_AUTH_PROVIDER must be google or mainsite.');
  const common = { origin: required('AGENT_REMOTE_RELAY_URL'), secret: required('AGENT_REMOTE_SIGNING_SECRET') };
  return resolveHostedAuth(provider === 'mainsite' ? { ...common, provider, issuer: required('AGENT_REMOTE_ISSUER') } : { ...common, provider, google: {
    clientId: required('AGENT_REMOTE_GOOGLE_CLIENT_ID'), clientSecret: required('AGENT_REMOTE_GOOGLE_CLIENT_SECRET'), allowedEmails: (env.AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS ?? '').split(',') } });
}
export function hostedAuthStateConfig(auth: HostedAuthOptions) {
  return auth.provider === 'google' ? { origin: auth.origin, issuer: googleIssuer, provider: 'google' as const, clientId: auth.google.clientId }
    : { origin: auth.origin, issuer: auth.issuer };
}
export function hostedAuthStorageIdentity(auth: HostedAuthOptions): string {
  return JSON.stringify(auth.provider === 'google' ? [auth.origin, googleIssuer, 'google', auth.google.clientId] : [auth.origin, auth.issuer]);
}
export function hostedAuthNamespace(auth: HostedAuthOptions, subject: string): string {
  return createHash('sha256').update(JSON.stringify(auth.provider === 'google' ? ['google', googleIssuer, auth.google.clientId, subject] : [auth.issuer, subject])).digest('hex');
}
export function hostedAuthMetadata(auth: HostedAuthOptions) {
  return { provider: auth.provider === 'google' ? 'google' : 'mainsite', capabilities: { hostOnlyPairing: true, gatewaySetup: auth.provider !== 'google', gatewayControl: auth.provider !== 'google' } };
}
