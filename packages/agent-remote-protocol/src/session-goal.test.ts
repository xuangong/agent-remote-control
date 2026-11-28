import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { AgentRuntimeInfo, AgentSessionGoal } from './index.js';

const goal = { objective: 'all tests pass', status: 'active' as const, iterations: 2, tokensUsed: 1200, tokenBudget: 50000, timeUsedSeconds: 61,
  lastReason: 'two tests still fail', startedAt: 1_760_000_000_000, updatedAt: 1_760_000_060_000,
  actions: [{ kind: 'pause' as const, commandId: 'goal', args: 'pause' }, { kind: 'clear' as const, commandId: 'goal', args: 'clear' }] };
const runtime = { providerId: 'codex', sessionId: 'thread-1', status: 'idle' as const };

describe('the session goal of a runtime', () => {
  it('rides in runtimeInfo, and a runtime without one stays valid', () => {
    expect(Value.Check(AgentRuntimeInfo, { ...runtime, goal })).toBe(true);
    expect(Value.Check(AgentRuntimeInfo, runtime)).toBe(true);
    expect(Value.Check(AgentSessionGoal, { objective: 'ship it', status: 'complete' })).toBe(true);
  });

  it.each([
    ['an empty objective', { objective: '' }],
    ['an objective over 4,096 characters', { objective: 'x'.repeat(4097) }],
    ['an unknown status', { status: 'done' }],
    ['a negative count', { iterations: -1 }],
    ['a fractional token count', { tokensUsed: 1.5 }],
    ['a reason over 1,024 characters', { lastReason: 'x'.repeat(1025) }],
    ['an unknown action', { actions: [{ kind: 'edit', commandId: 'goal', args: '' }] }],
    ['an action without a command', { actions: [{ kind: 'clear', commandId: '', args: 'clear' }] }],
    ['a field it does not define', { origin: 'user' }],
  ])('refuses %s', (_name, patch) => {
    expect(Value.Check(AgentSessionGoal, { ...goal, ...patch })).toBe(false);
  });
});
