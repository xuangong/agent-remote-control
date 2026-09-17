import { discoverCodexCommands, expandCodexPrompt, readCodexCommandDocumentation } from './commands.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { CodexSessionSettings } from './session-settings.js';
import { isDeepStrictEqual } from 'node:util';

import type {
  AgentCapabilities,
  AgentCommand,
  AgentCommandResult,
  AgentMessageOptions,
  AgentSessionSetting,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentResourceReadResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  ProviderObservation,
  ProviderStreamItem,
} from '@agent-remote-controller/agent-provider-sdk';

import { AgentSessionInUseError, CommandInteractions, validateInteractionResponse, redactInteractionResponse } from '@agent-remote-controller/agent-provider-sdk';
import { mapCodexQuestion, mapCodexQuestionResponse } from './questions.js';
import { mapCodexElicitation, mapCodexElicitationResponse } from './elicitation.js';
import { mapCodexPermissions } from './permissions.js';
import { mapCodexToolApproval } from './tool-approval.js';
import { CodexAppServerRpcError, CodexAppServerTransport, CodexServerRequestCanceled } from './app-server-transport.js';
import { collectCodexThreadHistoryItems, projectCodexThreadHistory } from './history.js';
import { CodexImageRegistry } from './images.js';
import { isRecord, readItem, readItemId, readString } from './native.js';
import { CodexEventProjector } from './projector.js';
import { readCodexPlanningModes, type CodexPlanningModes } from './planning.js';
import { initializeCodexTransport } from './initialize.js';
import { CodexSessionRuntime, historyOverlapsNotifications, type CodexRawNotification } from './runtime.js';
import type { CodexSharedRecoveryPlan } from './shared-recovery.js';

const PROVIDER_ID = 'codex';

export const CODEX_CAPABILITIES: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: true,
  planning: false,
  sessionSettings: true,
  commands: true,
  interactions: {
    question: true,
    planApproval: false,
    toolApproval: true,
    form: true,
    permissionApproval: true,
    externalAction: true,
  },
};

interface StoredSessionConfig {
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  collaborationMode?: 'plan';
}

interface NativePendingInteraction {
  kind: AgentInteractionRequest['kind'];
  request: AgentInteractionRequest;
  turnId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  respond(response: AgentInteractionResponse): unknown;
  nativeRequestId?: string;
}

interface RawNotification {
  method: string;
  params: unknown;
}

export class CodexAppServerSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { ...CODEX_CAPABILITIES, interactions: { ...CODEX_CAPABILITIES.interactions } };

  private readonly settings = new CodexSessionSettings();
  private changingSetting = false;
  private executingCommand = false;
  private commandEventSequence = 0;
  private readonly commandEventPrefix = randomUUID();
  private readonly commandInteractions = new CommandInteractions(PROVIDER_ID, (event) => this.emit({
    type: 'observation', sourceKey: `command:${this.commandEventPrefix}:${++this.commandEventSequence}`, occurredAt: Date.now(), delivery: 'live', event,
  }));
  private settingConfirmation: { id: string; value: string; resolve(): void; reject(error: Error): void } | undefined;
  private threadId: string | undefined;
  private projector: CodexEventProjector | undefined;
  private images: CodexImageRegistry | undefined;
  private initialItems: ProviderStreamItem[] = [];
  private readonly bufferedNotifications: RawNotification[] = [];
  private readonly preReadyEvents: ProviderObservation[] = [];
  private liveQueue = new AsyncQueue<ProviderStreamItem>();
  private readonly pendingInteractions = new Map<string, NativePendingInteraction>();
  private ready = false;
  private observing = false;
  private disposed = false;
  private released = false;
  private transportFailure: Error | undefined;
  private runtimeStatus: AgentRuntimeInfo['status'] = 'starting';
  private runtimeRevision = 0;
  private statusRevision = 0;
  private nativeTurnRevision = 0;
  private readonly observedTurnIds = new Set<string>();
  private planningModes: CodexPlanningModes | undefined;
  private collaborationModeSelected = false;
  private latestPlan: { id: string; text: string } | undefined;
  private startingTurn = false;
  private sendingMessage = false;
  private activeTurnId: string | undefined;

  private constructor(
    private transport: CodexAppServerTransport,
    private readonly config: StoredSessionConfig,
    private readonly codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
    runtime?: CodexSessionRuntime,
    private readonly restrictedNative = false,
    recoveryPlan?: CodexSharedRecoveryPlan,
  ) {
    this.runtime = runtime ?? new CodexSessionRuntime(transport, this,
      (thread, history, buffered) => this.createNativeChild(thread, history, buffered), recoveryPlan);
    this.ownsRuntime = runtime === undefined;
    this.sharedInteractionIdentity = recoveryPlan ? randomUUID() : undefined;
  }

  private readonly runtime: CodexSessionRuntime;
  private readonly ownsRuntime: boolean;
  private readonly runtimeClosedListeners = new Set<() => void>();
  private acceptsDirectInput = true;
  private inputCapabilitiesRevision = 0;
  private historyRefreshNeeded = false;
  private uncertainHistorySnapshot = false;
  private preparingObservation: Promise<void> | undefined;
  private interactionGeneration = 1;
  private sharedInteractionIdentity: string | undefined;

  onRuntimeClosed(listener: () => void): void {
    if (this.disposed || this.transportFailure) listener();
    else this.runtimeClosedListeners.add(listener);
  }

  private notifyRuntimeClosed(): void {
    for (const listener of this.runtimeClosedListeners) listener();
    this.runtimeClosedListeners.clear();
  }

  receiveNotification(method: string, params: unknown): void { this.handleNotification(method, params); }
  receiveTermination(error: Error): void { this.handleTransportTermination(error); }
  notifyChildrenChanged(): void { this.emitRuntimeUpdate(); }
  childRuntimeInfo(): AgentRuntimeInfo { return this.currentRuntimeInfo(); }

  beginRecovery(reason: string): void {
    if (this.disposed) return;
    this.inputCapabilitiesRevision += 1;
    this.commandInteractions.clear();
    const confirmation = this.settingConfirmation;
    this.settingConfirmation = undefined;
    confirmation?.reject(new Error('Codex setting confirmation was invalidated by connection recovery'));
    this.invalidatePendingInteractions(reason);
  }

  replaceTransport(transport: CodexAppServerTransport, generation: number): void {
    this.transport = transport;
    this.interactionGeneration = generation;
    this.transportFailure = undefined;
  }

  connectionChanged(): void {
    if (this.ready && !this.disposed) this.emitRuntimeUpdate();
  }

  receiveRequest(method: string, params: unknown, id: string | number): Promise<unknown> {
    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') return this.handleQuestionRequest(params, id);
    if (method === 'item/commandExecution/requestApproval') return this.handleToolRequest('command', params, id);
    if (method === 'item/fileChange/requestApproval') return this.handleToolRequest('file', params, id);
    if (method === 'mcpServer/elicitation/request') return this.handleElicitationRequest(params, id);
    return this.handlePermissionRequest(params, id);
  }

  hasNativeChild(parentId: string, childId: string): boolean { return !this.disposed && this.runtime.hasChild(parentId, childId); }

  hasNativeThread(id: string): boolean { return !this.disposed && this.runtime.hasThread(id); }

  async openChildSession(parentNativeSessionId: string, childNativeSessionId: string): Promise<AgentSession> {
    this.assertOpen();
    return await this.runtime.openChild(parentNativeSessionId, childNativeSessionId) as CodexAppServerSession;
  }

  private createNativeChild(thread: Record<string, unknown>, history: unknown, buffered: CodexRawNotification[]): CodexAppServerSession {
    const child = new CodexAppServerSession(this.transport, {}, this.codexHome, this.runtime, this.restrictedNative);
    child.interactionGeneration = this.interactionGeneration;
    child.sharedInteractionIdentity = this.sharedInteractionIdentity;
    child.settings.inheritCatalog(this.settings);
    child.planningModes = this.planningModes;
    child.capabilities.planning = this.planningModes !== undefined;
    child.capabilities.interactions.planApproval = this.planningModes !== undefined;
    child.setThreadFromResponse({ thread }, 'thread/read');
    child.acceptsDirectInput = thread.canAcceptDirectInput === true && readThreadRuntimeStatus(thread.status) !== 'closed';
    child.refreshInputCapabilities();
    child.runtimeStatus = readThreadRuntimeStatus(thread.status) ?? 'starting';
    if (child.runtimeStatus === 'closed') child.disableInteractions();
    if (Array.isArray(thread.turns)) {
      const active = [...thread.turns].reverse().find((turn) => isRecord(turn) && turn.status === 'inProgress');
      if (isRecord(active)) child.activeTurnId = readString(active.id);
    }
    child.bufferedNotifications.push(...buffered);
    child.finishBootstrap(
      projectCodexThreadHistory(history, child.threadId!, { images: child.images, cwd: child.config.cwd }),
      collectCodexThreadHistoryItems(history, child.threadId!),
    );
    return child;
  }

  markHistoryRefreshNeeded(uncertain = false): void {
    this.historyRefreshNeeded = true;
    this.uncertainHistorySnapshot ||= uncertain;
  }

  async prepareObservation(): Promise<void> {
    if (this.disposed) throw new Error('Codex session is closed');
    if (this.transportFailure) throw this.transportFailure;
    this.released = false;
    if (this.preparingObservation) return this.preparingObservation;
    if (this.observing || !this.historyRefreshNeeded) return;
    this.preparingObservation = this.refreshUnobservedHistory().finally(() => { this.preparingObservation = undefined; });
    return this.preparingObservation;
  }

  private async refreshUnobservedHistory(): Promise<void> {
    const priorText = this.uncertainHistorySnapshot ? undefined : this.projector?.snapshotText();
    this.ready = false;
    try {
      let history: unknown;
      for (let attempt = 0; ; attempt++) {
        const start = this.bufferedNotifications.length;
        history = await this.transport.request('thread/read', { threadId: this.threadId, includeTurns: true });
        if (!this.uncertainHistorySnapshot || !historyOverlapsNotifications(history, this.threadId!, this.bufferedNotifications.slice(start))) break;
        if (attempt === 2) throw new Error('Codex child history is changing during snapshot reads. Reopen the child to retry.');
      }
      if (!isRecord(history) || !isRecord(history.thread) || history.thread.id !== this.threadId) throw new Error('Codex child history is unavailable');
      this.images?.stop();
      this.setThreadFromResponse(history, 'thread/read');
      this.liveQueue.clear();
      this.preReadyEvents.length = 0;
      for (const pending of this.pendingInteractions.values()) this.emitInteractionRequested(pending.request);
      this.finishBootstrap(
        projectCodexThreadHistory(history, this.threadId!, { images: this.images, cwd: this.config.cwd }),
        collectCodexThreadHistoryItems(history, this.threadId!),
        priorText,
      );
      this.historyRefreshNeeded = false;
      this.uncertainHistorySnapshot = false;
    } catch (error) {
      this.ready = true;
      throw error;
    }
  }

  private refreshInputCapabilities(): void {
    for (const key of ['sendMessage', 'steer', 'cancel', 'sessionSettings', 'commands'] as const) this.capabilities[key] = this.acceptsDirectInput;
    this.capabilities.planning = this.acceptsDirectInput && this.planningModes !== undefined && (this.ownsRuntime || !!this.config.model);
    this.capabilities.interactions.planApproval = this.acceptsDirectInput && this.planningModes !== undefined && (this.ownsRuntime || !!this.config.model);
  }

  private restoreInteractions(): void {
    Object.assign(this.capabilities.interactions, CODEX_CAPABILITIES.interactions);
    this.capabilities.interactions.planApproval = this.acceptsDirectInput && this.planningModes !== undefined && (this.ownsRuntime || !!this.config.model);
  }

  private async refreshNativeInputCapabilities(): Promise<void> {
    const revision = ++this.inputCapabilitiesRevision;
    try {
      const response = await this.transport.request('thread/read', { threadId: this.threadId, includeTurns: false });
      if (revision !== this.inputCapabilitiesRevision || this.disposed || this.transportFailure || this.runtimeStatus === 'closed') return;
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== this.threadId
        || readThreadRuntimeStatus(response.thread.status) === 'closed') return;
      this.acceptsDirectInput = response.thread.canAcceptDirectInput === true;
      this.restoreInteractions();
      this.refreshInputCapabilities();
      if (this.ready) this.emitRuntimeUpdate();
    } catch {
      // Input remains disabled until the native thread confirms its eligibility.
    }
  }

  private disableInteractions(): void {
    for (const key of Object.keys(this.capabilities.interactions) as Array<keyof AgentCapabilities['interactions']>) this.capabilities.interactions[key] = false;
  }

  private assertDirectInput(): void {
    this.assertOpen();
    this.runtime.assertConnected();
    if (!this.acceptsDirectInput) throw new Error('Codex native child does not accept direct input.');
    if (this.runtimeStatus === 'closed') throw new Error('Codex session is closed');
  }

  static async create(
    transport: CodexAppServerTransport,
    config: AgentSessionConfig,
    collaborationMode?: 'plan',
    codexHome?: string,
    restrictedNative = false,
    recoveryPlan?: CodexSharedRecoveryPlan,
  ): Promise<CodexAppServerSession> {
    const stored = toStoredConfig(config, collaborationMode);
    const session = new CodexAppServerSession(transport, stored, codexHome, undefined, restrictedNative, recoveryPlan);
    await session.initialize();
    const response = await transport.request('thread/start', {
      historyMode: 'paginated',
      config: { 'features.default_mode_request_user_input': true },
      ...(restrictedNative ? { sandbox: 'workspace-write', approvalPolicy: 'never' } : {}),
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
    codexHome?: string,
    restrictedNative = false,
    recoveryPlan?: CodexSharedRecoveryPlan,
  ): Promise<CodexAppServerSession> {
    if (handle.providerId !== PROVIDER_ID) {
      throw new Error(`Cannot resume ${handle.providerId} with the Codex provider`);
    }
    const stored = { ...parseStoredConfig(handle.opaque), ...(collaborationMode ? { collaborationMode } : {}) };
    const session = new CodexAppServerSession(transport, stored, codexHome, undefined, restrictedNative, recoveryPlan);
    session.threadId = handle.sessionId;
    session.runtime.registerRoot(handle.sessionId);
    await session.initialize();
    const resumed = await transport.request('thread/resume', {
      threadId: handle.sessionId,
      config: { 'features.default_mode_request_user_input': true },
      ...(restrictedNative ? { sandbox: 'workspace-write', approvalPolicy: 'never' } : {}),
      ...(stored.cwd ? { cwd: stored.cwd } : {}),
      ...(stored.model ? { model: stored.model } : {}),
      ...(stored.systemPrompt ? { developerInstructions: stored.systemPrompt } : {}),
    }).catch((error: unknown) => {
      if (error instanceof CodexAppServerRpcError && error.code === -32600
        && error.message === `thread ${handle.sessionId} already has an active writer`) {
        throw new AgentSessionInUseError('This session is in use by another Codex client. Close the original Codex client, then try opening this session again.');
      }
      throw error;
    });
    session.setThreadFromResponse(resumed, 'thread/resume');
    const history = await transport.request('thread/read', {
      threadId: handle.sessionId,
      includeTurns: true,
    });
    session.runtime.inspectHistory(handle.sessionId, history);
    session.finishBootstrap(
      projectCodexThreadHistory(history, handle.sessionId, { images: session.images, cwd: session.config.cwd }),
      collectCodexThreadHistoryItems(history, handle.sessionId),
    );
    return session;
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    this.assertOpen();
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

  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> {
    this.assertMessageReady();
    if (options?.delivery === 'next_turn') throw new Error('Codex does not support next-turn message delivery.');
    if (this.sendingMessage) throw new Error('A Codex message is already being submitted.');
    if (!text.trim()) throw new Error('Codex message must not be empty.');
    this.sendingMessage = true;
    try {
      if (!this.activeTurnId) return await this.startTurn(text);
      let expectedTurnId = this.activeTurnId;
      for (let attempt = 0; ; attempt += 1) {
        const revision = this.statusRevision;
        try {
          await this.steerTurn(text, expectedTurnId);
          return;
        } catch (error) {
          if (!(error instanceof CodexAppServerRpcError) || error.code !== -32602) throw error;
          this.assertMessageReady();
          if (error.message === 'no active turn to steer') {
            // A native rejection confirms non-delivery, but a newer turn notification wins.
            if (this.activeTurnId && (this.activeTurnId !== expectedTurnId || this.statusRevision !== revision)) throw error;
            if (this.runtimeStatus === 'failed' || this.runtimeStatus === 'closed'
              || (this.statusRevision !== revision && this.runtimeStatus !== 'idle')) throw error;
            this.activeTurnId = undefined;
            this.runtimeStatus = 'idle';
            this.statusRevision += 1;
            this.assertMessageReady();
            await this.startTurn(text);
            return;
          }
          const mismatch = /^expected active turn id `([^`]+)` but found `([^`]+)`$/.exec(error.message);
          if (attempt > 0 || !mismatch || mismatch[1] !== expectedTurnId || mismatch[2] === expectedTurnId || this.statusRevision !== revision) throw error;
          expectedTurnId = mismatch[2]!;
          this.activeTurnId = expectedTurnId;
          this.runtimeStatus = 'running';
          this.statusRevision += 1;
        }
      }
    } finally { this.sendingMessage = false; }
  }

  private assertMessageReady(): void {
    this.assertDirectInput();
    if (this.commandInteractions.pending || (!this.activeTurnId && this.pendingInteractions.size > 0)) throw new Error('Codex has pending interactions');
    if (this.executingCommand) throw new Error('A Codex command is active');
    if (this.changingSetting || this.startingTurn) throw new Error('A Codex turn or setting change is already active');
  }

  async steer(text: string): Promise<void> {
    this.assertDirectInput();
    if (!this.activeTurnId) throw new Error('Codex has no active turn.');
    if (!text.trim()) throw new Error('Codex message must not be empty.');
    await this.steerTurn(text, this.activeTurnId);
  }

  private async steerTurn(text: string, expectedTurnId: string): Promise<void> {
    await this.transport.request('turn/steer', {
      threadId: this.threadId, expectedTurnId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  async cancel(): Promise<void> {
    this.assertDirectInput();
    if (!this.activeTurnId) throw new Error('Codex has no active turn.');
    await this.transport.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
  }

  private async startTurn(text: string, skill?: { name: string; path: string }): Promise<void> {
    this.assertDirectInput();
    if (!this.threadId) throw new Error('Codex session has no thread');
    if (!text.trim() && !skill) throw new Error('Codex message must not be empty');
    if (this.changingSetting || this.startingTurn || this.runtimeStatus === 'running') throw new Error('A Codex turn is already active');
    const collaborationMode = this.buildCollaborationMode();
    const statusRevision = this.statusRevision;
    this.startingTurn = true;
    try {
      const result = await this.transport.request('turn/start', {
        threadId: this.threadId,
        input: [...(skill ? [{ type: 'skill', ...skill }] : []), ...(text ? [{ type: 'text', text, text_elements: [] }] : [])],
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

  async setSessionSetting(id: string, value: string): Promise<void> {
    if (this.executingCommand || this.commandInteractions.pending || this.sendingMessage) throw new Error('Codex has pending command interactions or message submission');
    await this.applySessionSetting(id, value);
  }

  private async applySessionSetting(id: string, value: string): Promise<void> {
    this.assertDirectInput();
    if (this.restrictedNative && this.settings.describe(this.config.model, this.config.reasoningEffort).some(setting => setting.id === id && setting.category === 'permissions')) {
      throw new Error('Native permission settings are locked by local Host policy.');
    }
    if (this.changingSetting || this.startingTurn || this.runtimeStatus !== 'idle' || this.activeTurnId) throw new Error('Codex settings can only change while idle.');
    if (this.pendingInteractions.size > 0) throw new Error('Codex settings cannot change with pending interactions.');
    const patch = this.settings.patch(id, value, this.config.model, this.config.reasoningEffort);
    const collaborationMode = this.buildCollaborationMode();
    if (collaborationMode) {
      patch.collaborationMode = { ...collaborationMode, settings: { ...collaborationMode.settings,
        ...(typeof patch.model === 'string' ? { model: patch.model } : {}),
        ...(typeof patch.effort === 'string' ? { reasoning_effort: patch.effort } : {}),
      } };
    }
    if (this.settings.describe(this.config.model, this.config.reasoningEffort).find((setting) => setting.id === id)?.value === value) return;
    this.changingSetting = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let confirmation: NonNullable<typeof this.settingConfirmation>;
    const confirmed = new Promise<void>((resolve, reject) => {
      confirmation = { id, value, resolve, reject };
      this.settingConfirmation = confirmation;
      deadline = setTimeout(() => reject(new Error('Codex did not confirm the requested setting. Check the current session state before retrying.')), 10_000);
    });
    try {
      await Promise.all([this.transport.request('thread/settings/update', { threadId: this.threadId, ...patch }), confirmed]);
    } finally {
      clearTimeout(deadline);
      if (this.settingConfirmation === confirmation!) this.settingConfirmation = undefined;
      this.changingSetting = false;
    }
  }

  async setPlanning(active: boolean): Promise<void> {
    this.assertDirectInput();
    if (!this.capabilities.planning) throw new Error('Codex planning control is unsupported.');
    if (this.executingCommand || this.commandInteractions.pending || this.sendingMessage) throw new Error('Codex has pending command interactions or message submission');
    if (this.changingSetting || this.startingTurn || this.runtimeStatus !== 'idle') throw new Error('Codex planning can only change while idle.');
    if (this.pendingInteractions.size > 0) throw new Error('Codex planning cannot change with pending interactions.');
    this.collaborationModeSelected = true;
    if (active) this.config.collaborationMode = 'plan';
    else delete this.config.collaborationMode;
    this.emitRuntimeUpdate();
  }

  private buildCollaborationMode(): { mode: string; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } } | undefined {
    if (!this.planningModes || (!this.ownsRuntime && !this.collaborationModeSelected && !this.config.collaborationMode)) return undefined;
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
    this.runtime.assertConnected();
    if (await this.commandInteractions.respond(requestId, response)) return;
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) throw new Error(`No pending Codex interaction ${requestId}`);
    if (pending.kind !== response.kind) {
      throw new Error(`Codex interaction ${requestId} requires a ${pending.kind} response`);
    }
    if (response.kind === 'plan_approval' && response.action !== 'reject' && 'feedback' in response) throw new Error('Codex approval cannot contain revision feedback.');
    validateInteractionResponse(pending.request, response);
    if (pending.request.kind === 'plan_approval' && response.kind === 'plan_approval') {
      await this.respondToPlan(pending.request, response);
      return;
    }
    const nativeResponse = pending.respond(response);
    this.pendingInteractions.delete(requestId);
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
    pending.resolve(nativeResponse);
    this.emitInteractionResolved(requestId, redactInteractionResponse(pending.request, response));
  }

  async listCommands(): Promise<AgentCommand[]> {
    this.assertOpen();
    const commands = await discoverCodexCommands(this.transport, this.config.cwd, this.codexHome);
    return commands.filter(command => !this.restrictedNative || command.descriptor.id !== 'permissions').map(({ descriptor }) => descriptor);
  }

  async executeCommand(id: string, args: string): Promise<AgentCommandResult> {
    this.assertCommandIdle();
    if (this.restrictedNative && id === 'permissions') throw new Error('Native permission commands are locked by local Host policy.');
    if (this.executingCommand) throw new Error('A Codex command is already active.');
    if (this.commandInteractions.pending) throw new Error('Codex has pending command interactions.');
    this.executingCommand = true;
    try {
      const command = (await discoverCodexCommands(this.transport, this.config.cwd, this.codexHome)).find(({ descriptor }) => descriptor.id === id);
      this.assertCommandIdle();
      if (!command) throw new Error('Codex command is unavailable. Refresh the command directory.');
      if (command.type === 'skill') await this.startTurn(args, { name: command.name, path: command.path });
      else if (command.type === 'prompt') await this.startTurn(expandCodexPrompt(command.body, args));
      else {
        if (args.trim()) throw new Error('This Codex command does not accept arguments.');
        if (id === 'compact') await this.transport.request('thread/compact/start', { threadId: this.threadId });
        else {
          await this.settings.discover(this.transport);
          this.assertCommandIdle();
          if (id === 'model') this.openSettingQuestion('model', true);
          else this.openPermissionsQuestion();
        }
      }
      return {};
    } finally { this.executingCommand = false; }
  }

  private assertCommandIdle(): void {
    this.assertDirectInput();
    if (this.changingSetting || this.startingTurn || this.sendingMessage || this.activeTurnId || this.runtimeStatus !== 'idle') throw new Error('Codex commands require an idle session.');
    if (this.pendingInteractions.size > 0) throw new Error('Codex has pending native interactions.');
  }

  private openSettingQuestion(id: string, followWithEffort = false): void {
    const setting = this.settings.describe(this.config.model, this.config.reasoningEffort).find((item) => item.id === id);
    if (!setting?.mutable || !setting.options.length) throw new Error('Codex setting is unavailable.');
    this.openCommandQuestion(setting, async (value) => {
      this.assertCommandIdle();
      await this.settings.discover(this.transport);
      await this.applySessionSetting(id, value);
      if (followWithEffort) {
        const effort = this.settings.describe(this.config.model, this.config.reasoningEffort).find((item) => item.id === 'effort');
        if (effort?.mutable && effort.options.length) this.openSettingQuestion('effort');
      }
    });
  }

  private openPermissionsQuestion(): void {
    const available = this.settings.describe(this.config.model, this.config.reasoningEffort).filter((setting) => setting.category === 'permissions' && setting.mutable && setting.options.length);
    if (!available.length) throw new Error('Codex permission settings are unavailable.');
    this.openCommandQuestion({
      id: 'permissions', category: 'permissions', label: 'Permissions', value: null, mutable: true, scope: 'session',
      options: available.map(({ id, label, description }) => ({ value: id, label, description })),
    }, async (value) => {
      this.assertCommandIdle();
      await this.settings.discover(this.transport);
      this.openSettingQuestion(value);
    });
  }

  private openCommandQuestion(setting: AgentSessionSetting, handler: (value: string) => Promise<void>): void {
    this.commandInteractions.open({ kind: 'question', questions: [{
      questionId: setting.id, header: setting.label, prompt: `Choose ${setting.label.toLowerCase()}`,
      description: [setting.value ? `Current: ${setting.options.find(({ value }) => value === setting.value)?.label ?? setting.value}.` : '', setting.description ?? ''].filter(Boolean).join(' '),
      required: true, selection: 'single', options: setting.options, allowCustomText: false, allowDismiss: true,
    }] }, async (response) => {
      if (response.kind !== 'question') throw new Error('Codex command requires a question response.');
      const value = response.answers.find(({ questionId }) => questionId === setting.id)?.selectedValues[0];
      if (!value) throw new Error('Codex command requires a selection.');
      await handler(value);
    });
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return this.currentRuntimeInfo();
  }

  private currentRuntimeInfo(): AgentRuntimeInfo {
    return {
      providerId: PROVIDER_ID,
      sessionId: this.threadId ?? null,
      status: !this.ownsRuntime && this.pendingInteractions.size > 0 && this.runtimeStatus !== 'closed' && this.runtimeStatus !== 'failed' ? 'waiting' : this.runtimeStatus,
      ...(this.runtime.connectionInfo() ? { connection: this.runtime.connectionInfo() } : {}),
      childSessions: this.threadId ? this.runtime.childSessions(this.threadId) : [],
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      model: this.config.model ?? null,
      settings: this.settings.describe(this.config.model, this.config.reasoningEffort).map((setting) => this.acceptsDirectInput && !(this.restrictedNative && setting.category === 'permissions') ? setting : { ...setting, mutable: false }),
      mode: this.config.collaborationMode ?? null,
      ...(this.planningModes ? { planning: { active: this.config.collaborationMode === 'plan' } } : {}),
      persistence: this.threadId ? {
        providerId: PROVIDER_ID,
        sessionId: this.threadId,
        opaque: JSON.stringify(this.config),
      } : undefined,
    };
  }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    this.assertOpen();
    if (locator.startsWith('skill:')) return readCodexCommandDocumentation(this.transport, this.config.cwd, this.codexHome, locator);
    return this.images?.readResource(locator) ?? { status: 'unavailable', reason: 'Codex image reader is unavailable.' };
  }

  async dispose(): Promise<void> {
    if (this.disposed || this.released) return;
    if (!this.ownsRuntime) {
      this.released = true;
      this.observing = false;
      this.historyRefreshNeeded = true;
      this.liveQueue.close();
      this.liveQueue = new AsyncQueue<ProviderStreamItem>();
      return;
    }
    this.disposed = true;
    this.notifyRuntimeClosed();
    this.images?.stop();
    this.runtimeStatus = 'closed';
    this.resolvePendingInteractions();
    this.liveQueue.close();
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
    if (this.ownsRuntime) {
      this.runtime.terminate(new Error('Codex parent runtime is closed'));
      await this.transport.dispose();
    }
  }

  private async initialize(): Promise<void> {
    await initializeCodexTransport(this.transport);
    await this.settings.discover(this.transport);
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
    if (this.ownsRuntime) this.runtime.registerRoot(threadId);
    this.applyThreadSettings({ ...response.thread, ...response, sandboxPolicy: response.sandbox ?? response.thread.sandboxPolicy });
    if (!this.config.model) this.config.model = readString(response.model) ?? readString(response.thread.model);
    if (!this.config.cwd) this.config.cwd = readString(response.cwd) ?? readString(response.thread.cwd);
    if (!this.config.reasoningEffort) this.config.reasoningEffort = readString(response.reasoningEffort) ?? readString(response.thread.reasoningEffort);
    this.images = new CodexImageRegistry(threadId);
    this.projector = new CodexEventProjector(threadId, { images: this.images, cwd: this.config.cwd });
  }

  private finishBootstrap(
    history: ProviderObservation[],
    historyItems: ReadonlyMap<string, Record<string, unknown>>,
    priorText?: ReadonlyMap<string, string>,
    replacement = false,
  ): void {
    if (!this.threadId || !this.projector) throw new Error('Codex bootstrap has no thread');
    const historyKeys = new Set(history.map((item) => item.sourceKey));
    if (!replacement) this.initialItems = [...history, { type: 'history_boundary' }];
    for (const item of historyItems.values()) this.projector.seedHistoryItem(item);
    const historyText = this.projector.snapshotText();
    const coveredCharacters = new Map<string, number>();
    for (let raw of this.bufferedNotifications) {
      const itemId = readItemId(raw.params);
      const historyItem = itemId ? historyItems.get(itemId) : undefined;
      if (historyItem && isHistoryCoveredItemNotification(raw.method)) {
        if (raw.method !== 'item/completed') {
          if (replacement) {
            // Recovery buffers are sequence-filtered to the snapshot handoff, so their deltas remain authoritative.
            if (raw.method === 'item/started') continue;
          } else {
            if (!priorText || !itemId || !isRecord(raw.params) || typeof raw.params.delta !== 'string') continue;
            if (!coveredCharacters.has(itemId)) {
              const prior = priorText.get(itemId) ?? '';
              const current = historyText.get(itemId) ?? '';
              coveredCharacters.set(itemId, current.startsWith(prior) ? current.length - prior.length : 0);
            }
            const covered = coveredCharacters.get(itemId)!;
            const delta = raw.params.delta;
            coveredCharacters.set(itemId, Math.max(0, covered - delta.length));
            if (covered >= delta.length) continue;
            raw = { ...raw, params: { ...raw.params, delta: delta.slice(covered) } };
          }
        }
        const completedItem = readItem(raw.params);
        if (completedItem && isDeepStrictEqual(completedItem, historyItem)) continue;
      }
      if (this.handleRuntimeNotification(raw.method, raw.params)) continue;
      if (this.handleServerRequestResolved(raw.method, raw.params)) continue;
      const observation = this.projector.projectNotification(raw.method, raw.params);
      if (observation) this.applyTurnObservation(observation);
      if (observation && !historyKeys.has(observation.sourceKey)) this.preReadyEvents.push(observation);
    }
    this.bufferedNotifications.length = 0;
    if (replacement) {
      const timeline = this.preReadyEvents.filter(item => item.event.type === 'timeline');
      this.liveQueue.push({ type: 'timeline_replacement', observations: [...history, ...timeline] });
      for (const item of this.preReadyEvents) if (item.event.type !== 'timeline') this.liveQueue.push(item);
    } else {
      this.initialItems.push(...this.preReadyEvents);
    }
    this.preReadyEvents.length = 0;
    this.ready = true;
    if (this.runtimeStatus === 'starting') this.runtimeStatus = 'idle';
  }

  restoreSnapshot(snapshot: unknown, buffered: CodexRawNotification[]): void {
    if (this.disposed || !this.threadId) return;
    this.ready = false;
    this.preReadyEvents.length = 0;
    this.bufferedNotifications.length = 0;
    this.images?.stop();
    this.setThreadFromResponse(snapshot, 'thread/read');
    if (!isRecord(snapshot) || !isRecord(snapshot.thread)) throw new Error('Codex restoration returned no thread');
    const status = readThreadRuntimeStatus(snapshot.thread.status);
    if (status) this.runtimeStatus = status;
    this.acceptsDirectInput = snapshot.thread.canAcceptDirectInput === true && this.runtimeStatus !== 'closed';
    this.activeTurnId = undefined;
    if (Array.isArray(snapshot.thread.turns)) {
      const active = [...snapshot.thread.turns].reverse().find(turn => isRecord(turn) && turn.status === 'inProgress');
      if (isRecord(active)) this.activeTurnId = readString(active.id);
    }
    this.restoreInteractions();
    this.refreshInputCapabilities();
    this.bufferedNotifications.push(...buffered);
    const history = projectCodexThreadHistory(snapshot, this.threadId, { images: this.images, cwd: this.config.cwd });
    const items = collectCodexThreadHistoryItems(snapshot, this.threadId);
    this.finishBootstrap(history, items, undefined, true);
    this.emitRuntimeUpdate(this.activeTurnId ?? null);
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
    this.applyTurnObservation(observation);
    this.emit(observation);
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
    if ((observation.event.type === 'turn_canceled' || observation.event.type === 'turn_failed') && observation.event.turnId) {
      this.resolvePendingInteractions(observation.event.turnId);
    }
    if (observation.event.type === 'turn_completed' && this.acceptsDirectInput && this.config.collaborationMode === 'plan' && this.latestPlan) {
      const plan = this.latestPlan;
      this.latestPlan = undefined;
      const request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }> = {
        kind: 'plan_approval', requestId: `plan:${this.threadId}:${plan.id}`,
        plan: plan.text, allowedActions: ['approve_and_resume', 'reject'],
      };
      this.pendingInteractions.set(request.requestId, { kind: 'plan_approval', request, turnId: observation.event.turnId, resolve: () => undefined, reject: () => undefined, respond: () => undefined });
      this.emitInteractionRequested(request);
    }
  }

  private applyTurnObservation(observation: ProviderObservation): void {
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
  }

  private async respondToPlan(
    request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>,
    response: Extract<AgentInteractionResponse, { kind: 'plan_approval' }>,
  ): Promise<void> {
    if (!request.allowedActions.includes(response.action)) throw new Error(`Unsupported Codex plan action ${response.action}`);
    if (response.action !== 'reject' && 'feedback' in response) throw new Error('Codex approval cannot contain revision feedback.');
    if (this.changingSetting || this.startingTurn || this.runtimeStatus === 'running') throw new Error('Codex plan review requires an idle turn.');
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
    if (!this.ownsRuntime && method === 'thread/started' && isRecord(params) && isRecord(params.thread) && params.thread.id === this.threadId) {
      if (!this.ownsRuntime) {
        this.inputCapabilitiesRevision += 1;
        this.acceptsDirectInput = params.thread.canAcceptDirectInput === true;
        this.runtimeStatus = readThreadRuntimeStatus(params.thread.status) ?? this.runtimeStatus;
        if (this.runtimeStatus !== 'closed') this.restoreInteractions();
        this.refreshInputCapabilities();
        if (this.ready) this.emitRuntimeUpdate();
      }
      return true;
    }
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
      const wasClosed = this.runtimeStatus === 'closed';
      this.statusRevision += 1;
      this.runtimeStatus = status;
      if (status === 'closed' && !this.ownsRuntime) {
        this.inputCapabilitiesRevision += 1;
        this.acceptsDirectInput = false;
        this.refreshInputCapabilities();
        this.disableInteractions();
        this.resolvePendingInteractions();
      } else if (wasClosed && !this.ownsRuntime) {
        // Native resume can publish status changes without a thread/started notification.
        void this.refreshNativeInputCapabilities();
      }
    }

    if (this.ready && this.threadId) this.emitRuntimeUpdate();
    return true;
  }

  private applyThreadSettings(settings: Record<string, unknown>): void {
    this.settings.apply(settings);
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
    if (!this.ownsRuntime) this.refreshInputCapabilities();
    const confirmation = this.settingConfirmation;
    if (confirmation && this.settings.describe(this.config.model, this.config.reasoningEffort).find(({ id }) => id === confirmation.id)?.value === confirmation.value) {
      confirmation.resolve();
    }
  }

  private emitRuntimeUpdate(activeTurnId?: string | null): void {
    if (!this.threadId) return;
    this.runtime.sessionChanged(this.threadId);
    this.emit({
      type: 'observation',
      sourceKey: `runtime:${this.threadId}`,
      nativeRevision: ++this.runtimeRevision,
      occurredAt: Date.now(),
      delivery: 'live',
      event: {
        type: 'runtime_updated', provider: PROVIDER_ID, runtimeInfo: this.currentRuntimeInfo(),
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      },
    });
  }

  private handleServerRequestResolved(method: string, params: unknown): boolean {
    if (method !== 'serverRequest/resolved') return false;
    if (!isRecord(params)) return true;
    const nativeThreadId = readString(params.threadId);
    if (!this.threadId || nativeThreadId !== this.threadId) return true;
    const nativeRequestId = params.requestId;
    if (typeof nativeRequestId !== 'string' && typeof nativeRequestId !== 'number') return true;
    const requestId = [...this.pendingInteractions].find(([, pending]) => pending.nativeRequestId === String(nativeRequestId))?.[0];
    if (!requestId) return true;
    this.cancelInteraction(requestId);
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
    if (!this.ownsRuntime && !this.observing && this.liveQueue.trim(512)) this.historyRefreshNeeded = true;
  }

  private handleTransportTermination(error: Error): void {
    if (this.disposed || this.transportFailure) return;
    this.transportFailure = error;
    this.notifyRuntimeClosed();
    this.images?.stop();
    this.runtimeStatus = 'failed';
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
    this.resolvePendingInteractions();
    this.liveQueue.fail(error);
  }

  private resolvePendingInteractions(turnId?: string): void {
    if (turnId === undefined) this.commandInteractions.clear();
    for (const [requestId, pending] of this.pendingInteractions) {
      if (turnId === undefined || pending.turnId === turnId) this.cancelInteraction(requestId);
    }
  }

  private cancelInteraction(requestId: string): void {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return;
    this.pendingInteractions.delete(requestId);
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
    pending.reject(new CodexServerRequestCanceled('Codex native request is no longer pending'));
    const response: AgentInteractionResponse = pending.kind === 'question'
      ? { kind: 'question', answers: [], dismissed: true }
      : pending.kind === 'form' ? { kind: 'form', action: 'cancel' }
      : pending.kind === 'external_action' ? { kind: 'external_action', action: 'cancel' }
      : pending.kind === 'permission_approval' ? { kind: 'permission_approval', decision: 'deny' }
      : pending.kind === 'plan_approval' ? { kind: 'plan_approval', action: 'reject' }
      : { kind: 'tool_approval', decision: 'cancel' };
    this.emitInteractionResolved(requestId, response);
    if (pending.kind === 'permission_approval') this.emitUnavailable(requestId, 'Codex permission request closed by the native session; the remote client granted no permissions.');
  }

  private invalidatePendingInteractions(reason: string): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      this.pendingInteractions.delete(requestId);
      pending.reject(new CodexServerRequestCanceled('Codex native request was invalidated by connection recovery'));
      this.emit({
        type: 'observation', sourceKey: `interaction:${requestId}:invalidated:${this.interactionGeneration}`,
        occurredAt: Date.now(), delivery: 'live',
        event: { type: 'interaction_invalidated', provider: PROVIDER_ID, requestId, reason, ...(pending.turnId ? { turnId: pending.turnId } : {}) },
      });
    }
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
  }

  private interactionRequestId(kind: string, nativeRequestId: string | number): string {
    if (!this.sharedInteractionIdentity) return `${kind}:${String(nativeRequestId)}`;
    return `${kind}:${this.sharedInteractionIdentity}:${this.interactionGeneration}:${String(nativeRequestId)}`;
  }

  private handleQuestionRequest(params: unknown, nativeRequestId: string | number): Promise<unknown> {
    this.assertRequestThread(params);
    if (!isRecord(params) || !Array.isArray(params.questions)) {
      return Promise.reject(new Error('Codex question request has no questions'));
    }
    const questions = params.questions.map((value, index) => mapCodexQuestion(value, index));
    if (questions.length === 0) {
      return Promise.reject(new Error('Codex question request has no valid questions'));
    }
    const requestId = this.interactionRequestId('question', nativeRequestId);
    const request: Extract<AgentInteractionRequest, { kind: 'question' }> = {
      kind: 'question', requestId, questions,
    };
    return this.queueInteraction(request, (response) => {
      if (response.kind !== 'question') throw new Error('Invalid question response');
      return mapCodexQuestionResponse(request, response);
    }, readString(params.turnId), nativeRequestId);
  }

  private handleToolRequest(nativeKind: 'command' | 'file', params: unknown, id: string | number): Promise<unknown> {
    this.assertRequestThread(params);
    const mapped = mapCodexToolApproval(nativeKind, params, this.interactionRequestId('tool', id));
    return this.queueInteraction(mapped.request, mapped.respond, readString(params.turnId), id);
  }

  private handleElicitationRequest(params: unknown, id: string | number): Promise<unknown> {
    this.assertRequestThread(params);
    try {
      const request = mapCodexElicitation(params, this.interactionRequestId('elicitation', id));
      return this.queueInteraction(request, mapCodexElicitationResponse, readString(params.turnId), id);
    } catch (error) {
      this.emitUnavailable(this.interactionRequestId('elicitation', id), 'Codex elicitation unavailable: unsupported or invalid form schema or external action.');
      return Promise.resolve({ action: 'decline', content: null, _meta: null });
    }
  }

  private handlePermissionRequest(params: unknown, id: string | number): Promise<unknown> {
    this.assertRequestThread(params);
    if (this.restrictedNative) return Promise.resolve({ permissions: {}, scope: 'turn' });
    try {
      const { permissions, grant } = mapCodexPermissions(params.permissions);
      const cwd = readString(params.cwd);
      const environment = readString(params.environmentId);
      const request: Extract<AgentInteractionRequest, { kind: 'permission_approval' }> = {
        kind: 'permission_approval', requestId: this.interactionRequestId('permissions', id),
        summary: `${readString(params.reason) || 'Grant additional permissions'}${cwd ? ` (working directory: ${cwd})` : ''}${environment ? ` [environment: ${environment}]` : ''}`,
        permissions, allowScopes: ['turn', 'session'],
      };
      return this.queueInteraction(request, (response) => {
        if (response.kind !== 'permission_approval') throw new Error('Invalid permission response');
        return { permissions: response.decision === 'allow' ? grant : {}, scope: response.decision === 'allow' ? response.scope : 'turn' };
      }, readString(params.turnId), id);
    } catch {
      this.emitUnavailable(this.interactionRequestId('permissions', id), 'Codex permission approval unavailable: unsupported or invalid permission scope; no permissions granted.');
      return Promise.resolve({ permissions: {}, scope: 'turn' });
    }
  }

  private queueInteraction(request: AgentInteractionRequest, respond: NativePendingInteraction['respond'], turnId?: string, nativeRequestId?: string | number): Promise<unknown> {
    if (this.pendingInteractions.has(request.requestId)) return Promise.reject(new Error('Duplicate native request'));
    return new Promise((resolve, reject) => {
      this.pendingInteractions.set(request.requestId, { kind: request.kind, request, turnId, resolve, reject, respond,
        ...(nativeRequestId === undefined ? {} : { nativeRequestId: String(nativeRequestId) }) });
      this.emitInteractionRequested(request);
    });
  }

  private assertRequestThread(params: unknown): asserts params is Record<string, unknown> {
    if (this.disposed || this.runtimeStatus === 'closed') throw new Error('Codex session is closed');
    if (this.transportFailure) throw this.transportFailure;
    if (!isRecord(params) || !this.threadId || params.threadId !== this.threadId) throw new Error('Codex request belongs to an unknown thread');
  }

  private emitUnavailable(requestId: string, message: string): void {
    this.emit({ type: 'observation', sourceKey: `interaction:${requestId}:unavailable`, occurredAt: Date.now(), delivery: 'live',
      event: { type: 'timeline', provider: PROVIDER_ID, item: { type: 'error', message } } });
  }

  private emitInteractionRequested(request: AgentInteractionRequest): void {
    if (this.threadId) this.runtime.sessionChanged(this.threadId);
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

  private assertOpen(): void {
    if (this.disposed || this.released) throw new Error('Codex session is closed');
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

  clear(): void { this.values.length = 0; }

  trim(limit: number): boolean {
    if (this.values.length <= limit) return false;
    this.values.splice(0, this.values.length - limit);
    return true;
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
