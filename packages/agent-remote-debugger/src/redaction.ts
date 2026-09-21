import type { AgentInteractionRequest } from '@orchardworks/agent-remote-protocol';

/** Public output must stay safe even when a custom transport supplies raw response values. */
export function redactDebuggerValue(value: unknown, request?: AgentInteractionRequest): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDebuggerValue(item, request));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const context = source.request && typeof source.request === 'object'
    ? source.request as AgentInteractionRequest
    : request;
  const result = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, redactDebuggerValue(item, context)]));
  if (source.sensitive === true && typeof source.fieldId === 'string' && ['text', 'number', 'boolean', 'select', 'multiselect'].includes(String(source.type))) {
    delete result.defaultValue;
  }
  if (source.kind === 'question' && Array.isArray(source.answers)) {
    result.answers = source.answers.map((answer: { questionId: string; redacted?: boolean }) => {
      const question = context?.kind === 'question' ? context.questions.find(({ questionId }) => questionId === answer.questionId) : undefined;
      return !question || question.sensitive || answer.redacted
        ? { questionId: answer.questionId, selectedValues: [], redacted: true }
        : { ...answer };
    });
  } else if (source.kind === 'form' && source.action === 'submit' && source.values && typeof source.values === 'object') {
    const values = { ...source.values } as Record<string, unknown>;
    const redacted = new Set(Array.isArray(source.redactedFields) ? source.redactedFields as string[] : []);
    for (const fieldId of Object.keys(values)) {
      const field = context?.kind === 'form' ? context.fields.find((entry) => entry.fieldId === fieldId) : undefined;
      if (!field || field.sensitive || redacted.has(fieldId)) {
        delete values[fieldId];
        redacted.add(fieldId);
      }
    }
    result.values = values;
    if (redacted.size) result.redactedFields = [...redacted];
  }
  return result;
}
