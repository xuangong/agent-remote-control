import type { AgentInteractionRequest, AgentInteractionResponse } from '@borgee/agent-provider-sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';

import type { DshNativeObservation } from './native.js';
import { currentDshTurn, validateDshInteractionResponse } from './runtime.js';

const wrapperOwner = Symbol('dshWebInteractionOwner');

export interface DshWebInteractionAdapter {
  events(sessionId: string): readonly DshNativeObservation[];
  subscribe(sessionId: string, listener: (record: DshNativeObservation) => void): () => void;
  hasPending(sessionId: string): boolean;
  respond(sessionId: string, requestId: string, response: AgentInteractionResponse): Promise<boolean>;
  dispose(): Promise<void>;
}

type NativeResponse = AskUserQuestionAnswer | ApprovalOutcome;
type PendingResolver = (response: AgentInteractionResponse) => void;

interface PendingInteraction {
  readonly request: AgentInteractionRequest;
  readonly sessionId: string;
  readonly localAbort: AbortController;
  readonly cleanup: () => void;
  readonly resolve: PendingResolver;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
  turnId?: string;
}

interface SignalRequest {
  readonly signal?: AbortSignal;
}

interface InteractionService {
  [method: string]: unknown;
}

/** Shares root-native interaction requests with remote sessions through the public Cordis service broker. */
export function createDshWebInteractionAdapter(context: Context): DshWebInteractionAdapter {
  return new WebInteractionAdapter(context);
}

class WebInteractionAdapter implements DshWebInteractionAdapter {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly journal = new Map<string, DshNativeObservation[]>();
  private readonly listeners = new Map<string, Set<(record: DshNativeObservation) => void>>();
  private readonly localAborts = new WeakMap<AbortSignal, AbortController>();
  private readonly restores: Array<() => void> = [];
  private readonly stops: Array<() => unknown> = [];
  private ordinal = 0;
  private requestOrdinal = 0;
  private disposed = false;

  constructor(private readonly context: Context) {
    const questions = context.get('userQuestions') as unknown as InteractionService | undefined;
    const approvals = context.get('approval') as unknown as InteractionService | undefined;
    const restoreQuestion = this.wrap(questions, 'ask');
    const restoreApproval = this.wrap(approvals, 'request');
    if (restoreQuestion) this.restores.push(restoreQuestion);
    if (restoreApproval) this.restores.push(restoreApproval);
    this.stops.push(context.on('user-questions/request', (request, next) => this.observeQuestion(request, next), true));
    this.stops.push(context.on('approval/request', (request, next) => this.observeApproval(request, next), true));
  }

  events(sessionId: string): readonly DshNativeObservation[] {
    this.assertActive();
    return this.journal.get(sessionId) ?? [];
  }

  subscribe(sessionId: string, listener: (record: DshNativeObservation) => void): () => void {
    this.assertActive();
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  hasPending(sessionId: string): boolean {
    this.assertActive();
    return [...this.pending.values()].some((pending) => pending.sessionId === sessionId && !pending.settled);
  }

  async respond(sessionId: string, requestId: string, response: AgentInteractionResponse): Promise<boolean> {
    this.assertActive();
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId || pending.settled || pending.request.kind !== response.kind) return false;
    validateDshInteractionResponse(pending.request, response);
    if (!this.finish(pending, response)) return false;
    pending.resolve(response);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    let failure: unknown;
    for (const stop of this.stops.splice(0).reverse()) {
      try { stop(); } catch (error) { failure ??= error; }
    }
    for (const restore of this.restores.splice(0).reverse()) {
      try { restore(); } catch (error) { failure ??= error; }
    }
    for (const pending of this.pending.values()) {
      this.pending.delete(pending.request.requestId);
      pending.settled = true;
      pending.cleanup();
      pending.reject(new Error('DSH Web interaction adapter is disposed.'));
      pending.localAbort.abort();
    }
    this.pending.clear();
    this.listeners.clear();
    this.journal.clear();
    if (failure !== undefined) throw failure;
  }

  private observeQuestion(request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    const agent = request.agent;
    if (!agent || !this.isLiveRoot(agent)) return next();
    const interaction = questionRequest(request, ++this.requestOrdinal);
    return this.race(request.signal, agent, interaction, next, (response) => nativeQuestionAnswer(request, response), (answer) => questionResponse(request, answer));
  }

  private observeApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (!this.isLiveRoot(request.agent)) return next();
    const interaction: AgentInteractionRequest = {
      kind: 'tool_approval',
      requestId: `dsh-tool-approval:${request.agent.session.id}:${++this.requestOrdinal}`,
      toolName: request.toolName,
      toolCallId: request.callId ?? `uncorrelated:${request.agent.session.id}:${this.requestOrdinal}`,
      summary: request.reason ?? `Approve DSH tool ${request.toolName}`,
      detail: { type: 'other', description: request.reason ?? `Approve DSH tool ${request.toolName}` },
      allowedDecisions: ['allow', 'deny'],
      allowScopes: ['once'],
    };
    return this.race(request.signal, request.agent, interaction, next, nativeApprovalOutcome, approvalResponse);
  }

  private race<T extends NativeResponse>(
    signal: AbortSignal | undefined,
    agent: Agent,
    request: AgentInteractionRequest,
    next: () => Promise<T>,
    native: (response: AgentInteractionResponse) => T,
    fromWeb: (answer: T) => AgentInteractionResponse,
  ): Promise<T> {
    const localAbort = signal === undefined ? undefined : this.localAborts.get(signal);
    if (!localAbort) return next();
    const sessionId = agent.session.id;
    let pending!: PendingInteraction;
    const remote = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (this.finish(pending, cancellationResponse(request))) {
          reject(signal?.reason ?? new Error('DSH interaction was canceled.'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending = {
        request,
        sessionId,
        localAbort,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
        resolve: (response) => {
          try { resolve(native(response)); } catch (error) { reject(error); }
        },
        reject,
        settled: false,
        turnId: currentTurn(agent),
      };
      this.pending.set(request.requestId, pending);
      this.publish(pending, 'interaction_requested', { request });
    });
    const web = Promise.resolve().then(next).then((answer) => {
      if (isUnavailableNativeAnswer(answer)) return new Promise<T>(() => undefined);
      this.finish(pending, fromWeb(answer));
      return answer;
    }, (error) => {
      if (isUnavailableWebAnswerer(error)) return new Promise<T>(() => undefined);
      throw error;
    });
    return Promise.race([remote, web]);
  }

  private finish(pending: PendingInteraction, response: AgentInteractionResponse): boolean {
    if (pending.settled || !this.pending.delete(pending.request.requestId)) return false;
    pending.settled = true;
    pending.cleanup();
    this.publish(pending, 'interaction_resolved', { requestId: pending.request.requestId, response });
    return true;
  }

  private isLiveRoot(agent: Agent): boolean {
    const agents = this.context.get('agents') as { get(id: string): Agent | undefined; roots(): readonly Agent[] } | undefined;
    return agents?.get(agent.id) === agent && agents.roots().includes(agent);
  }

  private publish(pending: PendingInteraction, kind: DshNativeObservation['kind'], payload: Record<string, unknown>): void {
    const record: DshNativeObservation = {
      recordId: `${kind}:${pending.request.requestId}:${++this.ordinal}`,
      kind,
      occurredAt: Date.now(),
      payload: { ...payload, ...(pending.turnId ? { turnId: pending.turnId } : {}) },
    };
    const journal = this.journal.get(pending.sessionId) ?? [];
    journal.push(record);
    this.journal.set(pending.sessionId, journal);
    for (const listener of this.listeners.get(pending.sessionId) ?? []) listener(record);
  }

  private wrap(service: InteractionService | undefined, method: string): (() => void) | undefined {
    if (!service || typeof service[method] !== 'function') return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(service, method);
    const original = service[method] as (this: InteractionService, request: SignalRequest) => Promise<unknown>;
    if (Reflect.get(original, wrapperOwner) !== undefined) return undefined;
    const localAborts = this.localAborts;
    const wrapped = async function (this: InteractionService, request: SignalRequest): Promise<unknown> {
      const localAbort = new AbortController();
      const callerSignal = request.signal;
      const abortFromCaller = () => localAbort.abort(callerSignal?.reason);
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
      if (callerSignal?.aborted) abortFromCaller();
      localAborts.set(localAbort.signal, localAbort);
      try {
        return await original.call(this, { ...request, signal: localAbort.signal });
      } finally {
        localAborts.delete(localAbort.signal);
        callerSignal?.removeEventListener('abort', abortFromCaller);
        localAbort.abort();
      }
    };
    Object.defineProperty(wrapped, wrapperOwner, { value: this });
    Object.defineProperty(service, method, { ...descriptor, configurable: true, writable: true, value: wrapped });
    return () => {
      if (Reflect.get(service[method] as object, wrapperOwner) !== this) return;
      if (descriptor) Object.defineProperty(service, method, descriptor);
      else delete service[method];
    };
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('DSH Web interaction adapter is disposed.');
  }
}

function questionRequest(request: AskUserQuestionRequest, ordinal: number): AgentInteractionRequest {
  const plan = request.questions.length === 1 && request.questions[0]?.intent?.kind === 'plan-review'
    ? request.questions[0]
    : undefined;
  if (plan) {
    return {
      kind: 'plan_approval',
      requestId: `dsh-plan:${request.agent?.session.id}:${ordinal}`,
      plan: plan.detail ?? '',
      allowedActions: ['approve_and_resume', 'reject'],
    };
  }
  return {
    kind: 'question',
    requestId: `dsh-question:${request.agent?.session.id}:${ordinal}`,
    questions: request.questions.map((question) => ({
      questionId: question.id,
      header: question.header ?? question.question,
      prompt: question.question,
      ...(question.detail ? { description: question.detail } : {}),
      required: true,
      selection: question.multiSelect ? 'multiple' : 'single',
      options: (question.options ?? []).map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      allowCustomText: true,
      allowDismiss: false,
    })),
  };
}

function nativeQuestionAnswer(request: AskUserQuestionRequest, response: AgentInteractionResponse): AskUserQuestionAnswer {
  const plan = request.questions.length === 1 && request.questions[0]?.intent?.kind === 'plan-review'
    ? request.questions[0]
    : undefined;
  if (plan) {
    if (response.kind !== 'plan_approval') throw new Error('DSH plan review received an incompatible response.');
    const selected = response.action === 'reject'
      ? (plan.options ?? []).find(({ label }) => label !== plan.intent?.approve)?.label
      : plan.intent?.approve;
    return {
      answers: [{
        id: plan.id,
        selected: response.action === 'reject' && response.feedback !== undefined ? [] : (selected ? [selected] : []),
        ...(response.action === 'reject' && response.feedback !== undefined ? { custom: response.feedback } : {}),
      }],
    };
  }
  if (response.kind !== 'question') throw new Error('DSH question received an incompatible response.');
  return {
    answers: response.answers.map((answer) => {
      const question = request.questions.find(({ id }) => id === answer.questionId);
      const custom = answer.customText?.trim() ? answer.customText : undefined;
      if (question?.multiSelect !== true && answer.selectedValues.length > 0 && custom !== undefined) {
        return { id: answer.questionId, selected: [], custom: `Selected option: ${answer.selectedValues.join(', ')}\nAdditional response: ${custom}` };
      }
      return { id: answer.questionId, selected: answer.selectedValues, ...(custom === undefined ? {} : { custom }) };
    }),
  };
}

function questionResponse(request: AskUserQuestionRequest, answer: AskUserQuestionAnswer): AgentInteractionResponse {
  const plan = request.questions.length === 1 && request.questions[0]?.intent?.kind === 'plan-review'
    ? request.questions[0]
    : undefined;
  if (plan) {
    const item = answer.answers[0];
    if (!item) return { kind: 'plan_approval', action: 'reject' };
    const approve = plan.intent?.approve;
    const approved = approve !== undefined && item.selected.length === 1 && item.selected[0] === approve && item.custom === undefined;
    return approved
      ? { kind: 'plan_approval', action: 'approve_and_resume' }
      : { kind: 'plan_approval', action: 'reject', ...(item.custom === undefined ? {} : { feedback: item.custom }) };
  }
  return {
    kind: 'question',
    answers: answer.answers.map((item) => ({
      questionId: item.id,
      selectedValues: item.selected,
      ...(item.custom === undefined ? {} : { customText: item.custom }),
    })),
  };
}

function nativeApprovalOutcome(response: AgentInteractionResponse): ApprovalOutcome {
  if (response.kind !== 'tool_approval') throw new Error('DSH approval received an incompatible response.');
  return response.decision === 'allow' ? 'allowed-once' : 'rejected';
}

function approvalResponse(outcome: ApprovalOutcome): AgentInteractionResponse {
  if (outcome === 'allowed-once') return { kind: 'tool_approval', decision: 'allow', scope: 'once' };
  return {
    kind: 'tool_approval',
    decision: 'deny',
    ...(outcome === 'cancelled' ? { message: 'DSH approval was canceled.' } : {}),
  };
}

function cancellationResponse(request: AgentInteractionRequest): AgentInteractionResponse {
  if (request.kind === 'question') return { kind: 'question', answers: [], dismissed: true };
  if (request.kind === 'plan_approval') return { kind: 'plan_approval', action: 'reject' };
  return { kind: 'tool_approval', decision: 'deny', message: 'DSH approval was canceled.' };
}

function currentTurn(agent: Agent): string | undefined {
  return currentDshTurn(agent.session.snapshotEvents());
}

function isUnavailableWebAnswerer(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'NO_PROVIDER';
}

function isUnavailableNativeAnswer(answer: NativeResponse): boolean {
  return answer === 'unavailable';
}
