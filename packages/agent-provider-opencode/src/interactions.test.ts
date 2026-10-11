import { expect, test } from 'vitest';
import type { FormInfo, PermissionRequest } from '@opencode/client';
import { validateInteractionResponse } from '@orchardworks/agent-provider-sdk';
import { formAnswer, formRequest, formResponse, permissionRequest } from './interactions.js';

const form = (fields: FormInfo['fields']): FormInfo => ({ id: 'form_1', sessionID: 'ses_1', title: 'Review the plan', fields });

test('preserves v2 permission source and project-wide persistent approval scope', () => {
  const native: PermissionRequest = { id: 'perm_1', sessionID: 'ses_1', action: 'shell', resources: ['git status'], save: ['git *'], source: { type: 'tool', messageID: 'msg_1', id: 'tool_1' }, message: 'Inspect the worktree' };
  const request = permissionRequest(native, false);
  expect(request).toMatchObject({ kind: 'tool_approval', toolCallId: 'tool_1', toolName: 'shell', allowScopes: ['once', 'policy'], policies: [{ policyId: 'opencode:save', description: expect.stringContaining('project') }] });
  validateInteractionResponse(request, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'opencode:save' });
  expect(() => validateInteractionResponse(request, { kind: 'tool_approval', decision: 'allow', scope: 'session' })).toThrow();
  expect(permissionRequest({ ...native, save: [] }, false)).toMatchObject({ allowScopes: ['once'] });
  const restricted = permissionRequest(native, true);
  expect(restricted).toMatchObject({ allowedDecisions: ['deny', 'cancel'], allowScopes: [] });
  expect(() => validateInteractionResponse(restricted, { kind: 'tool_approval', decision: 'allow', scope: 'once' })).toThrow();
}, 5000);

test('maps typed native forms and validates answers before native dispatch', () => {
  const native = form([
    { key: 'title', title: 'Name', type: 'string', required: true, minLength: 2, maxLength: 20, default: 'Example' },
    { key: 'count', type: 'integer', minimum: 1, maximum: 5, required: true, default: 2 },
    { key: 'ratio', type: 'number', minimum: 0, maximum: 1 },
    { key: 'confirm', type: 'boolean', required: true },
    { key: 'mode', type: 'string', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }], default: 'safe' },
    { key: 'paths', type: 'multiselect', required: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], minItems: 1, maxItems: 2 },
  ]);
  const request = formRequest(native);
  expect(request).toMatchObject({ kind: 'form', fields: [{ fieldId: 'title', type: 'text', defaultValue: 'Example' }, { fieldId: 'count', type: 'number', integer: true, minimum: 1, maximum: 5 }, { fieldId: 'ratio', type: 'number' }, { fieldId: 'confirm', type: 'boolean' }, { fieldId: 'mode', type: 'select' }, { fieldId: 'paths', type: 'multiselect' }] });
  const values = { title: 'Plan', count: 3, ratio: 0.5, confirm: false, mode: 'fast', paths: ['a'] };
  expect(formAnswer(native, { kind: 'form', action: 'submit', values })).toEqual(values);
  expect(formResponse(native, values)).toEqual({ kind: 'form', action: 'submit', values });
  expect(formAnswer(native, { kind: 'form', action: 'cancel' })).toBeUndefined();
  for (const invalid of [{ ...values, count: 2.5 }, { ...values, count: 7 }, { ...values, title: '' }, { ...values, paths: [] }, { ...values, unexpected: true }]) {
    expect(() => formAnswer(native, { kind: 'form', action: 'submit', values: invalid })).toThrow();
  }
}, 5000);

test('maps question-style choices and custom text without changing field identities', () => {
  const native = form([
    { key: 'approach', title: 'Approach', description: 'Choose a plan', type: 'string', required: true, options: [{ value: 'a', label: 'A', description: 'Conservative' }], custom: true },
    { key: 'checks', type: 'multiselect', options: [{ value: 'unit', label: 'Unit' }], custom: true },
  ]);
  const request = formRequest(native);
  expect(request).toMatchObject({ kind: 'question', questions: [{ questionId: 'approach', allowCustomText: true }, { questionId: 'checks', selection: 'multiple' }] });
  const response = { kind: 'question' as const, answers: [{ questionId: 'approach', selectedValues: [], customText: 'Another plan' }, { questionId: 'checks', selectedValues: ['unit'], customText: 'manual\nverification' }] };
  expect(formAnswer(native, response)).toEqual({ approach: 'Another plan', checks: ['unit', 'manual\nverification'] });
  expect(formResponse(native, { approach: 'Another plan', checks: ['unit', 'manual\nverification'] })).toEqual(response);
  expect(formAnswer(native, { kind: 'question', answers: [], dismissed: true })).toBeUndefined();
  expect(() => formAnswer(native, { kind: 'question', answers: [{ questionId: 'approach', selectedValues: ['a'], customText: 'Another plan' }] })).toThrow();
  expect(() => formResponse(native, { approach: 'a', checks: ['first custom', 'second custom'] })).toThrow(/multiple custom/i);
}, 5000);

test('maps a single external action and preserves its required acknowledgement', () => {
  const native = form([{ key: 'auth', type: 'external', title: 'Connect', description: 'Complete sign-in', url: 'https://example.com/auth' }]);
  expect(formRequest(native)).toEqual({ kind: 'external_action', requestId: 'form_1', title: 'Connect', message: 'Complete sign-in', url: 'https://example.com/auth' });
  expect(formAnswer(native, { kind: 'external_action', action: 'completed' })).toEqual({ auth: true });
  expect(formAnswer(native, { kind: 'external_action', action: 'decline' })).toBeUndefined();
  expect(formResponse(native, { auth: true })).toEqual({ kind: 'external_action', action: 'completed' });
  expect(() => formResponse(native, { auth: false })).toThrow();
}, 5000);

test('does not silently drop native form constraints unsupported by the public interaction contract', () => {
  const unsupported: FormInfo['fields'][] = [
    [{ key: 'text', type: 'string', hidden: true }],
    [{ key: 'text', type: 'string', pattern: '^safe$' }],
    [{ key: 'yes', type: 'boolean' }, { key: 'text', type: 'string', when: [{ key: 'yes', op: 'eq', value: true }] }],
    [{ key: 'auth', type: 'external', url: 'https://example.com' }, { key: 'text', type: 'string' }],
    [{ key: 'count', type: 'number', default: 'Infinity' }],
    [{ key: 'text', type: 'string', options: [{ value: 'a', label: 'A' }], custom: true }, { key: 'count', type: 'integer' }],
  ];
  for (const fields of unsupported) expect(() => formRequest(form(fields))).toThrow(/cannot be represented/);
}, 5000);
