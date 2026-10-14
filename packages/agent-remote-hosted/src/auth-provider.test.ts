import { expect, it } from 'vitest';
import { createAuthenticationProvider } from './auth-provider.js';
import { hostedAuthNamespace, resolveHostedAuth } from './hosted-auth.js';
import { createRelayState, emptyRelayState } from './state.js';

it('authorizes an admitted Google owner without browser sessions and denies a removed allowlist entry', async () => {
  const auth = resolveHostedAuth({ provider: 'google', origin: 'https://relay.example', secret: 'authority-fixture-secret-01234567890123456789', google: { clientId: 'client', clientSecret: 'secret', allowedEmails: ['owner@example.com'] } });
  const initial = emptyRelayState(auth); initial.googleIdentities = [{ subject: 'stable-google-sub', email: 'owner@example.com' }];
  const state = createRelayState(auth, { initial, async commit() {} }, () => {}, () => {});
  const provider = createAuthenticationProvider(auth, state);
  expect(state.read().sessions).toEqual([]);
  const status = await provider.userStatus('stable-google-sub');
  expect(status.status).toBe('active');
  if (status.status !== 'active') throw Error('missing authority');
  expect(status.validUntil).toBeGreaterThan(Date.now()); expect(status.validUntil).toBeLessThanOrEqual(Date.now() + 120_000);
  expect(await provider.userStatus('unadmitted-sub')).toEqual({ status: 'denied' });
  const removed = resolveHostedAuth({ ...auth, provider: 'google', google: { ...(auth.provider === 'google' ? auth.google : {}), clientId: 'client', clientSecret: 'secret', allowedEmails: ['different@example.com'] } });
  const replacement = createAuthenticationProvider(removed, state);
  expect(await replacement.userStatus('stable-google-sub')).toEqual({ status: 'denied' });
  expect(await replacement.renew({ provider: 'google', subject: 'stable-google-sub', namespace: hostedAuthNamespace(auth, 'stable-google-sub'), profile: { name: 'Owner', email: 'owner@example.com' }, authenticatedAt: Date.now(), expiresAt: Date.now() + 120_000, sessionExpiresAt: Date.now() + 3_600_000 })).toEqual({ status: 'denied' });
});
