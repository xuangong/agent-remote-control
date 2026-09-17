import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AgentRuntimeInfo, decodeClientMessage, PROTOCOL_VERSION } from './index.js';

const setting = { id: 'model', category: 'model', label: 'Model', value: 'native-model', options: [{ value: 'native-model', label: 'Native model' }], mutable: true, scope: 'session' };

describe('session settings contract', () => {
  it('carries provider choices and their native scope in runtime state', () => {
    expect(Value.Check(AgentRuntimeInfo, { providerId: 'codex', sessionId: 'thread', status: 'idle', settings: [setting] })).toBe(true);
    expect(Value.Check(AgentRuntimeInfo, { providerId: 'dsh', sessionId: 'session', status: 'idle', settings: [{ ...setting, scope: 'session_and_default' }] })).toBe(true);
  });
  it('accepts a typed setting selection and rejects arbitrary native parameters', () => {
    const request = { protocolVersion: PROTOCOL_VERSION, type: 'set_session_setting', payload: { requestId: 'select', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent', settingId: 'model', value: 'native-model' } };
    expect(decodeClientMessage(JSON.stringify(request))).toEqual({ status: 'ok', value: request });
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, nativeParams: {} } })).status).toBe('rejected');
  });
});
