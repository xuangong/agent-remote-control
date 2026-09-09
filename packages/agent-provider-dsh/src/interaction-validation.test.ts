import { describe, expect, it } from 'vitest';
import { validateDshInteractionResponse } from './runtime.js';

describe('DSH interaction response boundaries', () => {
  it('rejects new interaction kinds unsupported by the native DSH services', () => {
    expect(() => validateDshInteractionResponse(
      { kind: 'form', requestId: 'form', title: 'Details', message: '', fields: [] },
      { kind: 'form', action: 'submit', values: {} },
    )).toThrow();
    expect(() => validateDshInteractionResponse(
      { kind: 'permission_approval', requestId: 'permissions', summary: 'Read', permissions: [], allowScopes: ['turn'] },
      { kind: 'permission_approval', decision: 'allow', scope: 'turn' },
    )).toThrow();
    expect(() => validateDshInteractionResponse(
      { kind: 'external_action', requestId: 'external', title: 'Login', message: '', url: 'https://example.com' },
      { kind: 'external_action', action: 'completed' },
    )).toThrow();
  });

  it('never expands native tool approval choices to policy or cancel', () => {
    const request = { kind: 'tool_approval', requestId: 'tool', toolName: 'read', summary: 'Read', allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] } as const;
    expect(() => validateDshInteractionResponse(request, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'invented' })).toThrow();
    expect(() => validateDshInteractionResponse(request, { kind: 'tool_approval', decision: 'cancel' })).toThrow();
    expect(() => validateDshInteractionResponse(request, { kind: 'tool_approval', decision: 'allow', scope: 'once' })).not.toThrow();
  });

  it('rejects historical redaction markers as new answers', () => {
    expect(() => validateDshInteractionResponse(
      { kind: 'question', requestId: 'question', questions: [{ questionId: 'q', header: 'Choose', prompt: 'Choose', options: [], selection: 'single', allowCustomText: true, allowDismiss: true, required: false }] },
      { kind: 'question', answers: [{ questionId: 'q', selectedValues: [], redacted: true }] },
    )).toThrow();
  });
});
