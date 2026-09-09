import { describe, expect, it } from 'vitest';
import { redactInteractionResponse, validateInteractionResponse, type AgentInteractionRequest, type AgentInteractionResponse } from './index.js';

const form: AgentInteractionRequest = {
  kind: 'form', requestId: 'form', title: 'Credentials', message: 'Enter details', fields: [
    { type: 'text', fieldId: 'email', label: 'Email', required: true, format: 'email', sensitive: true },
    { type: 'number', fieldId: 'count', label: 'Count', required: true, integer: true, minimum: 1, maximum: 3 },
    { type: 'multiselect', fieldId: 'tags', label: 'Tags', required: false, options: [{ value: 'a', label: 'A' }], maxItems: 1 },
  ],
};

describe('interaction responses', () => {
  it('accepts valid values and explicit cancellation', () => {
    expect(() => validateInteractionResponse(form, { kind: 'form', action: 'submit', values: { email: 'a@example.com', count: 2 } })).not.toThrow();
    expect(() => validateInteractionResponse(form, { kind: 'form', action: 'cancel' })).not.toThrow();
  });

  it.each([
    { email: 'invalid', count: 2 }, { email: 'a@example.com' },
    { email: 'a@example.com', count: 4 }, { email: 'a@example.com', count: 1.5 },
    { email: 'a@example.com', count: Infinity }, { email: 'a@example.com', count: 2, extra: true },
    { email: 'a@example.com', count: 2, tags: ['unknown'] },
    { email: 'a@example.com', count: 2, tags: ['a', 'a'] },
  ])('rejects values outside the displayed form: %j', (values) => {
    expect(() => validateInteractionResponse(form, { kind: 'form', action: 'submit', values })).toThrow();
  });

  it('redacts sensitive form values without mutating the provider command and rejects replay as input', () => {
    const response = { kind: 'form' as const, action: 'submit' as const, values: { email: 'a@example.com', count: 2 } };
    const redacted = redactInteractionResponse(form, response);
    expect(redacted).toEqual({ kind: 'form', action: 'submit', values: { count: 2 }, redactedFields: ['email'] });
    expect(response.values.email).toBe('a@example.com');
    expect(redactInteractionResponse(form, redacted)).toEqual(redacted);
    expect(() => validateInteractionResponse(form, redacted)).toThrow();
  });

  it('rejects unsupported permission scopes and unknown policy choices', () => {
    const permission: AgentInteractionRequest = { kind: 'permission_approval', requestId: 'p', summary: 'Read', permissions: [{ resource: 'filesystem', access: 'read', target: '/tmp' }], allowScopes: ['turn'] };
    expect(() => validateInteractionResponse(permission, { kind: 'permission_approval', decision: 'allow', scope: 'session' })).toThrow();
    expect(() => validateInteractionResponse(permission, { kind: 'permission_approval', decision: 'allow', scope: 'turn' })).not.toThrow();
    const tool: AgentInteractionRequest = { kind: 'tool_approval', requestId: 't', toolCallId: 'call', toolName: 'shell', summary: 'Run', detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow', 'cancel'], allowScopes: ['policy'], policies: [{ policyId: 'known', description: 'Known policy' }] };
    expect(() => validateInteractionResponse(tool, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'unknown' })).toThrow();
    expect(() => validateInteractionResponse(tool, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'known' })).not.toThrow();
    expect(() => validateInteractionResponse(tool, { kind: 'tool_approval', decision: 'cancel' })).not.toThrow();
    expect(() => validateInteractionResponse(tool, { kind: 'tool_approval', decision: 'deny' })).toThrow();
  });

  it('removes sensitive question selections and custom text in historical responses', () => {
    const request: AgentInteractionRequest = { kind: 'question', requestId: 'q', questions: [{ questionId: 'secret', header: 'Secret', prompt: 'Token', required: true, selection: 'single', options: [], allowCustomText: true, allowDismiss: true, sensitive: true }] };
    const response = { kind: 'question' as const, answers: [{ questionId: 'secret', selectedValues: [], customText: 'private-token' }] };
    expect(() => validateInteractionResponse(request, response)).not.toThrow();
    const redacted = redactInteractionResponse(request, response);
    expect(redacted).toEqual({ kind: 'question', answers: [{ questionId: 'secret', selectedValues: [], redacted: true }] });
    expect(() => validateInteractionResponse(request, redacted)).toThrow();
  });

  it.each([
    ['email', 'name@example.com', 'name@'],
    ['uri', 'https://example.com/path?q=1', 'https://example.com/%XX'],
    ['date', '2024-02-29', '2025-02-29'],
    ['date-time', '2026-09-09T12:15:30+08:00', '2026-09-09T24:15:30Z'],
  ] as const)('validates %s without accepting malformed values', (format, valid, invalid) => {
    const request: AgentInteractionRequest = { kind: 'form', requestId: 'format', title: 'Format', message: '', fields: [{ type: 'text', fieldId: 'value', label: 'Value', required: true, format }] };
    expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values: { value: valid } })).not.toThrow();
    expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values: { value: invalid } })).toThrow();
  });

  it('checks boolean, text length and exact select choices without coercion', () => {
    const request: AgentInteractionRequest = { kind: 'form', requestId: 'fields', title: 'Fields', message: '', fields: [
      { type: 'boolean', fieldId: 'enabled', label: 'Enabled', required: true },
      { type: 'text', fieldId: 'text', label: 'Text', required: true, minLength: 1, maxLength: 2 },
      { type: 'select', fieldId: 'choice', label: 'Choice', required: true, options: [{ value: 'known', label: 'Known' }] },
    ] };
    const values = { enabled: false, text: '🦷', choice: 'known' };
    expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values })).not.toThrow();
    for (const invalid of [{ ...values, enabled: 'false' }, { ...values, text: 'long' }, { ...values, choice: 'Known' }]) {
      expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values: invalid })).toThrow();
    }
  });

  it('rejects injected permission objects and policy IDs on once-only grants', () => {
    const request: AgentInteractionRequest = { kind: 'permission_approval', requestId: 'p', summary: 'Read', permissions: [{ resource: 'filesystem', access: 'read', target: '/tmp' }], allowScopes: ['turn'] };
    const injected = { kind: 'permission_approval' as const, decision: 'allow' as const, scope: 'turn' as const, permissions: [{ resource: 'filesystem', access: 'write', target: '/' }] };
    expect(() => validateInteractionResponse(request, injected)).toThrow();
    const tool: AgentInteractionRequest = { kind: 'tool_approval', requestId: 't', toolCallId: 'c', toolName: 'shell', summary: '', detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow'], allowScopes: ['once'] };
    expect(() => validateInteractionResponse(tool, { kind: 'tool_approval', decision: 'allow', scope: 'once', policyId: 'extra' } as AgentInteractionResponse)).toThrow();
  });
});

it('detaches public form requests and removes every sensitive default while preserving field constraints', async () => {
  const { redactInteractionRequest } = await import('./interactions.js');
  const request: AgentInteractionRequest = { kind: 'form', requestId: 'private-defaults', title: 'Input', message: '', fields: [
    { type: 'text', fieldId: 'text', label: 'Text', required: true, sensitive: true, defaultValue: 'secret', minLength: 1 },
    { type: 'number', fieldId: 'number', label: 'Number', required: true, sensitive: true, defaultValue: 0, minimum: 0 },
    { type: 'boolean', fieldId: 'boolean', label: 'Boolean', required: true, sensitive: true, defaultValue: false },
    { type: 'select', fieldId: 'select', label: 'Select', required: false, sensitive: true, defaultValue: 'one', options: [{ value: 'one', label: 'One' }] },
    { type: 'multiselect', fieldId: 'multi', label: 'Multi', required: false, sensitive: true, defaultValue: [], options: [{ value: 'one', label: 'One' }] },
    { type: 'text', fieldId: 'public', label: 'Public', required: false, defaultValue: 'west' },
  ] };
  const result = redactInteractionRequest(request);
  if (result.kind !== 'form') throw new Error('Expected a form');
  expect(result.fields.slice(0, 5).every((field) => !Object.hasOwn(field, 'defaultValue'))).toBe(true);
  expect(result.fields[0]).toMatchObject({ sensitive: true, minLength: 1 });
  expect(result.fields[5]).toMatchObject({ defaultValue: 'west' });
  result.fields[0]!.label = 'Changed';
  expect(request.fields[0]).toMatchObject({ label: 'Text', defaultValue: 'secret' });
  expect(redactInteractionRequest(result)).toEqual(result);
});

it('treats required form text as property presence and enforces nonempty text only through minLength', () => {
  const field = { type: 'text' as const, fieldId: 'value', label: 'Value', required: true };
  const request: AgentInteractionRequest = { kind: 'form', requestId: 'presence', title: 'Input', message: '', fields: [field] };
  expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values: { value: '' } })).not.toThrow();
  expect(() => validateInteractionResponse(request, { kind: 'form', action: 'submit', values: {} })).toThrow();
  expect(() => validateInteractionResponse({ ...request, fields: [{ ...field, minLength: 1 }] }, { kind: 'form', action: 'submit', values: { value: '' } })).toThrow();
});
