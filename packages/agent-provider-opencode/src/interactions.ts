import { AgentOperationRejectedError, validateInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type { AgentFormField, AgentFormValues, AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type { FormAnswer, FormField, FormInfo, FormMultiselectField, FormStringField, PermissionRequest } from '@opencode/client';

export function permissionRequest(native: PermissionRequest, restricted: boolean): AgentInteractionRequest {
  const saved = !restricted && !!native.save?.length;
  return {
    kind: 'tool_approval', requestId: native.id, toolCallId: native.source?.id ?? native.id,
    toolName: native.action, summary: native.message ?? `${native.action}: ${native.resources.join(', ')}`,
    detail: { type: 'other', description: `${native.action}: ${native.resources.join(', ')}` },
    allowedDecisions: restricted ? ['deny', 'cancel'] : ['allow', 'deny', 'cancel'],
    allowScopes: restricted ? [] : saved ? ['once', 'policy'] : ['once'],
    ...(saved ? { policies: [{ policyId: 'opencode:save', description: `Save approval for ${native.action}: ${native.save!.join(', ')} in this project, including future sessions.` }] } : {}),
  };
}

function unsupported(reason: string): never {
  throw new Error(`This OpenCode form cannot be represented by the Session View: ${reason}. Complete it in a native OpenCode client.`);
}
function invalid(reason: string): never {
  throw new AgentOperationRejectedError('invalid_operation', `Invalid OpenCode form answer: ${reason}.`);
}
function questionField(field: FormField): field is FormStringField | FormMultiselectField {
  if (field.type === 'string') return field.default === undefined && field.format === undefined && field.minLength === undefined && field.maxLength === undefined;
  return field.type === 'multiselect' && field.default === undefined && field.minItems === undefined && field.maxItems === undefined;
}

/** Preserve the native form's choices and constraints or leave it pending for a native client. */
export function formRequest(native: FormInfo): AgentInteractionRequest {
  const keys = new Set<string>();
  for (const field of native.fields) {
    if (!field.key || keys.has(field.key)) unsupported('missing or duplicate field identity');
    keys.add(field.key);
    if (field.type === 'external') continue;
    if (field.hidden || field.when?.length) unsupported(`conditional or hidden field ${field.key}`);
    if (field.type === 'string' && field.pattern !== undefined) unsupported(`pattern constraint on ${field.key}`);
  }
  const external = native.fields.filter(field => field.type === 'external');
  if (external.length) {
    const field = external[0]!;
    if (native.fields.length !== 1) unsupported('external actions mixed with other fields');
    return { kind: 'external_action', requestId: native.id, title: field.title ?? native.title, message: field.description ?? '', url: field.url };
  }
  const custom = native.fields.some(field => (field.type === 'string' && field.options !== undefined || field.type === 'multiselect') && field.custom);
  if (custom) {
    const fields = native.fields.filter(questionField);
    if (fields.length !== native.fields.length) unsupported('custom choices mixed with typed fields, defaults, or constraints');
    return { kind: 'question', requestId: native.id, questions: fields.map(field => ({
      questionId: field.key, header: field.title ?? native.title, prompt: field.description ?? field.title ?? native.title,
      required: field.required === true, selection: field.type === 'multiselect' ? 'multiple' : 'single',
      options: (field.options ?? []).map(option => ({ ...option })),
      allowCustomText: field.type === 'string' && field.options === undefined || field.custom === true,
      allowDismiss: true,
    })) };
  }
  return { kind: 'form', requestId: native.id, title: native.title, message: '', fields: native.fields.map(field => publicField(field)) };
}

function publicField(field: FormField): AgentFormField {
  if (field.type === 'external') return unsupported('mixed external action');
  const description = [field.description, field.type === 'string' && field.placeholder ? `Example: ${field.placeholder}` : undefined].filter(Boolean).join('\n');
  const base = { fieldId: field.key, label: field.title ?? field.key, required: field.required === true, ...(description ? { description } : {}) };
  if (field.type === 'number' || field.type === 'integer') {
    for (const value of [field.minimum, field.maximum, field.default]) if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) unsupported(`non-finite number in ${field.key}`);
    return { ...base, type: 'number', ...(field.type === 'integer' ? { integer: true } : {}),
      ...(typeof field.minimum === 'number' ? { minimum: field.minimum } : {}), ...(typeof field.maximum === 'number' ? { maximum: field.maximum } : {}),
      ...(typeof field.default === 'number' ? { defaultValue: field.default } : {}) };
  }
  if (field.type === 'boolean') return { ...base, type: 'boolean', ...(field.default !== undefined ? { defaultValue: field.default } : {}) };
  const options = (field.options ?? []).map(option => ({ value: option.value, label: option.description ? `${option.label} — ${option.description}` : option.label }));
  if (field.type === 'multiselect') return { ...base, type: 'multiselect', options,
    minItems: Math.max(field.required ? 1 : 0, field.minItems ?? 0), ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
    ...(field.default !== undefined ? { defaultValue: [...field.default] } : {}) };
  if (field.options !== undefined) {
    if (!options.length) unsupported(`empty choice list in ${field.key}`);
    // A select cannot express text constraints in the public contract.
    if (field.minLength !== undefined || field.maxLength !== undefined || field.format !== undefined) unsupported(`text constraints on choice field ${field.key}`);
    return { ...base, type: 'select', options, ...(field.default !== undefined ? { defaultValue: field.default } : {}) };
  }
  return { ...base, type: 'text', minLength: Math.max(field.required ? 1 : 0, field.minLength ?? 0),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}), ...(field.format !== undefined ? { format: field.format } : {}),
    ...(field.default !== undefined ? { defaultValue: field.default } : {}) };
}

/** Undefined means native cancellation, never an empty successful answer. */
export function formAnswer(native: FormInfo, response: AgentInteractionResponse): FormAnswer | undefined {
  const request = formRequest(native);
  validateInteractionResponse(request, response);
  let answer: AgentFormValues;
  if (response.kind === 'form') {
    if (response.action !== 'submit') return;
    answer = { ...response.values };
  } else if (response.kind === 'external_action') {
    if (response.action !== 'completed') return;
    answer = { [native.fields[0]!.key]: true };
  } else if (response.kind === 'question') {
    if (response.dismissed) return;
    answer = {};
    for (const entry of response.answers) {
      const field = native.fields.find(field => field.key === entry.questionId)!;
      const values = [...entry.selectedValues, ...(entry.customText !== undefined && entry.customText !== '' ? [entry.customText] : [])];
      if (field.type === 'string') {
        if (values.length > 1) invalid(`field ${field.key} needs exactly one string`);
        if (values.length) answer[field.key] = values[0]!;
      } else answer[field.key] = values;
    }
  } else return invalid('interaction kind does not match');
  validateNativeValues(native, answer);
  return answer;
}

/** Convert another client's native receipt without inventing a local response. */
export function formResponse(native: FormInfo, answer: FormAnswer): AgentInteractionResponse {
  const request = formRequest(native);
  validateNativeValues(native, answer);
  let response: AgentInteractionResponse;
  if (request.kind === 'external_action') response = { kind: 'external_action', action: 'completed' };
  else if (request.kind === 'form') response = { kind: 'form', action: 'submit', values: { ...answer } };
  else if (request.kind === 'question') response = { kind: 'question', answers: request.questions.filter(question => Object.hasOwn(answer, question.questionId)).map(question => {
    const value = answer[question.questionId]!;
    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : invalid(`field ${question.questionId} is not a choice answer`);
    const selectedValues = values.filter(value => question.options.some(option => option.value === value));
    const custom = values.filter(value => !question.options.some(option => option.value === value));
    if (custom.length > 1) unsupported(`multiple custom values for ${question.questionId}`);
    return { questionId: question.questionId, selectedValues, ...(custom.length ? { customText: custom[0]! } : {}) };
  }) };
  else return invalid('unsupported interaction kind');
  validateInteractionResponse(request, response);
  return response;
}

function validateNativeValues(native: FormInfo, answer: FormAnswer): void {
  for (const key of Object.keys(answer)) if (!native.fields.some(field => field.key === key)) invalid(`unknown field ${key}`);
  for (const field of native.fields) {
    const value = answer[field.key];
    if (field.type === 'external') { if (value !== true) invalid(`external field ${field.key} requires acknowledgement`); continue; }
    if (value === undefined) { if (field.required) invalid(`missing ${field.key}`); continue; }
    if (field.type === 'string') {
      if (typeof value !== 'string') invalid(`expected string in ${field.key}`);
      if (field.required && !value.length || field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) invalid(`text length in ${field.key}`);
      if (field.options && !field.custom && !field.options.some(option => option.value === value)) invalid(`unknown choice in ${field.key}`);
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value)) invalid(`expected ${field.type} in ${field.key}`);
      if (typeof field.minimum === 'number' && value < field.minimum || typeof field.maximum === 'number' && value > field.maximum) invalid(`number bounds in ${field.key}`);
    } else if (field.type === 'boolean') { if (typeof value !== 'boolean') invalid(`expected boolean in ${field.key}`); }
    else {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalid(`expected choices in ${field.key}`);
      if (field.required && !value.length || field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) invalid(`choice count in ${field.key}`);
      if (!field.custom && value.some(item => !field.options.some(option => option.value === item))) invalid(`unknown choice in ${field.key}`);
    }
  }
}
