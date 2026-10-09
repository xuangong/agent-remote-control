import { describe, expect, it } from 'vitest';
import { reduceSessionState, sessionOperationAvailability, type SessionOperationKind } from './session-state.js';
import type { AgentSnapshotPayload } from './snapshot.js';
import { decodeAgentSnapshot, decodeAgentStreamMessage } from './codec.js';
import { BORGEE_AGENT_REMOTE_PROTOCOL_VERSION as protocolVersion } from './version.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'view', providerId: 'native', status: 'idle', createdAt: '2026-01-01', updatedAt: '2026-01-01', activeTurn: null, pendingInteractions: [],
  runtimeInfo: { providerId: 'native', sessionId: 'native-session', status: 'idle', connection: { state: 'connected' } },
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: true, cancel: true, planning: true, sessionSettings: true, commands: true,
    readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
});
const question = { kind: 'question' as const, requestId: 'q', questions: [{ questionId: 'choice', header: 'Confirm', prompt: 'Continue?', required: true, selection: 'single' as const, options: [{ value: 'yes', label: 'Yes' }], allowCustomText: false, allowDismiss: false }] };
const operations: SessionOperationKind[] = ['send_message', 'queue_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command', 'interaction_response'];

describe('current usage snapshots', () => {
  it('restores and replays cumulative runtime snapshots without summing them again', () => {
    const restored = decodeAgentSnapshot(JSON.stringify({ protocolVersion, type: 'agent_snapshot', payload: {
      ...snapshot(), lastUsage: { tokenScope: 'runtime', totalTokens: 500, contextScope: 'current', contextWindowUsedTokens: 100, contextWindowMaxTokens: 200 },
    } }));
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') throw new Error('Expected restored runtime usage');
    let state = restored.value.payload;
    for (const type of ['usage_updated', 'turn_completed', 'usage_updated'] as const) {
      const decoded = decodeAgentStreamMessage(JSON.stringify({ protocolVersion, type: 'agent_stream', payload: {
        agentId: 'view', timestamp: '2026-10-09T00:00:00.000Z', event: { type, providerId: 'native', usage: { tokenScope: 'runtime', totalTokens: 700 } },
      } }));
      expect(decoded.status).toBe('ok');
      if (decoded.status !== 'ok') throw new Error('Expected recorded runtime usage');
      state = reduceSessionState(state, decoded.value.payload.event, decoded.value.payload.timestamp);
    }
    expect(state.lastUsage).toEqual({ tokenScope: 'runtime', totalTokens: 700,
      contextScope: 'current', contextWindowUsedTokens: 100, contextWindowMaxTokens: 200 });
    state = reduceSessionState(state, { type: 'usage_updated', usage: { tokenScope: 'runtime', totalTokens: 0 } }, 'reset');
    expect(state.lastUsage).toEqual({ tokenScope: 'runtime', totalTokens: 0,
      contextScope: 'current', contextWindowUsedTokens: 100, contextWindowMaxTokens: 200 });
  });

  it('retains explicit current context without requiring a token measurement', () => {
    const usage = { contextScope: 'current' as const, contextWindowUsedTokens: 0, contextWindowMaxTokens: 200 };
    const state = reduceSessionState(snapshot(), { type: 'usage_updated', usage }, 'context');
    expect(state.lastUsage).toEqual(usage);
    expect(reduceSessionState(state, { type: 'usage_updated', usage: { contextScope: 'current' } }, 'unknown').lastUsage)
      .toEqual({ contextScope: 'current' });
  });

  it('does not carry current-context semantics onto a subsequent legacy measurement', () => {
    const previous = { ...snapshot(), lastUsage: { tokenScope: 'session' as const, totalTokens: 100,
      contextScope: 'current' as const, contextWindowUsedTokens: 20, contextWindowMaxTokens: 200 } };
    const state = reduceSessionState(previous, { type: 'usage_updated', usage: { contextWindowUsedTokens: 5_000 } }, 'legacy');
    expect(state.lastUsage).toEqual({ tokenScope: 'session', totalTokens: 100, contextWindowUsedTokens: 5_000 });
  });

  const initial = () => reduceSessionState(snapshot(), { type: 'usage_updated', usage: {
    tokenScope: 'session', inputTokens: 100, cachedInputTokens: 50, cacheCreationInputTokens: 0,
    outputTokens: 20, totalTokens: 170, contextWindowUsedTokens: 120, contextWindowMaxTokens: 200,
  } }, 'first');

  it('replaces context independently from token counters and permits lower occupancy after compaction', () => {
    const previous = initial();
    const state = reduceSessionState(previous, { type: 'usage_updated', usage: {
      contextWindowUsedTokens: 30, contextWindowMaxTokens: 200,
    } }, 'compacted');
    expect(state.lastUsage).toEqual({ ...previous.lastUsage, contextWindowUsedTokens: 30 });
    expect(previous.lastUsage?.contextWindowUsedTokens).toBe(120);
  });

  it('replaces token snapshots without adding totals or carrying missing buckets from an earlier call', () => {
    const event = { type: 'usage_updated' as const, usage: { tokenScope: 'call' as const, totalTokens: 12 } };
    let state = reduceSessionState(initial(), event, 'call');
    state = reduceSessionState(state, event, 'repeat');
    expect(state.lastUsage).toEqual({ tokenScope: 'call', totalTokens: 12, contextWindowUsedTokens: 120, contextWindowMaxTokens: 200 });
    state = reduceSessionState(state, { type: 'usage_updated', usage: { tokenScope: 'call' } }, 'unknown-call');
    expect(state.lastUsage).toEqual({ tokenScope: 'call', contextWindowUsedTokens: 120, contextWindowMaxTokens: 200 });
  });

  it('treats undefined fields like omitted JSON properties and preserves the last snapshot on an empty update', () => {
    const previous = initial();
    for (const usage of [{}, { inputTokens: undefined, tokenScope: undefined, contextWindowUsedTokens: undefined }]) {
      expect(reduceSessionState(previous, { type: 'usage_updated', usage }, 'empty').lastUsage).toEqual(previous.lastUsage);
      const serialized = JSON.parse(JSON.stringify(usage));
      expect(reduceSessionState(previous, { type: 'usage_updated', usage: serialized }, 'wire').lastUsage).toEqual(previous.lastUsage);
    }
    expect(reduceSessionState(snapshot(), { type: 'usage_updated', usage: {} }, 'empty').lastUsage).toBeUndefined();
  });

  it('uses the same token replacement rule at turn completion and keeps legacy scope unknown', () => {
    const state = reduceSessionState(initial(), { type: 'turn_completed', usage: { inputTokens: 0, outputTokens: 0 } }, 'done');
    expect(state.lastUsage).toEqual({ inputTokens: 0, outputTokens: 0, contextWindowUsedTokens: 120, contextWindowMaxTokens: 200 });
  });

  it('does not combine context readings from different updates and preserves the independent legacy cost', () => {
    const state = reduceSessionState(initial(), { type: 'usage_updated', usage: { contextWindowUsedTokens: 0, totalCostUsd: 0 } }, 'partial');
    expect(state.lastUsage).toEqual({ tokenScope: 'session', inputTokens: 100, cachedInputTokens: 50,
      cacheCreationInputTokens: 0, outputTokens: 20, totalTokens: 170, contextWindowUsedTokens: 0, totalCostUsd: 0 });
  });
});

describe('session lifecycle', () => {
  it('retains native activity underneath a pending interaction across recovery', () => {
    let state = reduceSessionState(snapshot(), { type: 'runtime_updated', runtimeInfo: { ...snapshot().runtimeInfo, status: 'running' }, activeTurnId: 'turn' }, 'start');
    state = reduceSessionState(state, { type: 'interaction_requested', request: question }, 'question');
    expect(state.status).toBe('waiting');
    state = reduceSessionState(state, { type: 'runtime_updated', runtimeInfo: { ...state.runtimeInfo, status: 'running', connection: { state: 'restoring' } } }, 'lost');
    expect(state).toMatchObject({ status: 'waiting', activeTurn: { turnId: 'turn', startedAt: 'start' }, pendingInteractions: [question] });
    state = reduceSessionState(state, { type: 'runtime_updated', runtimeInfo: { ...state.runtimeInfo, connection: { state: 'connected' } } }, 'recovered');
    expect(sessionOperationAvailability(state, 'interaction_response', { interactionId: 'q' })).toEqual({ allowed: true });
    state = reduceSessionState(state, { type: 'interaction_resolved', requestId: 'q' }, 'resolved');
    expect(state).toMatchObject({ status: 'running', pendingInteractions: [], activeTurn: { turnId: 'turn' } });
    expect(sessionOperationAvailability(state, 'interaction_response', { interactionId: 'q' })).toMatchObject({ code: 'stale_interaction' });
  });

  it('applies authoritative turn completion without inventing completion from connection loss', () => {
    let state = reduceSessionState(snapshot(), { type: 'runtime_updated', runtimeInfo: { ...snapshot().runtimeInfo, status: 'running' }, activeTurnId: 'turn' }, 'start');
    state = reduceSessionState(state, { type: 'runtime_updated', runtimeInfo: { ...state.runtimeInfo, connection: { state: 'unavailable' } } }, 'lost');
    expect(state).toMatchObject({ status: 'running', activeTurn: { turnId: 'turn' } });
    state = reduceSessionState(state, { type: 'turn_completed', turnId: 'turn' }, 'complete');
    expect(state).toMatchObject({ status: 'running', activeTurn: null, runtimeInfo: { status: 'running', connection: { state: 'unavailable' } } });
    expect(sessionOperationAvailability(state, 'send_message')).toMatchObject({ code: 'native_runtime_unavailable' });
  });
});

describe('operation eligibility', () => {
  it.each(operations)('keeps synchronization, authority and native recovery independent for %s', operation => {
    const state = snapshot();
    expect(sessionOperationAvailability(state, operation)).toEqual({ allowed: true });
    expect(sessionOperationAvailability(state, operation, { synchronized: false })).toMatchObject({ code: 'session_not_ready' });
    expect(sessionOperationAvailability(state, operation, { control: 'read_only' })).toMatchObject({ code: 'session_read_only' });
    for (const connection of ['restoring', 'reconnecting', 'unavailable'] as const) {
      expect(sessionOperationAvailability({ ...state, runtimeInfo: { ...state.runtimeInfo, connection: { state: connection } } }, operation))
        .toMatchObject({ code: `native_runtime_${connection}` });
    }
  });
  it('allows input and cancellation during work but accepts setting intents while keeping planning idle-only', () => {
    const state = reduceSessionState(snapshot(), { type: 'turn_started', turnId: 'turn' }, 'start');
    for (const operation of ['send_message', 'queue_message', 'steer', 'cancel', 'execute_command', 'set_session_setting'] as const) {
      expect(sessionOperationAvailability(state, operation)).toEqual({ allowed: true });
    }
    for (const operation of ['set_planning'] as const) expect(sessionOperationAvailability(state, operation)).toMatchObject({ code: 'agent_busy' });
    expect(sessionOperationAvailability({ ...state, capabilities: { ...state.capabilities, queueMessage: false } }, 'queue_message')).toMatchObject({ code: 'unsupported_command' });
  });
});

describe('native execution authority', () => {
  const running = () => ({ ...snapshot(), status: 'running' as const, runtimeInfo: { ...snapshot().runtimeInfo, status: 'running' as const }, activeTurn: { turnId: 'current' } });
  it.each(['turn_completed', 'turn_canceled', 'turn_failed'] as const)('%s changes the turn but does not decide session execution', type => {
    const event = type === 'turn_failed' ? { type, turnId: 'current', error: 'attempt failed' }
      : type === 'turn_canceled' ? { type, turnId: 'current', reason: 'aborted' } : { type, turnId: 'current' };
    const state = reduceSessionState(running(), event, 'end');
    expect(state).toMatchObject({ status: 'running', runtimeInfo: { status: 'running' }, activeTurn: null });
  });
  it('does not manufacture native activity from a turn start', () => {
    const state = reduceSessionState(snapshot(), { type: 'turn_started', turnId: 'current' }, 'start');
    expect(state).toMatchObject({ status: 'idle', runtimeInfo: { status: 'idle' }, activeTurn: { turnId: 'current' } });
  });
  it.each(['turn_completed', 'turn_canceled', 'turn_failed'] as const)('does not retire a newer turn on an older %s', type => {
    const event = type === 'turn_failed' ? { type, turnId: 'old', error: 'old failure' }
      : type === 'turn_canceled' ? { type, turnId: 'old', reason: 'aborted' } : { type, turnId: 'old' };
    const state = reduceSessionState(running(), event, 'late');
    expect(state.activeTurn?.turnId).toBe('current');
    expect(state.lastError).toBeUndefined();
  });
  it('does not guess native idle when the last interaction disappears', () => {
    let state = { ...snapshot(), status: 'waiting' as const, runtimeInfo: { ...snapshot().runtimeInfo, status: 'waiting' as const } };
    state = reduceSessionState(state, { type: 'interaction_requested', request: question }, 'request') as typeof state;
    state = reduceSessionState(state, { type: 'interaction_invalidated', requestId: 'q' }, 'invalidated') as typeof state;
    expect(state.status).toBe('waiting');
  });
});
