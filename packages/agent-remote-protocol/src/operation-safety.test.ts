import { describe, expect, it } from 'vitest';

import { decodeClientMessage, PROTOCOL_VERSION } from './index.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('mutation operation identities', () => {
  it.each([
    { type: 'send_message', payload: { requestId: 'request', operationId, agentId: 'agent', text: 'hello' } },
    { type: 'steer', payload: { requestId: 'request', operationId, agentId: 'agent', text: 'continue' } },
    { type: 'cancel', payload: { requestId: 'request', operationId, agentId: 'agent' } },
    { type: 'set_planning', payload: { requestId: 'request', operationId, agentId: 'agent', active: true } },
    { type: 'set_session_setting', payload: { requestId: 'request', operationId, agentId: 'agent', settingId: 'model', value: 'stable' } },
    { type: 'execute_command', payload: { requestId: 'request', operationId, agentId: 'agent', commandId: 'review', args: '--short' } },
    { type: 'interaction_response', payload: { requestId: 'approval', submissionId: 'request', operationId, agentId: 'agent', response: { kind: 'plan_approval', action: 'approve' } } },
    { type: 'create_agent', payload: { requestId: 'request', operationId, agentId: 'agent', providerId: 'codex', config: { sessionId: 'session' } } },
  ])('requires a versioned operation identity for $type', (message) => {
    expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message })).status).toBe('ok');
    const { operationId: _omitted, ...payload } = message.payload;
    expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: message.type, payload })).status).toBe('rejected');
  });

  it('rejects a transport request identity used as an operation identity', () => {
    expect(decodeClientMessage(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'cancel',
      payload: { requestId: 'request', operationId: 'request', agentId: 'agent' },
    })).status).toBe('rejected');
  });
});
