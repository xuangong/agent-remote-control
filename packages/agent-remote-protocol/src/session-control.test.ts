import { Value } from '@sinclair/typebox/value';
import { AgentCapabilities } from './snapshot.js';
import { describe, expect, it } from 'vitest';
import { decodeClientMessage, decodeServerMessage, PROTOCOL_VERSION } from './index.js';

describe('session control wire contract', () => {
  it('negotiates exclusive control and distinguishes authority from normalized Agent state', () => {
    for (const message of [
      { type: 'negotiated', sessionControl: true },
      { type: 'session_control', payload: { agentId: 'one', access: 'read_only', available: false, revision: 'generation' } },
      { type: 'session_control', payload: { agentId: 'one', access: 'read_only', available: false, revision: 'generation', ownerKind: 'web' } },
      { type: 'session_control', payload: { agentId: 'one', access: 'read_only', available: false, revision: 'generation', nativeOwner: {kind: 'native_cli', generation: 'native-generation'} } },
      { type: 'session_control', payload: { agentId: 'one', access: 'control', available: false, revision: 'generation', token: 'private-proof' } },
    ]) expect(decodeServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message })).status).toBe('ok');
  });
  it('requires a revision for takeover and bounds control proofs', () => {
    const request = { protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: {
      agentId: 'one', requestId: 'claim', action: 'take_over', revision: 'generation',
    } };
    expect(decodeClientMessage(JSON.stringify(request)).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, clientKind: 'headless' } })).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, clientKind: 'native_cli' } })).status).toBe('rejected');
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, revision: '' } })).status).toBe('rejected');
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, resumeToken: 'x'.repeat(257) } })).status).toBe('rejected');
  });
});

it('accepts explicit shared and exclusive adapter control semantics and rejects native transport names', () => {
  const capabilities = {history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: {question: false, planApproval: false, toolApproval: false}};
  expect(Value.Check(AgentCapabilities, capabilities)).toBe(true);
  for (const sessionControl of ['shared', 'exclusive']) expect(Value.Check(AgentCapabilities, {...capabilities, sessionControl})).toBe(true);
  expect(Value.Check(AgentCapabilities, {...capabilities, sessionControl: 'socket'})).toBe(false);
});
