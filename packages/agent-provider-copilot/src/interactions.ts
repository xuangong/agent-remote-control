import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { validateInteractionResponse, redactInteractionResponse, type AgentInteractionRequest, type AgentInteractionResponse, type AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { provider, record } from './native.js';
import {sessionApproval} from './permissions.js';
import {interactionRequest, interactionResponse} from './interaction-mapping.js';
type ElicitationPayload = Parameters<NonNullable<import('@github/copilot-sdk').SessionConfig['onElicitationRequest']>>[0];
type ElicitationReply = import('@github/copilot-sdk').ElicitationResult;
type PlanPayload = Parameters<NonNullable<import('@github/copilot-sdk').SessionConfig['onExitPlanModeRequest']>>[0];
type PlanReply = {approved: boolean; selectedAction?: string; feedback?: string};
type QuestionPayload = Parameters<NonNullable<import('@github/copilot-sdk').SessionConfig['onUserInputRequest']>>[0];
type QuestionReply = {answer: string; wasFreeform: boolean};
interface Pending { sessionDecision?: ReturnType<typeof sessionApproval>; submittedResponse?: AgentInteractionResponse; request: AgentInteractionRequest; owner?: string | null; toolCallId?: string; submitting: boolean; elicitation?: ElicitationPayload; elicitationCallback?: {resolve: (reply: ElicitationReply) => void; reject: (error: Error) => void}; question?: QuestionPayload; plan?: PlanPayload; planCallback?: {resolve: (reply: PlanReply) => void; reject: (error: Error) => void}; callback?: {resolve: (reply: QuestionReply) => void; reject: (error: Error) => void}; }
/** Native request IDs correlate presentation, responses, completion and cancellation. */
export class NativeInteractions {
  private readonly toolOwners = new Map<string, string | undefined>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly emit: (event: AgentStreamEvent) => void, private readonly rpc: () => CopilotSession['rpc'], private readonly call: <T>(operation: Promise<T>, label: string) => Promise<T>) {}
  get waiting(): boolean { return this.pending.size > 0; }
  trackTool(event: SessionEvent): void {
    if (event.type !== 'tool.execution_start') return;
    const owner = event.agentId ?? event.data.parentToolCallId;
    this.toolOwners.set(event.data.toolCallId, owner);
    for (const pending of this.pending.values()) if (pending.owner === null && pending.toolCallId === event.data.toolCallId) pending.owner = owner;
  }
  private owner(event: SessionEvent, toolCallId?: string): string | null | undefined {
    if (event.agentId) return event.agentId;
    return toolCallId ? this.toolOwners.has(toolCallId) ? this.toolOwners.get(toolCallId) : null : undefined;
  }
  accept(event: SessionEvent): void {
    this.trackTool(event);
    let request: AgentInteractionRequest | undefined;
    try {request = interactionRequest(event);} catch {
      this.emit({type: 'timeline', provider, item: {type: 'error', message: 'Copilot interaction uses an unsupported schema.'}}); return;
    }
    if (request) {
      const d = record(event.data);
      const nativeToolCallId = d.toolCallId ?? record(d.promptRequest).toolCallId ?? record(d.permissionRequest).toolCallId;
      const toolCallId = typeof nativeToolCallId === 'string' ? nativeToolCallId : undefined;
      this.open(request, this.owner(event, toolCallId), toolCallId);
      const pending = this.pending.get(request.requestId)!;
      if (event.type === 'permission.requested') pending.sessionDecision = sessionApproval(event);
      if (event.type === 'user_input.requested') pending.question = event.data;
      if (event.type === 'exit_plan_mode.requested') pending.plan = event.data;
      if (event.type === 'elicitation.requested') pending.elicitation = {...event.data, sessionId: ''} as ElicitationPayload;
    } else if (event.type === 'permission.completed') {
      const kind = event.data.result.kind;
      const submitted = this.pending.get(event.data.requestId)?.submittedResponse;
      this.retire(event.data.requestId, kind.startsWith('approved') ? submitted?.kind === 'tool_approval' && submitted.decision === 'allow' ? submitted : {kind: 'tool_approval', decision: 'allow', scope: 'once'}
        : {kind: 'tool_approval', decision: kind.startsWith('denied') ? 'deny' : 'cancel'});
    } else if (event.type === 'user_input.completed') {
      const request = this.pending.get(event.data.requestId)?.request;
      if (!request || request.kind !== 'question') return;
      const {answer, wasFreeform} = event.data;
      const pending = this.pending.get(event.data.requestId);
      if (answer === undefined) pending?.callback?.reject(new Error('Copilot question was canceled.'));
      else pending?.callback?.resolve({answer, wasFreeform: wasFreeform ?? false});
      this.retire(event.data.requestId, answer === undefined ? {kind: 'question', answers: [], dismissed: true} : {kind: 'question', answers: [{questionId: 'answer', selectedValues: wasFreeform ? [] : [answer], ...(wasFreeform ? {customText: answer} : {})}]});
    } else if (event.type === 'elicitation.completed') {
      const pending = this.pending.get(event.data.requestId); if (!pending) return;
      const response = interactionResponse(event, pending.request);
      if (response && event.data.action) pending.elicitationCallback?.resolve({action: event.data.action, content: event.data.content as ElicitationReply['content']});
      this.retire(event.data.requestId, response);
    } else if (event.type === 'exit_plan_mode.completed') {
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      const response = interactionResponse(event, pending.request);
      if (response) pending.planCallback?.resolve({approved: event.data.approved === true, selectedAction: event.data.selectedAction, feedback: event.data.feedback});
      this.retire(event.data.requestId, response);
    } else if (event.type === 'abort') this.cancelOwner(event.agentId);
  }
  bindQuestion(payload: QuestionPayload): Promise<QuestionReply> {
    const signature = (value: QuestionPayload) => JSON.stringify([value.question, value.choices ?? [], value.allowFreeform !== false]);
    const matches = [...this.pending.values()].filter(pending => !pending.callback && pending.question && signature(pending.question) === signature(payload));
    if (matches.length !== 1) {
      const message = 'Copilot question callback has no unique native request identity; concurrent identical questions are unsupported.';
      this.emit({type: 'timeline', provider, item: {type: 'error', message}});
      for (const pending of matches) this.retire(pending.request.requestId);
      return Promise.reject(new Error(message));
    }
    return new Promise((resolve, reject) => { matches[0]!.callback = {resolve, reject}; });
  }
  async bindElicitation(payload: ElicitationPayload): Promise<ElicitationReply> {
    // The SDK invokes this callback before broadcasting the identity-bearing event.
    await Promise.resolve();
    const signature = (p: ElicitationPayload) => JSON.stringify([p.message, p.mode ?? 'form', p.requestedSchema, p.url, p.elicitationSource]);
    const matches = [...this.pending.values()].filter(p => p.elicitation && !p.elicitationCallback && signature(p.elicitation) === signature(payload));
    if (matches.length !== 1) {
      for (const pending of matches) this.retire(pending.request.requestId);
      return Promise.reject(new Error('Copilot elicitation callback has no unique native request identity.'));
    }
    return new Promise((resolve, reject) => {matches[0]!.elicitationCallback = {resolve, reject};});
  }
  bindPlan(payload: PlanPayload): Promise<PlanReply> {
    const signature = (p: PlanPayload) => JSON.stringify([p.summary, p.planContent ?? '', p.actions, p.recommendedAction]);
    const matches = [...this.pending.values()].filter(p => p.plan && !p.planCallback && signature(p.plan) === signature(payload));
    if (matches.length !== 1) {
      const error = new Error('Copilot plan callback has no unique native request identity.');
      this.emit({type: 'timeline', provider, item: {type: 'error', message: error.message}});
      for (const pending of matches) this.retire(pending.request.requestId);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {matches[0]!.planCallback = {resolve, reject};});
  }
  private open(request: AgentInteractionRequest, owner?: string | null, toolCallId?: string): void {
    if (this.pending.has(request.requestId)) return;
    this.pending.set(request.requestId, {request, owner, toolCallId, submitting: false});
    this.emit({type: 'interaction_requested', provider, request});
  }
  private retire(requestId: string, response?: AgentInteractionResponse): void {
    const pending = this.pending.get(requestId); if (!pending) return;
    this.pending.delete(requestId);
    if (!response) {
      pending.callback?.reject(new Error('Copilot question was canceled.'));
      pending.planCallback?.reject(new Error('Copilot plan approval was canceled.'));
      pending.elicitationCallback?.reject(new Error('Copilot elicitation was canceled.'));
      if (pending.request.kind === 'plan_approval' || pending.elicitation) {
        this.emit({type: 'interaction_invalidated', provider, requestId, reason: 'Native interaction is no longer pending.'}); return;
      }
    }
    const terminal = response ?? (pending.request.kind === 'question' ? {kind: 'question' as const, answers: [], dismissed: true} : {kind: 'tool_approval' as const, decision: 'cancel' as const});
    this.emit({type: 'interaction_resolved', provider, requestId, response: redactInteractionResponse(pending.request, terminal)});
  }
  cancelOwner(owner?: string | null, toolCallId?: string): void { for (const [id, pending] of this.pending) if (pending.owner === owner) this.retire(id); }
  dispose(): void { for (const id of this.pending.keys()) this.retire(id); }
  async respond(requestId: string, response: AgentInteractionResponse): Promise<void> {
    const pending = this.pending.get(requestId); if (!pending) throw new AgentOperationRejectedError('operation_rejected', 'Unknown Copilot interaction.');
    if (pending.submitting) throw new AgentOperationRejectedError('operation_rejected', 'Copilot interaction response is already pending.');
    validateInteractionResponse(pending.request, response); pending.submitting = true; pending.submittedResponse = response;
    try {
      if (response.kind === 'form' || response.kind === 'external_action') {
        if (!pending.elicitationCallback) throw new AgentOperationRejectedError('operation_rejected', 'Copilot native elicitation callback is not available.');
        pending.elicitationCallback.resolve(response.kind === 'form' && response.action === 'submit' ? {action: 'accept', content: response.values} : {action: response.action === 'completed' ? 'accept' : response.action as 'decline' | 'cancel'});
        this.retire(requestId, response); return;
      }
      if (response.kind === 'plan_approval') {
        if (!pending.planCallback) throw new AgentOperationRejectedError('operation_rejected', 'Copilot native plan callback is not available.');
        pending.planCallback.resolve(response.action === 'reject' ? {approved: false, feedback: response.feedback} : {approved: true, selectedAction: response.action === 'approve' ? 'exit_only' : 'interactive'});
        this.retire(requestId, response); return;
      }
      if (response.kind === 'question') {
        if (!pending.callback) throw new AgentOperationRejectedError('operation_rejected', 'Copilot native question callback is not available.');
        const answer = response.answers[0]!;
        pending.callback.resolve({answer: answer.customText ?? answer.selectedValues[0]!, wasFreeform: answer.customText !== undefined});
        this.retire(requestId, response); return;
      }
      const result = response.kind === 'tool_approval'
        ? await this.call(this.rpc().permissions.handlePendingPermissionRequest({requestId, result: response.decision === 'allow' ? response.scope === 'session' && pending.sessionDecision ? pending.sessionDecision : {kind: 'approve-once', approvedInteractively: true} : {kind: 'reject'}}), 'Respond to Copilot permission')
        : undefined;
      if (!result?.success) throw new Error('Copilot did not confirm the interaction response.');
      this.retire(requestId, response);
    } finally { pending.submitting = false; pending.submittedResponse = undefined; }
  }
}
