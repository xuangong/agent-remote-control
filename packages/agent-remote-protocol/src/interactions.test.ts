import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { AgentInteractionRequest, AgentInteractionResponse } from './interactions.js';

describe('interaction wire contracts', () => {
  it('accepts typed forms and historical sensitive receipts', () => {
    expect(Value.Check(AgentInteractionRequest, { kind: 'form', requestId: 'f', title: 'Name', message: '', fields: [{ type: 'text', fieldId: 'name', label: 'Name', required: true, sensitive: true, maxLength: 10 }] })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'form', action: 'submit', values: {}, redactedFields: ['name'] })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'question', answers: [{ questionId: 'q', selectedValues: [], redacted: true }] })).toBe(true);
  });
  it('rejects arbitrary schemas, invalid ranges, unsafe links and grants without scopes', () => {
    const form = { kind: 'form', requestId: 'f', title: 'Name', message: '' };
    expect(Value.Check(AgentInteractionRequest, { ...form, fields: [{ type: 'object', fieldId: 'name', label: 'Name', required: true }] })).toBe(false);
    expect(Value.Check(AgentInteractionRequest, { ...form, fields: [{ type: 'text', fieldId: 'name', label: 'Name', required: true, minLength: -1 }] })).toBe(false);
    expect(Value.Check(AgentInteractionRequest, { kind: 'external_action', requestId: 'e', title: 'Visit', message: '', url: 'javascript:alert(1)' })).toBe(false);
    expect(Value.Check(AgentInteractionResponse, { kind: 'permission_approval', decision: 'allow' })).toBe(false);
    expect(Value.Check(AgentInteractionResponse, { kind: 'tool_approval', decision: 'allow', scope: 'policy' })).toBe(false);
  });
  it('accepts explicit permission and policy decisions', () => {
    expect(Value.Check(AgentInteractionRequest, { kind: 'permission_approval', requestId: 'p', summary: 'Read', permissions: [{ resource: 'filesystem', access: 'read', target: '/tmp' }], allowScopes: ['turn'] })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'policy' })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'tool_approval', decision: 'cancel' })).toBe(true);
  });
});
