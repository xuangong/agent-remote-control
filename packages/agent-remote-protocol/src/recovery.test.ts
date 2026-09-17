import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { decodeServerMessage } from './codec.js';
import { AgentRuntimeInfo } from './snapshot.js';

describe('native runtime recovery contracts', () => {
  it('round-trips strict connection state and interaction invalidation messages', () => {
    const runtimeInfo = {
      providerId: 'codex',
      sessionId: 'thread-one',
      status: 'running',
      connection: {
        state: 'reconnecting',
        reason: 'transport_closed',
        attempt: 2,
        nextRetryAt: 1_797_530_400_000,
      },
    } as const;
    const invalidated = {
      protocolVersion: '1.4.0',
      type: 'interaction_invalidated',
      payload: {
        agentId: 'agent-one',
        requestId: 'approval-one',
        reason: 'connection_replaced',
        turnId: 'turn-one',
      },
    } as const;

    expect(Value.Check(AgentRuntimeInfo, runtimeInfo)).toBe(true);
    expect(decodeServerMessage(JSON.stringify(invalidated))).toEqual({ status: 'ok', value: invalidated });
    expect(Value.Check(AgentRuntimeInfo, {
      ...runtimeInfo,
      connection: { ...runtimeInfo.connection, nativeError: 'private detail' },
    })).toBe(false);
    expect(decodeServerMessage(JSON.stringify({
      ...invalidated,
      payload: { ...invalidated.payload, response: { kind: 'plan_approval', action: 'reject' } },
    })).status).toBe('rejected');
  });

  it.each(['connected', 'reconnecting', 'restoring', 'unavailable'] as const)(
    'accepts %s while preserving providers that omit connection',
    (state) => {
      const runtimeInfo = { providerId: 'provider-neutral', sessionId: 'session', status: 'idle' } as const;
      expect(Value.Check(AgentRuntimeInfo, runtimeInfo)).toBe(true);
      expect(Value.Check(AgentRuntimeInfo, { ...runtimeInfo, connection: { state } })).toBe(true);
    },
  );
});
