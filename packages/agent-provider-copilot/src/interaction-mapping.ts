import type {SessionEvent} from '@github/copilot-sdk';
import type {AgentInteractionRequest, AgentInteractionResponse, AgentPlanAction} from '@orchardworks/agent-provider-sdk';
import {mapCopilotElicitation} from './elicitation.js';
import {record} from './native.js';
import {permissionRequest} from './permissions.js';

export function interactionRequest(event: SessionEvent): AgentInteractionRequest | undefined {
 if (event.type === 'permission.requested' && !event.data.resolvedByHook) {
  return permissionRequest(event);
 }
 if (event.type === 'user_input.requested') {
  const r = event.data;
  return {kind: 'question', requestId: r.requestId, questions: [{questionId: 'answer', header: 'Copilot', prompt: r.question, required: true, selection: 'single', options: (r.choices ?? []).map(value => ({value, label: value})), allowCustomText: r.allowFreeform !== false, allowDismiss: false}]};
 }
 if (event.type === 'elicitation.requested') return mapCopilotElicitation(record(event.data), event.data.requestId);
 if (event.type === 'exit_plan_mode.requested') {
  const r = event.data;
  const allowedActions: AgentPlanAction[] = [];
  if (r.actions.includes('exit_only')) allowedActions.push('approve');
  if (r.actions.includes('interactive')) allowedActions.push('approve_and_resume');
  allowedActions.push('reject');
  return {kind: 'plan_approval', requestId: r.requestId, plan: r.planContent || r.summary, allowedActions};
 }
}
export function interactionResponse(event: SessionEvent, request: AgentInteractionRequest): AgentInteractionResponse | undefined {
 if (event.type === 'permission.completed' && request.kind === 'tool_approval') {
  const kind = event.data.result.kind;
  return kind.startsWith('approved') ? {kind: 'tool_approval', decision: 'allow', scope: 'once'} : {kind: 'tool_approval', decision: kind.startsWith('denied') ? 'deny' : 'cancel'};
 }
 if (event.type === 'user_input.completed' && request.kind === 'question') {
  const {answer, wasFreeform} = event.data;
  return answer === undefined ? {kind: 'question', answers: [], dismissed: true} : {kind: 'question', answers: [{questionId: 'answer', selectedValues: wasFreeform ? [] : [answer], ...(wasFreeform ? {customText: answer} : {})}]};
 }
 if (event.type === 'elicitation.completed') {
  const {action, content} = event.data;
  if (!action) return undefined;
  if (request.kind === 'external_action') return {kind: 'external_action', action: action === 'accept' ? 'completed' : action};
  if (request.kind === 'form') return action === 'accept' ? {kind: 'form', action: 'submit', values: (content ?? {}) as import('@orchardworks/agent-provider-sdk').AgentFormValues} : {kind: 'form', action};
 }
 if (event.type === 'exit_plan_mode.completed' && request.kind === 'plan_approval') {
  if (event.data.approved === false) return {kind: 'plan_approval', action: 'reject', feedback: event.data.feedback};
  if (event.data.approved && event.data.selectedAction === 'exit_only') return {kind: 'plan_approval', action: 'approve'};
  if (event.data.approved && event.data.selectedAction === 'interactive') return {kind: 'plan_approval', action: 'approve_and_resume'};
 }
}

export function isNativeInteraction(event: SessionEvent): boolean {
 return /^(permission|user_input|exit_plan_mode|elicitation)\.(requested|completed)$/.test(event.type);
}
