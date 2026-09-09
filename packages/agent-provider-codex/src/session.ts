import { isDeepStrictEqual } from 'node:util';

import type {
  AgentCapabilities,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentQuestion,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  ProviderObservation,
  ProviderStreamItem,
} from '@borgee/agent-provider-sdk';

import { CodexAppServerRpcError, CodexAppServerTransport } from './app-server-transport.js';
import { collectCodexThreadHistoryItems, projectCodexThreadHistory } from './history.js';
import { isRecord, readItem, readItemId, readString } from './native.js';
import { CodexEventProjector } from './projector.js';
import { readCodexPlanningModes, type CodexPlanningModes } from './planning.js';
import { initializeCodexTransport } from './initialize.js';

const PROVIDER_ID = 'codex';

export const CODEX_CAPABILITIES: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: false,
  planning: false,
  interactions: {
    question: true,
    planApproval: false,
    toolApproval: true,
  },
};

interface StoredSessionConfig {
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  collaborationMode?: 'plan';
}

type NativePendingInteraction =
  | {
      kind: 'plan_approval';
      request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>;
      resolve(value: unknown): void;
    }
  | {
      kind: 'question';
      request: Extract<AgentInteractionRequest, { kind: 'question' }>;
      resolve(value: unknown): void;
    }
  | {
      kind: 'tool_approval';
      request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
      nativeKind: 'command' | 'file';
      resolve(value: unknown): void;
    };

interface RawNotification {
  method: string;
  params: unknown;
}

export class CodexAppServerSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { ...CODEX_CAPABILITIES, interactions: { ...CODEX_CAPABILITIES.interactions } };

  private threadId: string | undefined;
  private projector: CodexEventProjector | undefined;
  private initialItems: ProviderStreamItem[] = [];
  private readonly bufferedNotifications: RawNotification[] = [];
  private readonly preReadyEvents: ProviderObservation[] = [];
  private readonly liveQueue = new AsyncQueue<ProviderStreamItem>();
  private readonly pendingInteractions = new Map<string, NativePendingInteraction>();
  private ready = false;
  private observing = false;
  private disposed = false;
  private transportFailure: Error | undefined;
  private runtimeStatus: AgentRuntimeInfo['status'] = 'starting';
  private runtimeRevision = 0;
  private statusRevision = 0;
  private nativeTurnRevision = 0;
  private readonly observedTurnIds = new Set<string>();
  private planningModes: CodexPlanningModes | undefined;
  private latestPlan: { id: string; text: string } | undefined;
  private startingTurn = false;
  private activeTurnId: string | undefined;

  private constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly config: StoredSessionConfig,
  ) {
    transport.setTerminationHandler((error) => this.handleTransportTermination(error));
    transport.setNotificationHandler((method, params) => this.handleNotification(method, params));
    transport.setRequestHandler('item/tool/requestUserInput', (params, id) => this.handleQuestionRequest(params, id));
    transport.setRequestHandler('tool/requestUserInput', (params, id) => this.handleQuestionRequest(params, id));
    transport.setRequestHandler('item/commandExecution/requestApproval', (params, id) => this.handleToolRequest('command', params, id));
    transport.setRequestHandler('item/fileChange/requestApproval', (params, id) => this.handleToolRequest('file', params, id));
  }

  static async create(
    transport: CodexAppServerTransport,
    config: AgentSessionConfig,
    collaborationMode?: 'plan',
  ): Promise<CodexAppServerSession> {
    const stored = toStoredConfig(config, collaborationMode);
    const session = new CodexAppServerSession(transport, stored);
    await session.initialize();
    const response = await transport.request('thread/start', {
      historyMode: 'paginated',
      ...(stored.model ? { model: stored.model } : {}),
      ...(stored.cwd ? { cwd: stored.cwd } : {}),
      ...(stored.systemPrompt ? { developerInstructions: stored.systemPrompt } : {}),
    });
    session.setThreadFromResponse(response, 'thread/start');
    session.finishBootstrap([], new Map());
    return session;
  }

  static async resume(
    transport: CodexAppServerTransport,
    handle: AgentPersistenceHandle,
    collaborationMode?: 'plan',
  ): Promise<CodexAppServerSession> {
    if (handle.providerId !== PROVIDER_ID) {
      throw new Error(`Cannot resume ${handle.providerId} with the Codex provider`);
    }
    const stored = { ...parseStoredConfig(handle.opaque), ...(collaborationMode ? { collaborationMode } : {}) };
    const session = new CodexAppServerSession(transport, stored);
    session.threadId = handle.sessionId;
    session.projector = new CodexEventProjector(handle.sessionId);
    await session.initialize();
    const resumed = await transport.request('thread/resume', {
      threadId: handle.sessionId,
      ...(stored.cwd ? { cwd: stored.cwd } : {}),
      ...(stored.model ? { model: stored.model } : {}),
      ...(stored.systemPrompt ? { developerInstructions: stored.systemPrompt } : {}),
    });
    session.setThreadFromResponse(resumed, 'thread/resume');
    const history = await transport.request('thread/read', {
      threadId: handle.sessionId,
      includeTurns: true,
    });
    session.finishBootstrap(
      projectCodexThreadHistory(history, handle.sessionId),
      collectCodexThreadHistoryItems(history, handle.sessionId),
    );
    return session;
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observing) throw new Error('Codex session observation already has a consumer');
    this.observing = true;
    const initial = this.initialItems;
    const queue = this.liveQueue;
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of initial) yield item;
        for await (const item of queue) yield item;
      },
    };
  }

  async sendMessage(text: string): Promise<void> {
    this.assertOpen();
    if (this.pendingInteractions.size > 0) throw new Error('Codex has pending interactions');
    await this.startTurn(text);
  }

  async steer(text: string): Promise<void> {
    this.assertOpen();
    if (!this.activeTurnId) throw new Error('Codex has no active turn.');
    if (!text.trim()) throw new Error('Codex message must not be empty.');
    await this.transport.request('turn/steer', {
      threadId: this.threadId, expectedTurnId: this.activeTurnId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    if (!this.activeTurnId) throw new Error('Codex has no active turn.');
    await this.transport.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
  }

  private async startTurn(text: string): Promise<void> {
    this.assertOpen();
    if (!this.threadId) throw new Error('Codex session has no thread');
    if (!text.trim()) throw new Error('Codex message must not be empty');
    if (this.startingTurn || this.runtimeStatus === 'running') throw new Error('A Codex turn is already active');
    const collaborationMode = this.buildCollaborationMode();
    const statusRevision = this.statusRevision;
    this.startingTurn = true;
    try {
      const result = await this.transport.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.reasoningEffort ? { effort: this.config.reasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      if (statusRevision === this.statusRevision && isRecord(result) && isRecord(result.turn) && readString(result.turn.id)) {
        this.runtimeStatus = 'running';
        this.activeTurnId = readString(result.turn.id);
      }
    } finally {
      this.startingTurn = false;
    }
  }

  async setPlanning(active: boolean): Promise<void> {
    this.assertOpen();
    if (!this.planningModes) throw new Error('Codex planning control is unsupported.');
    if (this.startingTurn || this.runtimeStatus !== 'idle') throw new Error('Codex planning can only change while idle.');
    if (this.pendingInteractions.size > 0) throw new Error('Codex planning cannot change with pending interactions.');
    if (active) this.config.collaborationMode = 'plan';
    else delete this.config.collaborationMode;
    this.emitRuntimeUpdate();
  }

  private buildCollaborationMode(): object | undefined {
    if (!this.planningModes) return undefined;
    const selected = this.config.collaborationMode === 'plan' ? this.planningModes.plan : this.planningModes.normal;
    const model = this.config.model ?? selected.model;
    if (!model) throw new Error('Codex collaboration mode requires a model');
    return {
      mode: selected.mode,
      settings: {
        model,
        reasoning_effort: this.config.reasoningEffort ?? selected.reasoningEffort ?? null,
        developer_instructions: this.config.systemPrompt ?? selected.developerInstructions ?? null,
      },
    };
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.assertOpen();
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) throw new Error(`No pending Codex interaction ${requestId}`);
    if (pending.kind !== response.kind) {
      throw new Error(`Codex interaction ${requestId} requires a ${pending.kind} response`);
    }
    if (pending.kind === 'plan_approval' && response.kind === 'plan_approval') {
      await this.respondToPlan(pending.request, response);
      return;
    }
    let nativeResponse: unknown;
    if (pending.kind === 'question' && response.kind === 'question') {
      nativeResponse = this.mapQuestionResponse(pending.request, response);
    } else if (pending.kind === 'tool_approval' && response.kind === 'tool_approval') {
      nativeResponse = this.mapToolResponse(pending, response);
    } else {
      throw new Error(`Unsupported Codex interaction response for ${requestId}`);
    }
    this.pendingInteractions.delete(requestId);
    pending.resolve(nativeResponse);
    this.emitInteractionResolved(requestId, response);
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return this.currentRuntimeInfo();
  }

  private currentRuntimeInfo(): AgentRuntimeInfo {
    return {
      providerId: PROVIDER_ID,
      sessionId: this.threadId ?? null,
      status: this.runtimeStatus,
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      model: this.config.model ?? null,
      mode: this.config.collaborationMode ?? null,
      ...(this.planningModes ? { planning: { active: this.config.collaborationMode === 'plan' } } : {}),
      persistence: this.threadId ? {
        providerId: PROVIDER_ID,
        sessionId: this.threadId,
        opaque: JSON.stringify(this.config),
      } : undefined,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runtimeStatus = 'closed';
    this.resolvePendingInteractions();
    this.liveQueue.close();
    await this.transport.dispose();
  }

  private async initialize(): Promise<void> {
    await initializeCodexTransport(this.transport);
    let modes: unknown;
    try {
      modes = await this.transport.request('collaborationMode/list', {});
    } catch (error) {
      if (!(error instanceof CodexAppServerRpcError) || error.code !== -32601) throw error;
      modes = undefined;
    }
    this.planningModes = readCodexPlanningModes(modes);
    this.capabilities.planning = this.planningModes !== undefined;
    this.capabilities.interactions.planApproval = this.planningModes !== undefined;
    if (this.config.collaborationMode === 'plan' && !this.planningModes) {
      throw new Error('Codex planning control is unsupported by this app-server.');
    }
  }

  private setThreadFromResponse(response: unknown, method: string): void {
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new Error(`Codex ${method} returned no thread`);
    }
    const threadId = readString(response.thread.id);
    if (!threadId) throw new Error(`Codex ${method} returned no thread id`);
    this.threadId = threadId;
    this.projector = new CodexEventProjector(threadId);
    if (!this.config.model) this.config.model = readString(response.model);
    if (!this.config.cwd) this.config.cwd = readString(response.cwd);
    if (!this.config.reasoningEffort) this.config.reasoningEffort = readString(response.reasoningEffort);
  }

  private finishBootstrap(
    history: ProviderObservation[],
    historyItems: ReadonlyMap<string, Record<string, unknown>>,
  ): void {
    if (!this.threadId || !this.projector) throw new Error('Codex bootstrap has no thread');
    const historyKeys = new Set(history.map((item) => item.sourceKey));
    this.initialItems = [
      ...history,
      { type: 'history_boundary' },
    ];
    for (const item of historyItems.values()) this.projector.seedHistoryItem(item);
    for (const raw of this.bufferedNotifications) {
      const itemId = readItemId(raw.params);
      const historyItem = itemId ? historyItems.get(itemId) : undefined;
      if (historyItem && isHistoryCoveredItemNotification(raw.method)) {
        if (raw.method !== 'item/completed') continue;
        const completedItem = readItem(raw.params);
        if (completedItem && isDeepStrictEqual(completedItem, historyItem)) continue;
      }
      const observation = this.projector.projectNotification(raw.method, raw.params);
      if (observation && !historyKeys.has(observation.sourceKey)) this.preReadyEvents.push(observation);
    }
    this.bufferedNotifications.length = 0;
    this.initialItems.push(...this.preReadyEvents);
    this.preReadyEvents.length = 0;
    this.ready = true;
    if (this.runtimeStatus === 'starting') this.runtimeStatus = 'idle';
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.handleRuntimeNotification(method, params)) return;
    if (this.handleServerRequestResolved(method, params)) return;
    if (!this.ready || !this.projector) {
      this.bufferedNotifications.push({ method, params });
      return;
    }
    if (isRecord(params) && readString(params.threadId) && params.threadId !== this.threadId) return;
    if (method === 'turn/started') this.latestPlan = undefined;
    if (this.config.collaborationMode === 'plan') {
      if (method === 'item/plan/delta') return;
      const item = readItem(params);
      if ((method === 'item/started' || method === 'item/completed') && item?.type === 'plan') {
        const text = readString(item.text);
        const id = readString(item.id);
        if (method === 'item/completed' && text && id) this.latestPlan = { id, text };
        return;
      }
    }
    const observation = this.projector.projectNotification(method, params);
    if (!observation) return;
    if ((observation.event.type === 'turn_started'
      || observation.event.type === 'turn_completed'
      || observation.event.type === 'turn_failed'
      || observation.event.type === 'turn_canceled')
      && observation.event.turnId && !this.observedTurnIds.has(observation.event.turnId)) {
      this.observedTurnIds.add(observation.event.turnId);
      this.nativeTurnRevision += 1;
    }
    if (observation.event.type === 'turn_started') {
      this.activeTurnId = observation.event.turnId;
      this.statusRevision += 1;
      this.runtimeStatus = 'running';
    }
    if (
      observation.event.type === 'turn_completed'
      || observation.event.type === 'turn_failed'
      || observation.event.type === 'turn_canceled'
    ) {
      this.statusRevision += 1;
      this.runtimeStatus = observation.event.type === 'turn_failed' ? 'failed' : 'idle';
      this.activeTurnId = undefined;
    }
    this.emit(observation);
    if (observation.event.type === 'turn_completed' && this.config.collaborationMode === 'plan' && this.latestPlan) {
      const plan = this.latestPlan;
      this.latestPlan = undefined;
      const request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }> = {
        kind: 'plan_approval', requestId: `plan:${this.threadId}:${plan.id}`,
        plan: plan.text, allowedActions: ['approve_and_resume', 'reject'],
      };
      this.pendingInteractions.set(request.requestId, { kind: 'plan_approval', request, resolve: () => undefined });
      this.emitInteractionRequested(request);
    }
  }

  private async respondToPlan(
    request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>,
    response: Extract<AgentInteractionResponse, { kind: 'plan_approval' }>,
  ): Promise<void> {
    if (!request.allowedActions.includes(response.action)) throw new Error(`Unsupported Codex plan action ${response.action}`);
    if (response.action !== 'reject' && 'feedback' in response) throw new Error('Codex approval cannot contain revision feedback.');
    if (this.startingTurn || this.runtimeStatus === 'running') throw new Error('Codex plan review requires an idle turn.');
    const previousMode = this.config.collaborationMode;
    const nativeTurnRevision = this.nativeTurnRevision;
    if (response.action === 'approve_and_resume') delete this.config.collaborationMode;
    try {
      if (response.action === 'approve_and_resume') {
        await this.startTurn(`Implement the approved plan.\n\n${request.plan}\n\nComplete the work and verify the result.`);
      } else if (response.action === 'reject' && response.feedback?.trim()) {
        await this.startTurn(`Revise the proposed plan using this feedback. Stay in planning mode and present the revised plan.\n\nFeedback:\n${response.feedback.trim()}\n\nPrevious plan:\n${request.plan}`);
      }
    } catch (error) {
      // A new native turn proves acceptance even when its RPC reply fails later.
      if (nativeTurnRevision === this.nativeTurnRevision) {
        if (previousMode) this.config.collaborationMode = previousMode;
        else delete this.config.collaborationMode;
        this.emitRuntimeUpdate();
        throw error;
      }
    }
    this.pendingInteractions.delete(request.requestId);
    this.emitInteractionResolved(request.requestId, response);
    this.emitRuntimeUpdate();
  }

  private handleRuntimeNotification(method: string, params: unknown): boolean {
    if (method !== 'thread/settings/updated' && method !== 'thread/status/changed') return false;
    if (!isRecord(params)) return true;
    const nativeThreadId = readString(params.threadId);
    if (this.threadId && nativeThreadId && nativeThreadId !== this.threadId) return true;

    if (method === 'thread/settings/updated') {
      if (!isRecord(params.threadSettings)) return true;
      this.applyThreadSettings(params.threadSettings);
    } else {
      const status = readThreadRuntimeStatus(params.status);
      if (!status) return true;
      this.statusRevision += 1;
      this.runtimeStatus = status;
    }

    if (this.ready && this.threadId) this.emitRuntimeUpdate();
    return true;
  }

  private applyThreadSettings(settings: Record<string, unknown>): void {
    const cwd = readString(settings.cwd);
    const model = readString(settings.model);
    if (cwd) this.config.cwd = cwd;
    if (model) this.config.model = model;
    if (Object.prototype.hasOwnProperty.call(settings, 'effort')) {
      const effort = readString(settings.effort);
      if (effort) this.config.reasoningEffort = effort;
      else delete this.config.reasoningEffort;
    }
    if (isRecord(settings.collaborationMode)) {
      if (readString(settings.collaborationMode.mode) === 'plan') this.config.collaborationMode = 'plan';
      else delete this.config.collaborationMode;
    }
  }

  private emitRuntimeUpdate(): void {
    if (!this.threadId) return;
    this.emit({
      type: 'observation',
      sourceKey: `runtime:${this.threadId}`,
      nativeRevision: ++this.runtimeRevision,
      occurredAt: Date.now(),
      delivery: 'live',
      event: {
        type: 'runtime_updated', provider: PROVIDER_ID, runtimeInfo: this.currentRuntimeInfo(),
      },
    });
  }

  private handleServerRequestResolved(method: string, params: unknown): boolean {
    if (method !== 'serverRequest/resolved') return false;
    if (!isRecord(params)) return true;
    const nativeThreadId = readString(params.threadId);
    if (this.threadId && nativeThreadId && nativeThreadId !== this.threadId) return true;
    const nativeRequestId = params.requestId;
    if (typeof nativeRequestId !== 'string' && typeof nativeRequestId !== 'number') return true;
    const suffix = String(nativeRequestId);
    const requestId = [`question:${suffix}`, `tool:${suffix}`]
      .find((candidate) => this.pendingInteractions.has(candidate));
    if (!requestId) return true;
    const pending = this.pendingInteractions.get(requestId)!;
    this.pendingInteractions.delete(requestId);
    pending.resolve(pending.kind === 'question' ? { answers: {} } : { decision: 'cancel' });
    const response: AgentInteractionResponse = pending.kind === 'question'
      ? { kind: 'question', answers: [], dismissed: true }
      : { kind: 'tool_approval', decision: 'deny' };
    this.emitInteractionResolved(requestId, response);
    return true;
  }

  private emitInteractionResolved(
    requestId: string,
    response: AgentInteractionResponse,
  ): void {
    this.emit({
      type: 'observation',
      sourceKey: `interaction:${requestId}:resolved`,
      occurredAt: Date.now(),
      delivery: 'live',
      event: {
        type: 'interaction_resolved', provider: PROVIDER_ID, requestId, response,
      },
    });
  }

  private emit(observation: ProviderObservation): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.preReadyEvents.push(observation);
      return;
    }
    this.liveQueue.push(observation);
  }

  private handleTransportTermination(error: Error): void {
    if (this.disposed || this.transportFailure) return;
    this.transportFailure = error;
    this.runtimeStatus = 'failed';
    this.resolvePendingInteractions();
    this.liveQueue.fail(error);
  }

  private resolvePendingInteractions(): void {
    for (const pending of this.pendingInteractions.values()) {
      pending.resolve(pending.kind === 'question'
        ? { answers: {} }
        : { decision: 'cancel' });
    }
    this.pendingInteractions.clear();
  }

  private handleQuestionRequest(params: unknown, nativeRequestId: string | number): Promise<unknown> {
    if (!isRecord(params) || !Array.isArray(params.questions)) {
      return Promise.reject(new Error('Codex question request has no questions'));
    }
    const questions = params.questions.map((value, index) => this.mapQuestion(value, index));
    if (questions.length === 0) {
      return Promise.reject(new Error('Codex question request has no valid questions'));
    }
    const requestId = `question:${String(nativeRequestId)}`;
    const request: Extract<AgentInteractionRequest, { kind: 'question' }> = {
      kind: 'question', requestId, questions,
    };
    return new Promise((resolve) => {
      this.pendingInteractions.set(requestId, { kind: 'question', request, resolve });
      this.emitInteractionRequested(request);
    });
  }

  private mapQuestion(value: unknown, index: number): AgentQuestion {
    if (!isRecord(value)) throw new Error(`Codex question ${index + 1} is invalid`);
    const questionId = readString(value.id);
    const header = readString(value.header);
    const prompt = readString(value.question);
    if (!questionId || !header || !prompt) {
      throw new Error(`Codex question ${index + 1} is missing id, header, or prompt`);
    }
    const options = Array.isArray(value.options) ? value.options.map((option, optionIndex) => {
      if (!isRecord(option) || !readString(option.label)) {
        throw new Error(`Codex question ${questionId} option ${optionIndex + 1} is invalid`);
      }
      const label = readString(option.label)!;
      const description = readString(option.description);
      return { value: label, label, ...(description ? { description } : {}) };
    }) : [];
    return {
      questionId,
      header,
      prompt,
      required: true,
      selection: value.multiSelect === true ? 'multiple' : 'single',
      options,
      allowCustomText: value.isOther === true || options.length === 0,
      allowDismiss: true,
    };
  }

  private handleToolRequest(
    nativeKind: 'command' | 'file',
    params: unknown,
    nativeRequestId: string | number,
  ): Promise<unknown> {
    if (!isRecord(params)) return Promise.reject(new Error('Codex tool approval request is invalid'));
    const itemId = readString(params.itemId);
    if (!itemId) return Promise.reject(new Error('Codex tool approval request has no item id'));
    const requestId = `tool:${String(nativeRequestId)}`;
    const command = readString(params.command);
    const cwd = readString(params.cwd);
    const reason = readString(params.reason);
    const request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }> = {
      kind: 'tool_approval',
      requestId,
      toolCallId: itemId,
      toolName: nativeKind === 'command' ? 'command' : 'file_change',
      summary: reason ?? (nativeKind === 'command'
        ? `Run ${command ?? 'a command'}`
        : 'Apply file changes'),
      detail: nativeKind === 'command' && command
        ? { type: 'shell', command, ...(cwd ? { cwd } : {}) }
        : { type: 'other', description: nativeKind === 'command' ? reason || 'Run a command' : 'Apply Codex file changes' },
      allowedDecisions: ['allow', 'deny'],
      allowScopes: ['once', 'session'],
    };
    return new Promise((resolve) => {
      this.pendingInteractions.set(requestId, {
        kind: 'tool_approval', request, nativeKind, resolve,
      });
      this.emitInteractionRequested(request);
    });
  }

  private emitInteractionRequested(request: AgentInteractionRequest): void {
    this.emit({
      type: 'observation',
      sourceKey: `interaction:${request.requestId}:requested`,
      occurredAt: Date.now(),
      delivery: 'live',
      event: {
        type: 'interaction_requested', provider: PROVIDER_ID, request,
      },
    });
  }

  private mapQuestionResponse(
    request: Extract<AgentInteractionRequest, { kind: 'question' }>,
    response: Extract<AgentInteractionResponse, { kind: 'question' }>,
  ): unknown {
    if (response.dismissed) {
      if (response.answers.length > 0) throw new Error('A dismissed Codex question cannot contain answers');
      return { answers: {} };
    }
    const submitted = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const answer = submitted.get(question.questionId);
      if (!answer) {
        if (question.required) throw new Error(`Codex question ${question.questionId} requires an answer`);
        continue;
      }
      const allowed = new Set(question.options.map((option) => option.value));
      if (answer.selectedValues.some((value) => !allowed.has(value))) {
        throw new Error(`Codex question ${question.questionId} contains an unknown option`);
      }
      if (question.selection === 'single' && answer.selectedValues.length > 1) {
        throw new Error(`Codex question ${question.questionId} accepts one option`);
      }
      if (answer.customText && !question.allowCustomText) {
        throw new Error(`Codex question ${question.questionId} does not accept custom text`);
      }
      const values = [
        ...answer.selectedValues,
        ...(answer.customText?.trim() ? [answer.customText.trim()] : []),
      ];
      if (values.length === 0 && question.required) {
        throw new Error(`Codex question ${question.questionId} requires an answer`);
      }
      answers[question.questionId] = { answers: values };
      submitted.delete(question.questionId);
    }
    if (submitted.size > 0) {
      throw new Error(`Codex question response contains unknown question ${submitted.keys().next().value}`);
    }
    return { answers };
  }

  private mapToolResponse(
    pending: Extract<NativePendingInteraction, { kind: 'tool_approval' }>,
    response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>,
  ): unknown {
    if (response.decision === 'deny') return { decision: 'decline' };
    if (!pending.request.allowScopes.includes(response.scope)) {
      throw new Error(`Codex tool approval does not allow ${response.scope} scope`);
    }
    return { decision: response.scope === 'session' ? 'acceptForSession' : 'accept' };
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Codex session is closed');
    if (this.transportFailure) throw this.transportFailure;
  }
}

function isHistoryCoveredItemNotification(method: string): boolean {
  return method === 'item/started'
    || method === 'item/completed'
    || method === 'item/agentMessage/delta'
    || method === 'item/reasoning/summaryTextDelta';
}

function readThreadRuntimeStatus(value: unknown): AgentRuntimeInfo['status'] | undefined {
  if (!isRecord(value)) return undefined;
  const type = readString(value.type);
  if (type === 'idle') return 'idle';
  if (type === 'systemError') return 'failed';
  if (type === 'notLoaded') return 'closed';
  if (type !== 'active') return undefined;
  const flags = Array.isArray(value.activeFlags)
    ? value.activeFlags.filter((flag): flag is string => typeof flag === 'string')
    : [];
  return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
    ? 'waiting'
    : 'running';
}

function toStoredConfig(config: AgentSessionConfig, collaborationMode?: 'plan'): StoredSessionConfig {
  return {
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.planning === true || (config.planning === undefined && collaborationMode) ? { collaborationMode: 'plan' as const } : {}),
  };
}

function parseStoredConfig(opaque: string): StoredSessionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opaque);
  } catch {
    throw new Error('Codex persistence handle contains invalid JSON');
  }
  if (!isRecord(parsed)) throw new Error('Codex persistence handle is invalid');
  return {
    ...(readString(parsed.cwd) ? { cwd: readString(parsed.cwd) } : {}),
    ...(readString(parsed.model) ? { model: readString(parsed.model) } : {}),
    ...(readString(parsed.reasoningEffort) ? { reasoningEffort: readString(parsed.reasoningEffort) } : {}),
    ...(readString(parsed.systemPrompt) ? { systemPrompt: readString(parsed.systemPrompt) } : {}),
    ...(parsed.collaborationMode === 'plan' ? { collaborationMode: 'plan' as const } : {}),
  };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
      },
    };
  }
}
