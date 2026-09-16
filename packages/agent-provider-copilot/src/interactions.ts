import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { validateInteractionResponse, type AgentInteractionRequest, type AgentInteractionResponse, type AgentStreamEvent } from '@agent-remote-controller/agent-provider-sdk';
import { detail, provider, record } from './projector.js';
type QuestionPayload = Parameters<NonNullable<import('@github/copilot-sdk').SessionConfig['onUserInputRequest']>>[0];
type QuestionReply = {answer: string; wasFreeform: boolean};
interface Pending { request: AgentInteractionRequest; owner?: string | null; toolCallId?: string; submitting: boolean; question?: QuestionPayload; callback?: {resolve: (reply: QuestionReply) => void; reject: (error: Error) => void}; }
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
    if (event.type === 'permission.requested' && !event.data.resolvedByHook) {
      const {requestId, permissionRequest} = event.data;
      const toolCallId = record(event.data.promptRequest).toolCallId ?? record(permissionRequest).toolCallId;
      this.open({kind: 'tool_approval', requestId, toolCallId: typeof toolCallId === 'string' ? toolCallId : requestId, toolName: permissionRequest.kind, summary: JSON.stringify(permissionRequest), detail: detail(permissionRequest.kind, permissionRequest), allowedDecisions: ['allow', 'deny'], allowScopes: ['once']}, this.owner(event, typeof toolCallId === 'string' ? toolCallId : undefined), typeof toolCallId === 'string' ? toolCallId : undefined);
    } else if (event.type === 'user_input.requested') {
      const request = event.data;
      this.open({kind: 'question', requestId: request.requestId, questions: [{questionId: 'answer', header: 'Copilot', prompt: request.question, required: true, selection: 'single', options: (request.choices ?? []).map(value => ({value, label: value})), allowCustomText: request.allowFreeform !== false, allowDismiss: false}]}, this.owner(event, request.toolCallId), request.toolCallId);
      this.pending.get(request.requestId)!.question = {question: request.question, choices: request.choices, allowFreeform: request.allowFreeform};
    } else if (event.type === 'permission.completed') {
      const kind = event.data.result.kind;
      this.retire(event.data.requestId, kind.startsWith('approved') ? {kind: 'tool_approval', decision: 'allow', scope: 'once'}
        : {kind: 'tool_approval', decision: kind.startsWith('denied') ? 'deny' : 'cancel'});
    } else if (event.type === 'user_input.completed') {
      const request = this.pending.get(event.data.requestId)?.request;
      if (!request || request.kind !== 'question') return;
      const {answer, wasFreeform} = event.data;
      const pending = this.pending.get(event.data.requestId);
      if (answer === undefined) pending?.callback?.reject(new Error('Copilot question was canceled.'));
      else pending?.callback?.resolve({answer, wasFreeform: wasFreeform ?? false});
      this.retire(event.data.requestId, answer === undefined ? {kind: 'question', answers: [], dismissed: true} : {kind: 'question', answers: [{questionId: 'answer', selectedValues: wasFreeform ? [] : [answer], ...(wasFreeform ? {customText: answer} : {})}]});
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
  private open(request: AgentInteractionRequest, owner?: string | null, toolCallId?: string): void {
    if (this.pending.has(request.requestId)) return;
    this.pending.set(request.requestId, {request, owner, toolCallId, submitting: false});
    this.emit({type: 'interaction_requested', provider, request});
  }
  private retire(requestId: string, response?: AgentInteractionResponse): void {
    const pending = this.pending.get(requestId); if (!pending) return;
    this.pending.delete(requestId);
    if (!response) pending.callback?.reject(new Error('Copilot question was canceled.'));
    const terminal = response ?? (pending.request.kind === 'question' ? {kind: 'question' as const, answers: [], dismissed: true} : {kind: 'tool_approval' as const, decision: 'cancel' as const});
    this.emit({type: 'interaction_resolved', provider, requestId, response: terminal});
  }
  cancelOwner(owner?: string | null, toolCallId?: string): void { for (const [id, pending] of this.pending) if (pending.owner === owner) this.retire(id); }
  dispose(): void { for (const id of this.pending.keys()) this.retire(id); }
  async respond(requestId: string, response: AgentInteractionResponse): Promise<void> {
    const pending = this.pending.get(requestId); if (!pending) throw new Error('Unknown Copilot interaction.');
    if (pending.submitting) throw new Error('Copilot interaction response is already pending.');
    validateInteractionResponse(pending.request, response); pending.submitting = true;
    try {
      if (response.kind === 'question') {
        if (!pending.callback) throw new Error('Copilot native question callback is not available.');
        const answer = response.answers[0]!;
        pending.callback.resolve({answer: answer.customText ?? answer.selectedValues[0]!, wasFreeform: answer.customText !== undefined});
        this.retire(requestId, response); return;
      }
      const result = response.kind === 'tool_approval'
        ? await this.call(this.rpc().permissions.handlePendingPermissionRequest({requestId, result: response.decision === 'allow' ? {kind: 'approve-once', approvedInteractively: true} : {kind: 'reject'}}), 'Respond to Copilot permission')
        : undefined;
      if (!result?.success) { this.retire(requestId); throw new Error('Copilot interaction is no longer pending.'); }
      this.retire(requestId, response);
    } finally { pending.submitting = false; }
  }
}
