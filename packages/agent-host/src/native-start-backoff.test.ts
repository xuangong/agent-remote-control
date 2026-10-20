import { expect, it } from 'vitest';
import { createNativeStartBackoff, nativeStartTarget } from './native-start-backoff.js';

const failure = (code: string, status = 503) => ({ status, body: JSON.stringify({ code, error: 'failed' }) });
const attach = (body: Record<string, unknown>, path = '/remote/attach') => nativeStartTarget(path, 'POST', JSON.stringify(body))!;

it('identifies attach targets by provider, parent and native session', () => {
  expect(nativeStartTarget('/remote/catalog', 'GET', undefined)).toBeUndefined();
  expect(nativeStartTarget('/remote/attach', 'POST', 'not json')).toBeUndefined();
  expect(attach({ providerId: 'codex', nativeSessionId: 'a' }).key).not.toBe(attach({ providerId: 'claude', nativeSessionId: 'a' }).key);
  expect(attach({ providerId: 'codex', nativeSessionId: 'a', parentNativeSessionId: 'p' }, '/remote/child/attach').key)
    .not.toBe(attach({ providerId: 'codex', nativeSessionId: 'a' }).key);
  expect(attach({ providerId: 'codex', nativeSessionId: 'a', takeOver: 'generation' }).takeOver).toBe(true);
});

it('doubles the wait after each native start failure up to a minute and clears it on success', () => {
  let now = 0;
  const backoff = createNativeStartBackoff(() => now);
  const target = attach({ providerId: 'claude', nativeSessionId: 'a' });
  const waits: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    backoff.settle(target, failure('session_attach_failed'));
    const started = now;
    while (backoff.blocked(target)) now += 1_000;
    waits.push(now - started);
  }
  expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  backoff.settle(target, failure('native_resume_timeout'));
  expect(backoff.blocked(target)).toEqual(failure('native_resume_timeout'));
  backoff.settle(target, { status: 200, body: '{}' });
  expect(backoff.blocked(target)).toBeUndefined();
});

it('lets an explicit takeover try immediately and does not back off non-native refusals', () => {
  const backoff = createNativeStartBackoff(() => 0);
  const target = attach({ providerId: 'claude', nativeSessionId: 'a' });
  backoff.settle(target, failure('session_attach_failed'));
  expect(backoff.blocked({ ...target, takeOver: true })).toBeUndefined();
  const other = attach({ providerId: 'claude', nativeSessionId: 'b' });
  for (const result of [failure('native_session_owned', 409), failure('host_closed'), failure('controller_updating'), failure('operation_outcome_unknown')]) {
    backoff.settle(other, result);
    expect(backoff.blocked(other)).toBeUndefined();
  }
});
