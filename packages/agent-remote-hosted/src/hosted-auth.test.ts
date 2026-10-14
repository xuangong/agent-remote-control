import { expect, it } from 'vitest';
import { hostedAuthFromEnv, hostedAuthMetadata, hostedAuthNamespace, hostedAuthStateConfig, hostedAuthStorageIdentity, resolveHostedAuth } from './hosted-auth.js';

const common = { AGENT_REMOTE_RELAY_URL: 'https://relay.example', AGENT_REMOTE_SIGNING_SECRET: 'configuration-fixture-secret-01234567890123456789' };
it.each(['mainsite', 'gateway', undefined] as const)('resolves %s as main-site auth without changing existing identity or storage', provider => {
  const auth = hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: provider, AGENT_REMOTE_ISSUER: 'https://gateway.example' });
  expect(auth.provider).toBe('mainsite');
  expect(hostedAuthMetadata(auth)).toEqual({ provider: 'mainsite', capabilities: { hostOnlyPairing: true, gatewaySetup: true, gatewayControl: true } });
  expect(hostedAuthStateConfig(auth)).toEqual({ origin: 'https://relay.example', issuer: 'https://gateway.example' });
  expect(hostedAuthStorageIdentity(auth)).toBe('["https://relay.example","https://gateway.example"]');
  expect(hostedAuthNamespace(auth, 'alice')).toBe('7c1c385902e0ae7f484f5274fbad49131a97fc0771fac9b71f56d093232f49cd');
});
it.each(['mainsite', 'gateway', undefined] as const)('normalizes direct %s options and metadata to main-site auth', provider => {
  const options = { provider, origin: common.AGENT_REMOTE_RELAY_URL, issuer: 'https://main.example', secret: common.AGENT_REMOTE_SIGNING_SECRET };
  expect(resolveHostedAuth(options)).toMatchObject({ provider: 'mainsite', issuer: 'https://main.example' });
  expect(hostedAuthMetadata(options).provider).toBe('mainsite');
});
it('requires a main-site issuer and reports the public configuration choices', () => {
  expect(() => hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'mainsite' })).toThrow('AGENT_REMOTE_ISSUER is required.');
  expect(() => hostedAuthFromEnv({ ...common, AGENT_REMOTE_AUTH_PROVIDER: 'other' })).toThrow('AGENT_REMOTE_AUTH_PROVIDER must be google or mainsite.');
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
