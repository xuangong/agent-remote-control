import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createOperationCache } from '@orchardworks/agent-remote-relay';
import type { AgentSession, AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-boundary-'));
  const contexts = new SessionSuccessionContextStore(root); await contexts.ready;
  const cache = createOperationCache();
  const boundary = new SessionSuccessionBoundary(contexts, () => {}, () => undefined, cache);
  return { cache, boundary, close: async () => { await cache.close(); await rm(root, { recursive: true, force: true }); } };
};

test('ordinary admission and source reservation exclude each other synchronously', async () => {
  const { boundary, close } = await fixture();
  try {
    const release = boundary.admit([ref('A')], 'operation');
    expect(() => boundary.reserve('handoff', ref('A'))).toThrow(); release();
    boundary.reserve('handoff', ref('A'));
    expect(() => boundary.admit([ref('A')], 'other')).toThrow();
    expect(() => boundary.reserve('different', ref('A'))).toThrow();
    const unrelated = boundary.admit([ref('C')], 'unrelated'); unrelated();
    boundary.releaseReservation('handoff'); boundary.admit([ref('A')], 'after')();
  } finally { await close(); }
}, 10000);

test('candidate registration fences immediately, reports admitted conflict and releases with cancellation', async () => {
  const { boundary, close } = await fixture();
  try {
    boundary.reserve('handoff', ref('A'));
    const release = boundary.admit([ref('B')], 'existing');
    expect(boundary.registerCandidate('handoff', ref('B'))).toEqual({ conflict: true });
    expect(() => boundary.admit([ref('B')], 'new')).toThrow();
    expect(() => boundary.assertCommit('handoff')).toThrow(); release();
    boundary.assertCommit('handoff'); boundary.releaseReservation('handoff');
    expect(boundary.registerCandidate('handoff', ref('B'))).toEqual({ conflict: false });
    boundary.admit([ref('A'), ref('B')], 'after')();
  } finally { await close(); }
}, 10000);

test.each([undefined, 'queued', 'started', 'handled'] as const)('direct native input retains only unresolved queue disposition: %s', async disposition => {
  const { boundary, close } = await fixture();
  const session = boundary.wrap(ref('A'), { sendMessage: async () => disposition ? { disposition } as AgentInputAcceptance : undefined, cancel: async () => {} } as unknown as AgentSession);
  try {
    await session.sendMessage('hello');
    if (disposition === 'started' || disposition === 'handled') {
      boundary.reserve('handoff', ref('A')); boundary.releaseReservation('handoff');
    } else expect(() => boundary.reserve('handoff', ref('A'))).toThrow();
    await boundary.wrap(ref('C'), { cancel: async () => {} } as unknown as AgentSession).cancel!();
    boundary.reserve('non-input', ref('C')); boundary.releaseReservation('non-input');
  } finally { await close(); }
}, 10000);

test('overlapping candidate reservations cannot commit until the conflicting intent is terminal', async () => {
  const { boundary, close } = await fixture();
  try {
    boundary.reserve('first', ref('A')); boundary.registerCandidate('first', ref('B'));
    boundary.reserve('second', ref('C'));
    expect(boundary.registerCandidate('second', ref('B'))).toEqual({ conflict: true });
    expect(() => boundary.assertCommit('first')).toThrow();
    boundary.releaseReservation('second'); expect(() => boundary.assertCommit('first')).not.toThrow();
  } finally { await close(); }
}, 10000);
