import { expect, it } from 'vitest';
import { hostedAuthFromEnv, hostedAuthNamespace, hostedAuthStateConfig, hostedAuthStorageIdentity, resolveHostedAuth } from './hosted-auth.js';

const common = { AGENT_REMOTE_RELAY_URL: 'https://relay.example', AGENT_REMOTE_SIGNING_SECRET: 'configuration-fixture-secret-01234567890123456789' };
it('keeps Gateway defaults, namespace, and storage context unchanged', () => {
  const auth = hostedAuthFromEnv({ ...common, AGENT_REMOTE_ISSUER: 'https://gateway.example' });
  expect(auth.provider).toBe('gateway');
  expect(hostedAuthStateConfig(auth)).toEqual({ origin: 'https://relay.example', issuer: 'https://gateway.example' });
  expect(hostedAuthStorageIdentity(auth)).toBe('["https://relay.example","https://gateway.example"]');
  expect(hostedAuthNamespace(auth, 'alice')).toBe('7c1c385902e0ae7f484f5274fbad49131a97fc0771fac9b71f56d093232f49cd');
});
it('resolves Google without a Gateway issuer and normalizes an explicit email allowlist', () => {
  const auth = hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'google', AGENT_REMOTE_GOOGLE_CLIENT_ID: 'client', AGENT_REMOTE_GOOGLE_CLIENT_SECRET: 'secret', AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS: ' Alice@Example.com , bob@example.com ' });
  expect(auth).toMatchObject({ provider: 'google', issuer: 'https://accounts.google.com', google: { allowedEmails: ['alice@example.com', 'bob@example.com'] } });
  expect(hostedAuthStateConfig(auth)).toMatchObject({ provider: 'google', clientId: 'client' });
  expect(hostedAuthNamespace(auth, 'alice')).not.toBe(hostedAuthNamespace({ origin: auth.origin, issuer: auth.issuer, secret: auth.secret }, 'alice'));
});
it.each(['', '   ', '*', '*@example.com', 'not-an-email'])('rejects unsafe Google allowlist %j', allowedEmails => {
  expect(() => hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'google', AGENT_REMOTE_GOOGLE_CLIENT_ID: 'client', AGENT_REMOTE_GOOGLE_CLIENT_SECRET: 'secret', AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS: allowedEmails })).toThrow(/email/i);
});
it('rejects unknown providers, missing secrets, and unbounded local session lifetimes', () => {
  expect(() => hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'other' })).toThrow(/provider/i);
  expect(() => hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'google' })).toThrow();
  expect(() => resolveHostedAuth({ provider: 'google', origin: common.AGENT_REMOTE_RELAY_URL, secret: common.AGENT_REMOTE_SIGNING_SECRET, google: { clientId: 'client', clientSecret: 'secret', allowedEmails: ['a@example.com'], sessionLifetimeMs: Infinity } })).toThrow(/lifetime/i);
});
