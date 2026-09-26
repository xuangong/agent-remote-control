import { describe, expect, it } from 'vitest';
import { reduceSessionState, sessionOperationAvailability, type SessionOperationKind } from './session-state.js';
import type { AgentSnapshotPayload } from './snapshot.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'view', providerId: 'native', status: 'idle', createdAt: '2026-01-01', updatedAt: '2026-01-01', activeTurn: null, pendingInteractions: [],
  runtimeInfo: { providerId: 'native', status: 'idle', connection: { state: 'connected' } },
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: true, cancel: true, planning: true, sessionSettings: true, commands: true,
    readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
});
const question = { kind: 'question' as const, requestId: 'q', questions: [{ questionId: 'choice', header: 'Confirm', prompt: 'Continue?', required: true, selection: 'single' as const, options: [{ value: 'yes', label: 'Yes' }], allowCustomText: false, allowDismiss: false }] };
const operations: SessionOperationKind[] = ['send_message', 'queue_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command', 'interaction_response'];

describe('session lifecycle', () => {
  it('retains native activity underneath a pending interaction across recovery', () => {
    let state = reduceSessionState(snapshot(), { type: 'turn_started', turnId: 'turn' }, 'start');
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
    let state = reduceSessionState(snapshot(), { type: 'turn_started', turnId: 'turn' }, 'start');
    state = reduceSessionState(state, { type: 'runtime_updated', runtimeInfo: { ...state.runtimeInfo, connection: { state: 'unavailable' } } }, 'lost');
    expect(state).toMatchObject({ status: 'running', activeTurn: { turnId: 'turn' } });
    state = reduceSessionState(state, { type: 'turn_completed', turnId: 'turn' }, 'complete');
    expect(state).toMatchObject({ status: 'idle', activeTurn: null, runtimeInfo: { status: 'idle', connection: { state: 'unavailable' } } });
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
  it('allows input and cancellation during work but reserves configuration for idle sessions', () => {
    const state = reduceSessionState(snapshot(), { type: 'turn_started', turnId: 'turn' }, 'start');
    for (const operation of ['send_message', 'queue_message', 'steer', 'cancel', 'execute_command'] as const) {
      expect(sessionOperationAvailability(state, operation)).toEqual({ allowed: true });
    }
    for (const operation of ['set_planning', 'set_session_setting'] as const) expect(sessionOperationAvailability(state, operation)).toMatchObject({ code: 'agent_busy' });
    expect(sessionOperationAvailability({ ...state, capabilities: { ...state.capabilities, queueMessage: false } }, 'queue_message')).toMatchObject({ code: 'unsupported_command' });
  });
});
