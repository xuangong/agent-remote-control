import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { validateInteractionResponse, type AgentInteractionRequest, type AgentInteractionResponse, type AgentStreamEvent } from '@agent-remote-controller/agent-provider-sdk';
import { record, toolDetail } from './projector.js';

interface Pending { responding?: boolean; request: AgentInteractionRequest; input: Record<string, unknown>; resolve(result: PermissionResult): void; cleanup(): void }

export class ClaudeInteractions {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly emit: (event: AgentStreamEvent) => void, private readonly approvePlan?: () => Promise<void>) {}
  get size(): number { return this.pending.size; }

  readonly request: CanUseTool = async (name, input, options) => {
    if (this.closed || options.signal.aborted) return { behavior: 'deny', message: 'Permission request is no longer active.' };
    const requestId = `claude:${options.toolUseID}:${randomUUID()}`;
    if (name === 'ExitPlanMode' && (typeof input.plan !== 'string' || !input.plan.trim() || !this.approvePlan)) {
      return { behavior: 'deny', message: 'A native plan body and permission transition are required for review.' };
    }
    const request: AgentInteractionRequest | undefined = name === 'ExitPlanMode'
      ? { kind: 'plan_approval', requestId, plan: input.plan as string, allowedActions: ['approve_and_resume', 'reject'] }
      : name === 'AskUserQuestion' ? questions(requestId, input) : undefined;
    if (name === 'AskUserQuestion' && !request) return { behavior: 'deny', message: 'Unsupported question format.' };
    const normalized: AgentInteractionRequest = request ?? { kind: 'tool_approval', requestId, toolCallId: options.toolUseID,
      toolName: name, summary: options.title || options.decisionReason || `Allow ${name}?`, detail: toolDetail(name, input),
      allowedDecisions: ['allow', 'deny', 'cancel'], allowScopes: ['once'] };
    return new Promise<PermissionResult>((resolve) => {
      const abort = () => this.cancel(requestId);
      this.pending.set(requestId, { request: normalized, input, resolve, cleanup: () => options.signal.removeEventListener('abort', abort) });
      options.signal.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'interaction_requested', provider: 'claude', request: normalized });
      if (options.signal.aborted) abort();
    });
  };

  respond(requestId: string, response: AgentInteractionResponse): void | Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('Claude permission request is no longer active.');
    if (pending.responding) throw new Error('Claude permission response is already in progress.');
    validateInteractionResponse(pending.request, response);
    if (response.kind === 'plan_approval') {
      if (response.action === 'reject') {
        this.finish(requestId, response, { behavior: 'deny', message: response.feedback || 'The user rejected the plan.' });
        return;
      }
      pending.responding = true;
      return this.resolvePlan(requestId, pending, response);
    }
    let result: PermissionResult;
    if (response.kind === 'tool_approval') {
      result = response.decision === 'allow' ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: response.message || 'The user declined this tool.', ...(response.decision === 'cancel' ? { interrupt: true } : {}) };
    } else if (response.kind === 'question' && pending.request.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const answer of response.answers) {
        const question = pending.request.questions.find(({ questionId }) => questionId === answer.questionId)!;
        answers[question.prompt] = [...answer.selectedValues, ...(answer.customText ? [answer.customText] : [])].join(', ');
      }
      result = response.dismissed ? { behavior: 'deny', message: 'The user dismissed the questions.' }
        : { behavior: 'allow', updatedInput: { ...pending.input, answers } };
    } else throw new Error('Unsupported Claude interaction response.');
    this.finish(requestId, response, result);
  }

  private async resolvePlan(id: string, pending: Pending, response: AgentInteractionResponse): Promise<void> {
    try {
      await this.approvePlan!();
      if (this.pending.get(id) !== pending) throw new Error('Claude permission request is no longer active.');
      this.finish(id, response, { behavior: 'allow', updatedInput: pending.input });
    } finally { pending.responding = false; }
  }

  cancelAll(): void { for (const id of [...this.pending.keys()]) this.cancel(id); }
  close(): void { this.closed = true; this.cancelAll(); }
  private cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const response: AgentInteractionResponse = pending.request.kind === 'question'
      ? { kind: 'question', answers: [], dismissed: true } : pending.request.kind === 'plan_approval'
        ? { kind: 'plan_approval', action: 'reject', feedback: 'The plan review was canceled.' }
        : { kind: 'tool_approval', decision: 'cancel' };
    this.finish(id, response, { behavior: 'deny', message: 'The permission request was canceled.', interrupt: true });
  }
  private finish(id: string, response: AgentInteractionResponse, result: PermissionResult): void {
    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    pending.cleanup();
    this.emit({ type: 'interaction_resolved', provider: 'claude', requestId: id, response });
    pending.resolve(result);
  }
}

function questions(requestId: string, input: Record<string, unknown>): Extract<AgentInteractionRequest, { kind: 'question' }> | undefined {
  if (!Array.isArray(input.questions) || !input.questions.length) return;
  const seen = new Set<string>();
  const result: Extract<AgentInteractionRequest, { kind: 'question' }> = { kind: 'question', requestId, questions: [] };
  for (const [index, question] of input.questions.entries()) {
    if (!record(question) || typeof question.question !== 'string' || !question.question || seen.has(question.question)
      || !Array.isArray(question.options) || question.options.some((option: unknown) => !record(option) || typeof option.label !== 'string')) return;
    seen.add(question.question);
    const options = question.options.map((option: any) => ({ value: option.label, label: option.label,
      ...(typeof option.description === 'string' ? { description: option.description } : {}) }));
    if (new Set(options.map((option: { value: string }) => option.value)).size !== options.length) return;
    result.questions.push({ questionId: `question-${index}`, header: typeof question.header === 'string' ? question.header : 'Question',
      prompt: question.question, required: true, selection: question.multiSelect ? 'multiple' : 'single', options,
      allowCustomText: true, allowDismiss: true });
  }
  return result;
}
