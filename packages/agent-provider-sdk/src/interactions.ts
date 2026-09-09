import type { AgentFormField, AgentFormValue, AgentInteractionRequest, AgentInteractionResponse } from './control.js';

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Interaction response does not satisfy the pending request.');
}

function onlyKeys(value: object, keys: string[]): void {
  requireValid(Object.keys(value).every((key) => keys.includes(key)));
}

/** Validates a command against exactly the choices displayed by its pending request. */
export function validateInteractionResponse(request: AgentInteractionRequest, response: AgentInteractionResponse): void {
  requireValid(response && request.kind === response.kind);
  if (request.kind === 'question' && response.kind === 'question') {
    onlyKeys(response, ['kind', 'answers', 'dismissed']);
    requireValid(Array.isArray(response.answers));
    requireValid(response.dismissed === undefined || typeof response.dismissed === 'boolean');
    const seen = new Set<string>();
    for (const answer of response.answers) {
      onlyKeys(answer, ['questionId', 'selectedValues', 'customText']);
      const question = request.questions.find(({ questionId }) => questionId === answer.questionId);
      requireValid(question && !seen.has(answer.questionId));
      seen.add(answer.questionId);
      requireValid(Array.isArray(answer.selectedValues) && new Set(answer.selectedValues).size === answer.selectedValues.length);
      requireValid(question.selection !== 'single' || answer.selectedValues.length <= 1);
      requireValid(answer.selectedValues.every((value) => question.options.some((option) => option.value === value)));
      requireValid(answer.customText === undefined || (question.allowCustomText && typeof answer.customText === 'string'));
      if (!response.dismissed && question.required) requireValid(answer.selectedValues.length > 0 || answer.customText?.trim());
    }
    if (response.dismissed) requireValid(request.questions.every(({ allowDismiss }) => allowDismiss));
    else requireValid(request.questions.every((question) => !question.required || seen.has(question.questionId)));
    return;
  }
  if (request.kind === 'plan_approval' && response.kind === 'plan_approval') {
    onlyKeys(response, response.action === 'reject' ? ['kind', 'action', 'feedback'] : ['kind', 'action']);
    requireValid(request.allowedActions.includes(response.action));
    if (response.action === 'reject') requireValid(response.feedback === undefined || typeof response.feedback === 'string');
    return;
  }
  if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
    requireValid(request.allowedDecisions.includes(response.decision));
    if (response.decision === 'allow') {
      onlyKeys(response, response.scope === 'policy' ? ['kind', 'decision', 'scope', 'policyId'] : ['kind', 'decision', 'scope']);
      requireValid(request.allowScopes.includes(response.scope));
      if (response.scope === 'policy') requireValid(request.policies?.some(({ policyId }) => policyId === response.policyId));
    } else {
      onlyKeys(response, ['kind', 'decision', 'message']);
      requireValid(response.message === undefined || typeof response.message === 'string');
    }
    return;
  }
  if (request.kind === 'form' && response.kind === 'form') {
    if (response.action !== 'submit') {
      onlyKeys(response, ['kind', 'action']);
      requireValid(response.action === 'decline' || response.action === 'cancel');
      return;
    }
    onlyKeys(response, ['kind', 'action', 'values']);
    requireValid(response.values && typeof response.values === 'object' && !Array.isArray(response.values));
    requireValid(Object.keys(response.values).every((key) => request.fields.some(({ fieldId }) => fieldId === key)));
    for (const field of request.fields) {
      const present = Object.hasOwn(response.values, field.fieldId);
      requireValid(present || !field.required);
      if (present) validateFormValue(field, response.values[field.fieldId]!);
    }
    return;
  }
  if (request.kind === 'permission_approval' && response.kind === 'permission_approval') {
    if (response.decision === 'allow') {
      onlyKeys(response, ['kind', 'decision', 'scope']);
      requireValid(request.allowScopes.includes(response.scope));
    } else {
      onlyKeys(response, ['kind', 'decision']);
      requireValid(response.decision === 'deny');
    }
    return;
  }
  if (request.kind === 'external_action' && response.kind === 'external_action') {
    onlyKeys(response, ['kind', 'action']);
    requireValid(['completed', 'decline', 'cancel'].includes(response.action));
    return;
  }
  requireValid(false);
}

function validateFormValue(field: AgentFormField, value: AgentFormValue): void {
  switch (field.type) {
    case 'text':
      requireValid(typeof value === 'string');
      requireValid(field.minLength === undefined || [...value].length >= field.minLength);
      requireValid(field.maxLength === undefined || [...value].length <= field.maxLength);
      requireValid(field.format === undefined || validFormat(field.format, value));
      break;
    case 'number':
      requireValid(typeof value === 'number' && Number.isFinite(value));
      requireValid(!field.integer || Number.isInteger(value));
      requireValid(field.minimum === undefined || value >= field.minimum);
      requireValid(field.maximum === undefined || value <= field.maximum);
      break;
    case 'boolean':
      requireValid(typeof value === 'boolean');
      break;
    case 'select':
      requireValid(typeof value === 'string' && field.options.some((option) => option.value === value));
      break;
    case 'multiselect':
      requireValid(Array.isArray(value) && value.every((item) => typeof item === 'string'));
      requireValid(new Set(value).size === value.length);
      requireValid(value.every((item) => field.options.some((option) => option.value === item)));
      requireValid(field.minItems === undefined || value.length >= field.minItems);
      requireValid(field.maxItems === undefined || value.length <= field.maxItems);
      break;
  }
}

function validFormat(format: string, value: string): boolean {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (format === 'uri') {
    return /^[a-z][a-z\d+.-]*:(?:[a-z\d\-._~:/?#[\]@!$&'()*+,;=]|%[a-f\d]{2})*$/iu.test(value);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.slice(0, 10));
  if (!date) return false;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return false;
  if (format === 'date') return value.length === 10;
  return /^\d{4}-\d{2}-\d{2}[tT](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value);
}

/** Produces a detached public request without publishing sensitive field defaults. */
export function redactInteractionRequest(request: AgentInteractionRequest): AgentInteractionRequest {
  const result = JSON.parse(JSON.stringify(request)) as AgentInteractionRequest;
  if (result.kind === 'form') {
    for (const field of result.fields) if (field.sensitive) delete field.defaultValue;
  }
  return result;
}

/** Produces a detached historical receipt; sensitive values belong only in the provider command. */
export function redactInteractionResponse(request: AgentInteractionRequest, response: AgentInteractionResponse): AgentInteractionResponse {
  const result = JSON.parse(JSON.stringify(response)) as AgentInteractionResponse;
  if (result.kind === 'question') {
    result.answers = result.answers.map((answer) => {
      const question = request.kind === 'question' ? request.questions.find(({ questionId }) => questionId === answer.questionId) : undefined;
      return !question || question.sensitive || answer.redacted
        ? { questionId: answer.questionId, selectedValues: [], redacted: true }
        : answer;
    });
  }
  if (result.kind === 'form' && result.action === 'submit') {
    const redacted = new Set(result.redactedFields ?? []);
    for (const fieldId of Object.keys(result.values)) {
      const field = request.kind === 'form' ? request.fields.find((entry) => entry.fieldId === fieldId) : undefined;
      if (!field || field.sensitive || redacted.has(fieldId)) {
        delete result.values[fieldId];
        redacted.add(fieldId);
      }
    }
    if (redacted.size) result.redactedFields = [...redacted];
  }
  return result;
}
