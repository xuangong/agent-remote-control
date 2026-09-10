import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AgentRuntimeInfo } from './index.js';

const runtime = { providerId: 'codex', sessionId: 'parent', status: 'running' };
const child = {
  nativeSessionId: 'child', title: 'Review', role: 'reviewer', description: 'Review the patch',
  createdAt: '2026-09-10T00:00:00.000Z', parentTurnId: 'turn', parentCallId: 'spawn',
  status: 'waiting', observation: 'live',
};
it('carries native child relationships in the existing runtime snapshot', () => {
  expect(Value.Check(AgentRuntimeInfo, { ...runtime, childSessions: [child] })).toBe(true);
  expect(Value.Check(AgentRuntimeInfo, runtime)).toBe(true);
  expect(Value.Check(AgentRuntimeInfo, { ...runtime, childSessions: [] })).toBe(true);
});
it('rejects invalid child identity, status and arbitrary native fields', () => {
  for (const patch of [{ nativeSessionId: '' }, { status: 'completed' }, { observation: 'assumed' }, { nativeParams: {} }]) {
    expect(Value.Check(AgentRuntimeInfo, { ...runtime, childSessions: [{ ...child, ...patch }] })).toBe(false);
  }
});
