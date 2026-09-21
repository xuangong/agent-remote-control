import { DshCommands } from './commands.js';
import { DshSessionSettings } from './session-settings.js';
import { validateInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type {
  AgentCommand,
  AgentCommandResult,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentRuntimeInfo,
  AgentSessionConfig,
} from '@orchardworks/agent-provider-sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';

import type { DshImageReference } from './content.js';
import { dshIdentifier, isRecord, safeNonNegativeInteger, type DshNativeObservation } from './native.js';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';

import type { DshWebInteractionAdapter } from './web-interactions.js';

export interface AgentRuntimeInfoValue {
  readonly status: AgentRuntimeInfo['status'];
  readonly cwd?: string;
  readonly model?: string | null;
  readonly planning?: { active: boolean; requested?: boolean };
  readonly settings?: import('@orchardworks/agent-provider-sdk').AgentSessionSetting[];
}

export interface DshOwnedRuntimeFeatures {
  readonly commands?: boolean;
  readonly planning?: boolean;
  readonly sessionSettings?: boolean;
  readonly steer: boolean;
  readonly cancel: boolean;
  readonly readResource: boolean;
  readonly interactions: {
    readonly question: boolean;
    readonly planApproval: boolean;
    readonly toolApproval: boolean;
  };
}

export interface DshStoredImage {
  data: Uint8Array;
  mediaType: string;
}

export interface DshOwnedAgent {
  readonly sessionId: string;
  readonly borrowed: boolean;
  readonly events: readonly DshNativeObservation[];
  readonly runtimeInfo: AgentRuntimeInfoValue;
  readonly features: DshOwnedRuntimeFeatures;
  subscribe(listener: (record: DshNativeObservation) => void): () => void;
  followup(text: string): void;
  steer(text: string): void;
  cancel(): boolean;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
  setPlanning?(active: boolean): void;
  loadSettings?(): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): boolean | Promise<boolean>;
  readImage(reference: DshImageReference): Promise<DshStoredImage>;
  readDocumentation?(locator: string): Promise<import('@orchardworks/agent-provider-sdk').AgentResourceReadResult>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DshRuntime {
  create(config: AgentSessionConfig): Promise<DshOwnedAgent>;
  resume(handle: AgentPersistenceHandle): Promise<DshOwnedAgent>;
  borrow(agent: Agent): Promise<DshOwnedAgent>;
  dispose?(): Promise<void>;
}

export type DshRuntimeSetupRequest =
  | { readonly kind: 'create'; readonly config: AgentSessionConfig }
  | { readonly kind: 'resume'; readonly handle: AgentPersistenceHandle };

const interactionWrapperOwner = Symbol('dshNativeInteractionWrapper');
const localInteractionAborts = new WeakMap<AbortSignal, AbortController>();

export interface CordisDshRuntimeOptions {
  readonly context: Context;
  readonly interactions?: DshWebInteractionAdapter;
  readonly setup?: (agentContext: Context, request: DshRuntimeSetupRequest) => ReturnType<AgentSetup>;
}

interface RuntimeContext {
  get(name: string): unknown;
  on(event: string, listener: (...args: never[]) => unknown): () => void;
}

interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

interface PendingInteraction {
  request: AgentInteractionRequest;
  resolveNative(response: AgentInteractionResponse): void;
  cancelNative(): void;
}

interface PendingInteractionState extends PendingInteraction {
  requestRecord: DshNativeObservation;
  turnId: string | undefined;
}

/** Bridges native DSH interaction requests so either the Web client or Borgee can settle one pending prompt. */
export function installDshNativeInteractionBridge(context: Context): () => void {
  const root = context as unknown as RuntimeContext;
  const restorers = [
    wrapInteractionService(root.get('userQuestions'), 'ask'),
    wrapInteractionService(root.get('approval'), 'request'),
  ].filter((restore): restore is () => void => restore !== undefined);
  return () => {
    let failure: unknown;
    for (const restore of restorers.reverse()) {
      try { restore(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  };
}

function wrapInteractionService(service: unknown, method: 'ask' | 'request'): (() => void) | undefined {
  if (!isRecord(service) || typeof service[method] !== 'function') return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(service, method);
  const original = service[method] as (this: object, request: { signal?: AbortSignal }) => Promise<unknown>;
  if (Reflect.get(original, interactionWrapperOwner) !== undefined) return undefined;
  const wrapped = async function (this: object, request: { signal?: AbortSignal }): Promise<unknown> {
    const abort = new AbortController();
    const callerSignal = request.signal;
    const abortFromCaller = (): void => abort.abort(callerSignal?.reason);
    if (callerSignal) callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    if (callerSignal?.aborted) abortFromCaller();
    localInteractionAborts.set(abort.signal, abort);
    try {
      return await original.call(this, { ...request, signal: abort.signal });
    } finally {
      localInteractionAborts.delete(abort.signal);
      callerSignal?.removeEventListener('abort', abortFromCaller);
      abort.abort();
    }
  };
  Object.defineProperty(wrapped, interactionWrapperOwner, { value: original });
  Object.defineProperty(service, method, { ...descriptor, configurable: true, writable: true, value: wrapped });
  return () => {
    if (Reflect.get(service[method] as object, interactionWrapperOwner) !== original) return;
    if (descriptor) Object.defineProperty(service, method, descriptor);
    else delete service[method];
  };
}

export function createCordisDshRuntime(options: CordisDshRuntimeOptions): DshRuntime {
  return new CordisDshRuntime(options);
}

class CordisDshRuntime implements DshRuntime {
  private readonly owners = new WeakMap<Agent, CordisDshOwnedAgent>();
  private activeOwners = 0;
  private bindingsInitialized = false;
  private questionBound = false;
  private toolApprovalBound = false;
  private disposeQuestions: (() => void) | undefined;
  private stopApprovals: (() => void) | undefined;
  private disposed = false;
  private questionSequence = 0;
  private approvalSequence = 0;

  constructor(private readonly options: CordisDshRuntimeOptions) { this.ensureBindings(); }

  async create(config: AgentSessionConfig): Promise<DshOwnedAgent> {
    this.assertActive();
    const handle = await this.options.context.agents.create({
      sessionId: SessionId(config.sessionId),
      ...(config.cwd ? { meta: { cwd: config.cwd } } : {}),
      ...(config.model ? { agentOptions: { model: config.model } } : {}),
      ...(this.options.setup
        ? { setup: (agentContext: Context) => this.options.setup?.(agentContext, { kind: 'create', config }) }
        : {}),
    });
    const owned = await this.ownOrDispose(handle);
    try {
      if (config.planning === true && !owned.features.planning) throw new Error('DSH planning control is unsupported.');
      if (config.planning !== undefined && owned.features.planning) owned.setPlanning?.(config.planning);
      return owned;
    } catch (error) {
      await owned.dispose();
      throw error;
    }
  }

  async resume(handle: AgentPersistenceHandle): Promise<DshOwnedAgent> {
    this.assertActive();
    const owned = await this.options.context.agents.resume({
      resumeSessionId: SessionId(handle.sessionId),
      ...(this.options.setup
        ? { setup: (agentContext: Context) => this.options.setup?.(agentContext, { kind: 'resume', handle }) }
        : {}),
    });
    return this.ownOrDispose(owned);
  }

  async borrow(agent: Agent): Promise<DshOwnedAgent> {
    this.assertActive();
    return this.own({ agent, dispose: async () => undefined } as AgentHandle, true);
  }

  private own(handle: AgentHandle, borrowed = false): DshOwnedAgent {
    this.ensureBindings();
    this.activeOwners += 1;
    try {
      const tools = readToolService(scopedService(this.options.context, handle.agent, 'tools'));
      const questionAvailable = this.options.interactions !== undefined || this.questionBound;
      const approvalAvailable = this.options.interactions !== undefined || this.toolApprovalBound;
      const features: DshOwnedRuntimeFeatures = {
        planning: readPlanningService(scopedService(this.options.context, handle.agent, 'planMode')) !== undefined,
        steer: true,
        cancel: true,
        readResource: readAttachmentService(scopedService(this.options.context, handle.agent, 'attachments')) !== undefined,
        interactions: {
          question: questionAvailable && tools?.get('ask_user_question', handle.agent) !== undefined,
          planApproval: questionAvailable && tools?.get('exit_plan_mode', handle.agent) !== undefined,
          toolApproval: approvalAvailable && (tools?.schemas(handle.agent).length ?? 0) > 0,
        },
      };
      const owned = new CordisDshOwnedAgent(this.options.context, handle, features, borrowed, () => {
        this.owners.delete(handle.agent);
        this.activeOwners -= 1;
      }, this.options.interactions);
      this.owners.set(handle.agent, owned);
      return owned;
    } catch (error) {
      this.activeOwners -= 1;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.activeOwners !== 0) throw new Error('Cannot dispose the DSH runtime while it owns active sessions.');
    this.disposed = true;
    this.releaseBindings();
  }

  private async ownOrDispose(handle: AgentHandle): Promise<DshOwnedAgent> {
    try {
      return this.own(handle);
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  private ensureBindings(): void {
    if (this.options.interactions) return;
    if (this.bindingsInitialized || this.disposed) return;
    this.bindingsInitialized = true;
    const context = this.options.context as unknown as RuntimeContext;
    if (context.get('userQuestions') !== undefined) try {
      const stop = context.on('user-questions/request', ((request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => {
        const owner = request.agent === undefined ? undefined : this.owners.get(request.agent);
        return owner ? this.askQuestions(owner, request, next) : next();
      }) as never);
      if (typeof stop === 'function') {
        this.disposeQuestions = stop;
        this.questionBound = true;
      }
    } catch {
      this.disposeQuestions = undefined;
      this.questionBound = false;
    }
    if (context.get('approval') !== undefined) try {
      const stop = context.on('approval/request', ((request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
        const owner = this.owners.get(request.agent);
        return owner ? this.askApproval(owner, request, next) : next();
      }) as never);
      if (typeof stop === 'function') {
        this.stopApprovals = stop;
        this.toolApprovalBound = true;
      }
    } catch {
      this.stopApprovals = undefined;
      this.toolApprovalBound = false;
    }
  }

  private releaseBindings(): void {
    const disposeQuestions = this.disposeQuestions;
    const stopApprovals = this.stopApprovals;
    this.disposeQuestions = undefined;
    this.stopApprovals = undefined;
    this.questionBound = false;
    this.toolApprovalBound = false;
    this.bindingsInitialized = false;
    let failure: unknown;
    try {
      disposeQuestions?.();
    } catch (error) {
      failure = error;
    }
    try {
      stopApprovals?.();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('DSH runtime is disposed.');
  }

  private askQuestions(
    owner: CordisDshOwnedAgent,
    request: AskUserQuestionRequest,
    next?: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const question = request.questions.length === 1 && request.questions[0]?.intent?.kind === 'plan-review'
      ? request.questions[0]
      : undefined;
    const requestId = question ? `dsh-plan:${owner.sessionId}:${++this.questionSequence}` : `dsh-question:${owner.sessionId}:${++this.questionSequence}`;
    const normalized: AgentInteractionRequest = question
      ? {
        kind: 'plan_approval', requestId, plan: question.detail ?? '',
        allowedActions: ['approve_and_resume', 'reject'],
      }
      : {
        kind: 'question', requestId,
        questions: request.questions.map((item) => ({
          questionId: item.id, header: item.header ?? item.question, prompt: item.question,
          ...(item.detail ? { description: item.detail } : {}), required: true,
          selection: item.multiSelect ? 'multiple' : 'single',
          options: (item.options ?? []).map((option) => ({ value: option.label, label: option.label,
            ...(option.description ? { description: option.description } : {}) })),
          allowCustomText: true, allowDismiss: false,
        })),
      };
    const borgee = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      owner.requestInteraction({
        request: normalized,
        resolveNative(response) {
          if (question) {
            if (response.kind !== 'plan_approval') { reject(new Error('DSH plan review received an incompatible response.')); return; }
            const selected = response.action === 'reject'
              ? (question.options ?? []).find(({ label }) => label !== question.intent?.approve)?.label
              : question.intent?.approve;
            resolve({ answers: [{ id: question.id, selected: selected ? [selected] : [],
              ...(response.action === 'reject' && response.feedback !== undefined ? { custom: response.feedback } : {}) }] });
            return;
          }
          if (response.kind !== 'question') { reject(new Error('DSH question received an incompatible response.')); return; }
          resolve({ answers: response.answers.map((answer) => ({ id: answer.questionId, selected: answer.selectedValues,
            ...(answer.customText === undefined ? {} : { custom: answer.customText }) })) });
        },
        cancelNative: () => reject(request.signal?.reason ?? new Error(question ? 'DSH plan review was canceled.' : 'DSH question was canceled.')),
      }, request.signal);
    });
    return this.raceWebAnswer(owner, requestId, request.signal, borgee, next);
  }


  private askApproval(owner: CordisDshOwnedAgent, request: ApprovalRequest, next?: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const requestId = `dsh-tool-approval:${owner.sessionId}:${++this.approvalSequence}`;
    const reason = request.reason ?? `Approve DSH tool ${request.toolName}`;
    const normalized: AgentInteractionRequest = {
      kind: 'tool_approval',
      requestId,
      toolCallId: request.callId ?? `uncorrelated:${requestId}`,
      toolName: request.toolName,
      summary: reason,
      detail: { type: 'other', description: reason },
      allowedDecisions: ['allow', 'deny'],
      allowScopes: ['once'],
    };
    const borgee = new Promise<ApprovalOutcome>((resolve) => {
      owner.requestInteraction({
        request: normalized,
        resolveNative(response) {
          resolve(response.kind === 'tool_approval' && response.decision === 'allow' && response.scope === 'once'
            ? 'allowed-once'
            : 'rejected');
        },
        cancelNative: () => resolve('cancelled'),
      }, request.signal);
    });
    return this.raceWebAnswer(owner, requestId, request.signal, borgee, next);
  }

  private raceWebAnswer<T>(
    owner: CordisDshOwnedAgent,
    requestId: string,
    signal: AbortSignalLike | undefined,
    borgee: Promise<T>,
    next: (() => Promise<T>) | undefined,
  ): Promise<T> {
    if (!next || !(signal instanceof AbortSignal) || !localInteractionAborts.has(signal)) return borgee;
    const web = Promise.resolve().then(next).then((answer) => {
      owner.cancelInteraction(requestId);
      return answer;
    });
    return Promise.race([borgee.then((answer) => {
      localInteractionAborts.get(signal)?.abort();
      return answer;
    }), web]);
  }
}

class CordisDshOwnedAgent implements DshOwnedAgent {
  readonly features: DshOwnedRuntimeFeatures;
  private readonly settings: DshSessionSettings;
  private readonly commands: DshCommands;
  private readonly commandRequests = new Map<string, DshNativeObservation>();
  private changingSetting = false;
  private readonly listeners = new Set<(record: DshNativeObservation) => void>();
  private readonly pending = new Map<string, PendingInteractionState>();
  private readonly stopSessionEvents: () => unknown;
  private readonly stopSharedInteractions: (() => void) | undefined;
  private interactionOrdinal = 0;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly context: Context,
    private readonly handle: AgentHandle,
    features: DshOwnedRuntimeFeatures,
    readonly borrowed: boolean,
    private readonly releaseOwner: () => void,
    private readonly sharedInteractions?: DshWebInteractionAdapter,
  ) {
    this.settings = new DshSessionSettings(handle.agent, (name) => scopedService(context, handle.agent, name));
    this.commands = new DshCommands(handle.agent, (name) => scopedService(context, handle.agent, name), this.settings, (event) => {
      if (event.type === 'interaction_requested') {
        const record = this.interactionRecord('interaction_requested', event.request, undefined, undefined);
        this.commandRequests.set(event.request.requestId, record);
        this.publish(record);
      } else if (event.type === 'interaction_resolved') {
        this.commandRequests.delete(event.requestId);
        this.publish(this.interactionRecord('interaction_resolved', event.response, event.requestId, undefined));
      }
    }, () => this.assertCommandIdle());
    this.features = { ...features, readResource: features.readResource || this.commands.documentsSupported, sessionSettings: this.settings.supported, commands: this.commands.supported,
      interactions: { ...features.interactions, question: features.interactions.question || this.commands.supported } };
    this.stopSessionEvents = context.on('session/event', (session, event) => {
      if (session === handle.agent.session) this.publish(sessionObservation(this.sessionId, event));
    });
    try {
      this.stopSharedInteractions = sharedInteractions?.subscribe(this.sessionId, (record) => this.publish(record));
    } catch (error) {
      this.stopSessionEvents();
      throw error;
    }
  }

  get sessionId(): string { return this.handle.agent.session.id; }

  get events(): readonly DshNativeObservation[] {
    const history = this.handle.agent.session.snapshotEvents().map((event) => sessionObservation(this.sessionId, event));
    const interactions = [
      ...this.commandRequests.values(),
      ...[...this.pending.values()].map(({ requestRecord }) => requestRecord),
      ...(this.sharedInteractions?.events(this.sessionId) ?? []),
    ];
    return interleaveHistory(history, interactions);
  }

  get runtimeInfo(): AgentRuntimeInfoValue {
    const agent = this.handle.agent;
    const state = readPlanningService(scopedService(this.context, agent, 'planMode'))?.get(agent);
    return {
      status: agent.status === 'running' ? 'running' : 'idle',
      ...(agent.session.header.cwd ? { cwd: agent.session.header.cwd } : {}),
      model: this.settings.currentModel() ?? requestModel(agent) ?? agent.options.model ?? null,
      ...(this.settings.supported ? { settings: this.settings.describe() } : {}),
      ...(state ? { planning: {
        active: state.active,
        ...(state.pending !== undefined ? { requested: state.pending } : {}),
      } } : {}),
    };
  }

  loadSettings(): Promise<void> { return this.settings.load(); }

  listCommands(): Promise<AgentCommand[]> { return this.commands.list(); }
  readDocumentation(locator: string): Promise<import('@orchardworks/agent-provider-sdk').AgentResourceReadResult> { return this.commands.readDocumentation(locator); }
  executeCommand(id: string, args: string): Promise<AgentCommandResult> { return this.commands.execute(id, args); }

  private assertCommandIdle(): void {
    if (this.disposePromise) throw new Error('DSH session is closed.');
    if (this.changingSetting || currentDshTurn(this.handle.agent.session.snapshotEvents()) !== undefined || this.handle.agent.status === 'running') {
      throw new Error('DSH commands can only execute while idle.');
    }
    if (this.pending.size > 0 || this.sharedInteractions?.hasPending(this.sessionId)) throw new Error('DSH commands cannot execute with pending interactions.');
  }

  async setSessionSetting(id: string, value: string): Promise<void> {
    if (this.disposePromise) throw new Error('DSH session is closed.');
    if (this.changingSetting || currentDshTurn(this.handle.agent.session.snapshotEvents()) !== undefined || this.handle.agent.status === 'running') {
      throw new Error('DSH settings can only change while idle.');
    }
    if (this.commands.pending || this.pending.size > 0 || this.sharedInteractions?.hasPending(this.sessionId)) throw new Error('DSH settings cannot change with pending interactions.');
    this.changingSetting = true;
    try { await this.settings.select(id, value); }
    finally { this.changingSetting = false; }
  }

  setPlanning(active: boolean): void {
    if (this.disposePromise) throw new Error('DSH session is closed.');
    const service = readPlanningService(scopedService(this.context, this.handle.agent, 'planMode'));
    if (!service) throw new Error('DSH planning control is unsupported.');
    if (currentDshTurn(this.handle.agent.session.snapshotEvents()) !== undefined || this.handle.agent.status === 'running') {
      throw new Error('DSH planning can only change while idle.');
    }
    if (this.commands.pending || this.pending.size > 0 || this.sharedInteractions?.hasPending(this.sessionId)) throw new Error('DSH planning cannot change with pending interactions.');
    service.set(this.handle.agent, active);
  }

  subscribe(listener: (record: DshNativeObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  followup(text: string): void {
    if (this.commands.pending) throw new Error('A DSH command or interaction is pending.');
    this.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  }

  steer(text: string): void {
    if (this.commands.pending) throw new Error('A DSH command or interaction is pending.');
    this.handle.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  }

  cancel(): boolean {
    const commandCanceled = this.commands.cancel();
    for (const [requestId, record] of this.commandRequests) {
      const request = (record.payload as { request: AgentInteractionRequest }).request;
      this.publish(this.interactionRecord('interaction_resolved', cancellationResponse(request), requestId, undefined));
    }
    this.commandRequests.clear();
    if (this.handle.agent.status !== 'running') return commandCanceled;
    this.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    return true;
  }

  respondToInteraction(requestId: string, response: AgentInteractionResponse): boolean | Promise<boolean> {
    if (this.disposePromise) throw new Error('DSH session is closed.');
    if (this.commandRequests.has(requestId)) return this.commands.respond(requestId, response);
    if (this.sharedInteractions) return this.sharedInteractions.respond(this.sessionId, requestId, response);
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.kind !== response.kind) return false;
    validateDshInteractionResponse(pending.request, response);
    this.pending.delete(requestId);
    this.publish(this.interactionRecord('interaction_resolved', response, requestId, pending.turnId));
    pending.resolveNative(response);
    return true;
  }

  cancelInteraction(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.cancelNative();
    this.publish(this.interactionRecord('interaction_resolved', cancellationResponse(pending.request), requestId, pending.turnId));
  }

  async readImage(reference: DshImageReference): Promise<DshStoredImage> {
    const attachments = readAttachmentService(scopedService(this.context, this.handle.agent, 'attachments'));
    if (!attachments) throw new Error('DSH attachment service is unavailable.');
    const stored = await attachments.readImage(reference);
    return { data: stored.data, mediaType: stored.ref.mediaType };
  }

  async flush(): Promise<void> {
    await this.context.sessions.flush(this.handle.agent.session);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.commands.dispose();
    this.commandRequests.clear();
    this.disposePromise = (async () => {
      let failure: unknown;
      try {
        this.releaseOwner();
      } catch (error) {
        failure = error;
      }
      try {
        this.stopSessionEvents();
      } catch (error) {
        failure ??= error;
      }
      try {
        this.stopSharedInteractions?.();
      } catch (error) {
        failure ??= error;
      }
      for (const pending of this.pending.values()) {
        try {
          pending.cancelNative();
        } catch (error) {
          failure ??= error;
        }
      }
      this.pending.clear();
      this.listeners.clear();
      if (!this.borrowed) {
        try {
          await this.handle.dispose();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    })();
    return this.disposePromise;
  }

  requestInteraction(pending: PendingInteraction, signal?: AbortSignalLike): void {
    const requestId = pending.request.requestId;
    if (signal?.aborted) {
      pending.cancelNative();
      return;
    }
    const turnId = this.currentTurn();
    const requestRecord = this.interactionRecord('interaction_requested', pending.request, undefined, turnId);
    const pendingState: PendingInteractionState = { ...pending, requestRecord, turnId };
    this.pending.set(requestId, pendingState);
    const onAbort = (): void => {
      if (!this.pending.delete(requestId)) return;
      pendingState.cancelNative();
      this.publish(this.interactionRecord('interaction_resolved', cancellationResponse(pendingState.request), requestId, pendingState.turnId));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.publish(requestRecord);
  }

  private interactionRecord(
    kind: 'interaction_requested',
    request: AgentInteractionRequest,
    requestId: undefined,
    turnId: string | undefined,
  ): DshNativeObservation;
  private interactionRecord(
    kind: 'interaction_resolved',
    response: AgentInteractionResponse,
    requestId: string,
    turnId: string | undefined,
  ): DshNativeObservation;
  private interactionRecord(
    kind: 'interaction_requested' | 'interaction_resolved',
    value: AgentInteractionRequest | AgentInteractionResponse,
    requestId?: string,
    turnId?: string,
  ): DshNativeObservation {
    const ordinal = ++this.interactionOrdinal;
    return {
      recordId: `${kind}:${requestId ?? (value as AgentInteractionRequest).requestId}:${ordinal}`,
      occurredAt: Date.now(),
      kind,
      payload: kind === 'interaction_requested'
        ? { request: value, ...(turnId ? { turnId } : {}) }
        : { requestId, response: value, ...(turnId ? { turnId } : {}) },
    };
  }

  private currentTurn(): string | undefined {
    return currentDshTurn(this.handle.agent.session.snapshotEvents());
  }

  private publish(record: DshNativeObservation): void {
    for (const listener of this.listeners) listener(record);
  }
}

function interleaveHistory(
  native: readonly DshNativeObservation[],
  interactions: readonly DshNativeObservation[],
): DshNativeObservation[] {
  const history: DshNativeObservation[] = [];
  let interactionIndex = 0;
  // Native sequence and journal order remain authoritative when wall clocks tie or regress.
  for (const record of native) {
    const timestamp = safeNonNegativeInteger(record.occurredAt) ?? 0;
    while (interactionIndex < interactions.length
      && (safeNonNegativeInteger(interactions[interactionIndex]!.occurredAt) ?? 0) < timestamp) {
      history.push(interactions[interactionIndex++]!);
    }
    history.push(record);
  }
  return history.concat(interactions.slice(interactionIndex));
}

function sessionObservation(sessionId: string, event: SessionEvent): DshNativeObservation {
  return {
    recordId: `dsh:${sessionId}:event:${event.seq}`,
    occurredAt: event.time,
    kind: 'session_event',
    payload: event,
  };
}

function cancellationResponse(request: AgentInteractionRequest): AgentInteractionResponse {
  if (request.kind === 'question') return { kind: 'question', answers: [], dismissed: true };
  if (request.kind === 'plan_approval') return { kind: 'plan_approval', action: 'reject' };
  return { kind: 'tool_approval', decision: 'deny', message: 'DSH approval was canceled.' };
}

function readPlanningService(value: unknown): {
  get(agent: Agent): { active: boolean; pending?: boolean };
  set(agent: Agent, active: boolean): unknown;
} | undefined {
  if (!isRecord(value) || typeof value.get !== 'function' || typeof value.set !== 'function') return undefined;
  return value as never;
}

function scopedService(context: Context, agent: Agent, name: string): unknown {
  const root = context as unknown as RuntimeContext;
  const presets = root.get('agentPresets');
  if (isRecord(presets) && typeof presets.serviceFor === 'function') {
    const service: unknown = presets.serviceFor(agent, name);
    if (service !== undefined) return service;
  }
  const agentContext: unknown = agent.ctx;
  if (isRecord(agentContext) && typeof agentContext.get === 'function') {
    const service: unknown = agentContext.get(name);
    if (service !== undefined) return service;
  }
  return root.get(name);
}

function requestModel(agent: Agent): string | undefined {
  const session = agent.session as unknown as { requestHeader?: () => unknown };
  const header = session.requestHeader?.();
  if (!isRecord(header) || !isRecord(header.config)) return undefined;
  return typeof header.config.model === 'string' ? header.config.model : undefined;
}

function readToolService(value: unknown): {
  get(name: string, agent: Agent): unknown;
  schemas(agent: Agent): readonly unknown[];
} | undefined {
  if (!isRecord(value) || typeof value.get !== 'function' || typeof value.schemas !== 'function') return undefined;
  return value as never;
}

function readAttachmentService(value: unknown): {
  readImage(reference: DshImageReference): Promise<{ ref: DshImageReference; data: Uint8Array }>;
} | undefined {
  if (!isRecord(value) || typeof value.readImage !== 'function') return undefined;
  return value as never;
}

export function currentDshTurn(events: readonly SessionEvent[]): string | undefined {
  let current: string | undefined;
  for (const event of events) {
    const data: unknown = event.data;
    if (!isRecord(data)) continue;
    const turnId = dshIdentifier(data.turn);
    if (event.type === 'turn/start' && turnId) current = turnId;
    if (event.type === 'turn/end' && turnId === current) current = undefined;
  }
  return current;
}

export function validateDshInteractionResponse(
  request: AgentInteractionRequest,
  response: AgentInteractionResponse,
): void {
  if (request.kind === 'question' && response.kind === 'question') {
    const questions = new Map(request.questions.map((question) => [question.questionId, question]));
    const answered = new Set<string>();
    for (const answer of response.answers) {
      const question = questions.get(answer.questionId);
      if (!question || answered.has(answer.questionId)) throw new Error(`Invalid DSH answer for question ${answer.questionId}`);
      answered.add(answer.questionId);
      const options = new Set(question.options.map(({ value }) => value));
      if (answer.selectedValues.some((value) => !options.has(value))) {
        throw new Error(`Invalid DSH answer option for question ${answer.questionId}`);
      }
      if (!question.allowCustomText && answer.customText !== undefined) {
        throw new Error(`DSH question ${answer.questionId} does not allow custom text`);
      }
      if (question.selection === 'single' && answer.selectedValues.length > 1) {
        throw new Error(`DSH question ${answer.questionId} accepts one option`);
      }
      if (question.required && answer.selectedValues.length === 0 && !validCustomAnswer(question.allowCustomText, answer.customText)) {
        throw new Error(`DSH question ${answer.questionId} requires an answer`);
      }
    }
    if (response.dismissed) {
      if (request.questions.some(({ allowDismiss }) => !allowDismiss)) {
        throw new Error('DSH question does not allow dismissal');
      }
      validateInteractionResponse(request, response);
      return;
    }
    for (const question of request.questions) {
      if (question.required && !answered.has(question.questionId)) {
        throw new Error(`DSH question ${question.questionId} requires an answer`);
      }
    }
    validateInteractionResponse(request, response);
    return;
  }
  if (request.kind === 'plan_approval' && response.kind === 'plan_approval') {
    if (!request.allowedActions.includes(response.action)) throw new Error(`Unsupported DSH plan action ${response.action}`);
    if (response.action !== 'reject' && 'feedback' in response) throw new Error('DSH plan approval cannot include revision feedback.');
    validateInteractionResponse(request, response);
    return;
  }
  if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
    if (!request.allowedDecisions.includes(response.decision)) throw new Error(`Unsupported DSH tool decision ${response.decision}`);
    if (response.decision === 'allow' && !request.allowScopes.includes(response.scope)) {
      throw new Error(`Unsupported DSH tool approval scope ${response.scope}`);
    }
    validateInteractionResponse(request, response);
    return;
  }
  throw new Error(`DSH interaction ${request.requestId} requires a ${request.kind} response`);
}

function validCustomAnswer(allowed: boolean, value: string | undefined): boolean {
  return allowed && typeof value === 'string' && value.trim().length > 0;
}
