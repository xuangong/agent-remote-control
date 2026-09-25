import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type { PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2/client';
export function permissionRequest(native: PermissionRequest, restricted: boolean): AgentInteractionRequest {
  return { kind: 'tool_approval', requestId: native.id, toolCallId: native.tool?.callID ?? native.id, toolName: native.permission, summary: `${native.permission}: ${native.patterns.join(', ')}`, detail: { type: 'other', description: native.permission }, allowedDecisions: restricted ? ['deny', 'cancel'] : ['allow', 'deny', 'cancel'], allowScopes: restricted ? [] : ['once', 'session'] };
}
export function questionRequest(native: QuestionRequest): AgentInteractionRequest {
  return { kind: 'question', requestId: native.id, questions: native.questions.map((question, index) => ({ questionId: `${index}`, header: question.header, prompt: question.question, required: true, selection: question.multiple ? 'multiple' : 'single', options: question.options.map(option => ({ value: option.label, label: option.label, description: option.description })), allowCustomText: question.custom !== false, allowDismiss: true })) };
}
export function questionResponse(request: Extract<AgentInteractionRequest, { kind: 'question' }>, answers: string[][]): AgentInteractionResponse {
  return { kind: 'question', answers: request.questions.map((question, index) => ({ questionId: question.questionId, selectedValues: (answers[index] ?? []).filter(value => question.options.some(option => option.value === value)), ...((answers[index] ?? []).some(value => !question.options.some(option => option.value === value)) ? { customText: (answers[index] ?? []).filter(value => !question.options.some(option => option.value === value)).join('\n') } : {}) })) };
}
