import { RESOURCE_INPUT_CAPABILITIES } from '@orchardworks/agent-provider-sdk';
import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import {ClaudeNativeProcess} from './native-process.js';
import { claudeMessageContent } from './message-content.js';
import { randomUUID } from 'node:crypto';
import { query, type Options, type ModelInfo, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentCapabilities, AgentInputAcceptance, AgentInputPart, AgentInteractionResponse, AgentMessageOptions, AgentRuntimeInfo, AgentSession, AgentSessionConfig,
  AgentStreamEvent, AgentNativeValidityToken, AgentPromptEditEvidence, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { IMAGE_INPUT_CAPABILITIES, validateSessionSetting, type AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import { Channel, deadline, DeadlineError } from './channel.js';
import { ClaudeInteractions } from './interactions.js';
import { ClaudeUsage } from './usage.js';
import { ClaudeImageRegistry } from './images.js';
import { ClaudeEventProjector } from './projector.js';
import { discoverClaudeCommands } from './commands.js';
import { ClaudeChildren } from './children.js';
import { createClaudeCatalog, type ClaudeCatalog, type ClaudeTimelineMessage } from './catalog.js';
import { createClaudeSessionTools } from './session-tools.js';
import { ClaudeNativeEvidence, claudeEmptyHandle } from './native-evidence.js';
import { CLAUDE_ALLOWS_BYPASS_PERMISSIONS, claudePermissionModeOptions, claudeSandbox, isResumableClaudePermissionMode, type ResumableClaudePermissionMode } from './permission-modes.js';

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'setPermissionMode' | 'close' | 'supportedCommands' | 'reloadSkills' | 'supportedModels' | 'setModel'> & Partial<Pick<Query, 'applyFlagSettings' | 'getContextUsage'>> & {
  /** The pinned SDK implements this control without declaring it on public Query. */
  getSettings?: () => Promise<unknown>;
  /** The pinned SDK forwards cancelQueued without declaring it on public Query; the response lists cancelled input. */
  interrupt(options?: { cancelQueued?: boolean }): Promise<unknown>;
};
/** Native capabilities that make input during a turn observable and stoppable. */
const STEER_CAPABILITIES = ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'] as const;
export interface ClaudeSessionOptions {
  executable?: string;
  /** Adapter-owned descriptor, only supplied after provider validation. */
  emptyDescriptor?: boolean;
  /** Native history is authoritative for the model after materialization. */
  restoreNativeModel?: boolean;
  restrictedNative?: boolean;
  /** Remembers each session's confirmed permission mode, so a reopened session keeps it. */
  permissionModes?: ClaudePermissionModeStore;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  catalog?: ClaudeCatalog;
  onDispose?: () => void;
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
}

export interface ClaudeSessionConfig extends AgentSessionConfig { permissionMode?: PermissionMode }

/** Host-owned storage of the permission mode a session's owner last confirmed. */
export interface ClaudePermissionModeStore {
  read(sessionId: string): Promise<ResumableClaudePermissionMode | undefined>;
  write(sessionId: string, mode: ResumableClaudePermissionMode): Promise<void>;
}

/** Retains the owned runtime when failed startup could not confirm native shutdown. */
export class ClaudeShutdownError extends Error {
  constructor(readonly session: ClaudeAgentSession, cause: unknown) {
    super('Claude native shutdown is unconfirmed.', {cause});
  }
}

export class ClaudeAgentSession implements AgentSession {
  readonly nativeEvidence: ClaudeNativeEvidence;
  /** Prompt edits branch from the native transcript, so readiness is the session's own quiescence. */
  readonly promptEditEvidence: AgentPromptEditEvidence = Object.freeze({
    version: 1 as const,
    inspectReadiness: () => this.nativeEvidence.inspectReadiness(),
    captureValidity: () => this.nativeEvidence.captureValidity(),
    isCurrent: (token: AgentNativeValidityToken) => this.nativeEvidence.isCurrent(token),
  });
  private acceptance?: AgentMessageOptions['onAcceptance'];
  readonly capabilities: AgentCapabilities = { resourceInput: RESOURCE_INPUT_CAPABILITIES, imageInput: IMAGE_INPUT_CAPABILITIES, history: true, sendMessage: true, steer: true, cancel: true, readResource: true,
    planning: true, commands: true, sessionSettings: true, interactions: { question: true, toolApproval: true, planApproval: true } };
  private readonly input = new Channel<SDKUserMessage>();
  /** Input submitted during an active turn. The native runtime folds it into that turn or runs it next, as its command lifecycle reports. */
  private readonly steering = new Map<string, { message: SDKUserMessage & { uuid: ReturnType<typeof randomUUID> }; started: boolean;
    onAcceptance?: AgentMessageOptions['onAcceptance']; onWithdrawn?: AgentMessageOptions['onWithdrawn'] }>();
  /** Reported by native initialization with the first turn; unknown until then. */
  private nativeCapabilities?: ReadonlySet<string>;
  private readonly output = new Channel<ProviderStreamItem>();
  private readonly projector: ClaudeEventProjector;
  private readonly images: ClaudeImageRegistry;
  private readonly history: ProviderStreamItem[];
  private readonly children: ClaudeChildren;
  private readonly interactions: ClaudeInteractions;
  private readonly sourceId = randomUUID();
  private readonly usage = new ClaudeUsage();
  private readonly resultIds = new Set<string>();
  private readonly timeout: number;
  private sequence = 0;
  private status: AgentRuntimeInfo['status'] = 'starting';
  private turnId: ReturnType<typeof randomUUID> | undefined;
  private cancelRequested = false;
  private planning = false;
  private permissionMode: PermissionMode = 'default';
  private resumePermissionMode: ResumableClaudePermissionMode = 'default';
  /** The mode the permission store holds for this session, and its pending writes in order. */
  private storedPermissionMode: ResumableClaudePermissionMode = 'default';
  private permissionModeWrites = Promise.resolve();
  /** The sandbox flag setting the native process applies, as JSON; YOLO lifts it. */
  private sandbox = 'null';
  private models: ModelInfo[] = [];
  private appliedEffort: string | null | undefined;
  private settingsRevision = 0;
  private nativeModelConfirmed: boolean;
  private inputDispatched: boolean;
  private changingSetting = false;
  private preparingMessage = false;
  private observing = false;
  private disposed = false;
  private failure: Error | undefined;
  private native!: ClaudeQuery;
  private hostTools?: ReturnType<typeof createClaudeSessionTools>;
  private readonly process: ClaudeNativeProcess;
  private closing?: Promise<void>;
  private pump!: Promise<void>;

  private constructor(private readonly config: ClaudeSessionConfig, private readonly options: ClaudeSessionOptions,
    messages: ClaudeTimelineMessage[]) {
    this.inputDispatched = messages.some(message => message.type === 'user');
    this.nativeModelConfirmed = !options.restoreNativeModel;
    this.process = new ClaudeNativeProcess(options.onDiagnostic);
    this.timeout = options.requestTimeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new Error('Claude request timeout must be positive.');
    this.planning = config.planning ?? false;
    // The owner's last confirmed mode is kept on restricted Hosts too; YOLO there also lifts the sandbox.
    this.resumePermissionMode = isResumableClaudePermissionMode(config.permissionMode) ? config.permissionMode : 'default';
    this.storedPermissionMode = this.resumePermissionMode;
    this.permissionMode = this.planning ? 'plan' : this.resumePermissionMode;
    this.images = new ClaudeImageRegistry(config.sessionId);
    this.projector = new ClaudeEventProjector(config.sessionId, 'live', this.images);
    const history = new ClaudeEventProjector(config.sessionId, 'history', this.images);
    this.history = messages.flatMap(message => history.project(message).map(observation => message.turnId && observation.type === 'observation'
      && observation.event.type !== 'runtime_updated' && observation.event.type !== 'thread_started' ? { ...observation, event: { ...observation.event, turnId: message.turnId } } : observation));
    this.children = new ClaudeChildren(config.sessionId, config.cwd,
      options.catalog ?? createClaudeCatalog(options.env ?? {}, this.timeout), () => this.runtimeUpdated());
    this.nativeEvidence = new ClaudeNativeEvidence({ id: config.sessionId, cwd: config.cwd ?? process.cwd(), options,
      open: () => !this.disposed && !this.failure, mutable: () => this.nativeModelConfirmed && !this.changingSetting && !this.preparingMessage,
      counts: () => ({ pendingInteractions: this.interactions?.size ?? 0, activeChildren: this.children.descriptors().filter(child => child.status === 'running' || child.status === 'waiting').length, pendingInput: this.inputPending() }),
      selections: () => ({ model: this.config.model ?? 'default', reasoningEffort: this.appliedEffort === undefined ? this.config.reasoningEffort ?? 'default' : this.appliedEffort ?? 'default',
        ...(this.config.systemPrompt !== undefined ? { system: this.config.systemPrompt } : {}),
        providerOptions: JSON.stringify({ permissionMode: this.permissionMode, planning: this.planning, ...(this.config.instructions ? { instructions: this.config.instructions } : {}) }) }),
      messages: () => (options.catalog ?? createClaudeCatalog(options.env ?? {}, this.timeout)).messages(config.sessionId),
      dispatch: (text, inputId) => {
        this.assertMessageReady({});
        if (this.turnId || this.steering.size) throw new AgentOperationRejectedError('operation_rejected', 'Claude already has an active turn.');
        this.dispatchMessage(text, inputId);
      },
    });
    this.interactions = new ClaudeInteractions((event) => {
      this.emit(event);
      this.status = this.interactions.size ? 'waiting' : this.turnId ? 'running' : 'idle';
      this.runtimeUpdated();
    }, async () => {
      if (this.changingSetting) throw new AgentOperationRejectedError('operation_rejected', 'Claude already has a setting change in progress.');
      this.changingSetting = true;
      try {
        await this.updatePermissionMode(this.resumePermissionMode);
        this.runtimeUpdated();
      } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
    });
  }

  static async open(config: ClaudeSessionConfig, options: ClaudeSessionOptions = {}, messages: ClaudeTimelineMessage[] = [], resume = false): Promise<ClaudeAgentSession> {
    if (config.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)) throw new Error('Unsupported Claude reasoning effort.');
    const session = new ClaudeAgentSession(config, options, messages);
    try {
      if (config.tools?.length) session.hostTools = createClaudeSessionTools(config.tools, () => session.requireOpen());
      if (resume) await session.children.restore();
      const sandbox = claudeSandbox(session.permissionMode, !!options.restrictedNative);
      session.sandbox = JSON.stringify(sandbox);
      session.native = (options.query ?? query)({ prompt: session.input, options: {
        ...(resume ? { resume: config.sessionId } : { sessionId: config.sessionId }), cwd: config.cwd,
        model: config.model, ...(config.reasoningEffort ? { effort: config.reasoningEffort as Options['effort'] } : {}),
        pathToClaudeCodeExecutable: options.executable ?? 'claude', env: { ...process.env, ...options.env },
        includePartialMessages: true, forwardSubagentText: true, persistSession: true, settingSources: ['user', 'project', 'local'],
        systemPrompt: config.systemPrompt !== undefined ? [config.systemPrompt, config.instructions].filter(value => value !== undefined && value !== '').join('\n\n')
          : { type: 'preset', preset: 'claude_code', ...(config.instructions ? { append: config.instructions } : {}) },
        ...(session.hostTools ? { mcpServers: { agent_host: session.hostTools } } : {}),
        ...(sandbox ? { sandbox } : {}),
        permissionMode: session.permissionMode, allowDangerouslySkipPermissions: CLAUDE_ALLOWS_BYPASS_PERMISSIONS, canUseTool: session.interactions.request,
        hooks: { Stop: [{ hooks: [async input => { if (input.hook_event_name === 'Stop') session.nativeEvidence.noteStop(input); return {}; }] }] },
        stderr: options.onDiagnostic, spawnClaudeCodeProcess: session.process.spawn,
      } });
      session.pump = session.consume();
      const initialized = await deadline(session.native.initializationResult(), session.timeout, 'Claude initialization');
      session.models = initialized.models ?? [];
      if (session.native.applyFlagSettings && session.native.getSettings) {
        try { await session.readNativeSettings(false, options.restoreNativeModel); }
        catch { session.appliedEffort = undefined; }
      }
      if (session.failure) throw session.failure;
      session.status = 'idle';
      session.nativeEvidence.initialize();
      session.runtimeUpdated();
      if (resume) void session.reportContext();
      return session;
    } catch (error) {
      try { await session.dispose(); } catch (shutdownError) { throw new ClaudeShutdownError(session, shutdownError); }
      throw error;
    }
  }

  /**
   * A reopened conversation reports how full its context is before the next turn, so the owner can tell whether
   * to compact here or edit an earlier prompt first. Best effort: an older runtime or a slow count leaves it unreported.
   */
  private async reportContext(): Promise<void> {
    if (!this.native.getContextUsage) return;
    try {
      const usage = await deadline(this.native.getContextUsage(), this.timeout, 'Claude context usage');
      if (this.disposed || this.failure || this.turnId || !Number.isSafeInteger(usage.totalTokens) || !Number.isSafeInteger(usage.rawMaxTokens)
        || usage.totalTokens < 0 || usage.rawMaxTokens <= 0) return;
      this.emit({ type: 'usage_updated', provider: 'claude', usage: { contextScope: 'current', contextWindowUsedTokens: usage.totalTokens, contextWindowMaxTokens: usage.rawMaxTokens } });
    } catch { /* Context usage is informational. */ }
  }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observing) throw new Error('Claude session already has an observer.');
    this.observing = true;
    yield* this.history;
    yield { type: 'history_boundary' };
    yield* this.output;
  }

  async sendMessage(text: string, options: AgentMessageOptions = {}): Promise<void> {
    this.assertMessageReady(options);
    if (!text.trim()) throw new AgentOperationRejectedError('operation_rejected', 'Claude message cannot be empty.');
    if (this.inputPending()) this.steerMessage(text, options);
    else this.dispatchMessage(text, undefined, options);
  }

  async steer(text: string, options: AgentMessageOptions = {}): Promise<void> {
    this.assertMessageReady(options);
    if (!this.turnId) throw new AgentOperationRejectedError('operation_rejected', 'Claude has no active turn.');
    if (!text.trim()) throw new AgentOperationRejectedError('operation_rejected', 'Claude message cannot be empty.');
    this.steerMessage(text, options);
  }

  async sendMessageContent(parts: readonly AgentInputPart[], options: AgentMessageOptions = {}): Promise<void> {
    this.assertMessageReady(options);
    if (!parts.some(part => part.type !== 'text' || part.text.trim())) throw new AgentOperationRejectedError('operation_rejected', 'Claude message cannot be empty.');
    const snapshot = parts.map(part => ({ ...part }));
    this.preparingMessage = true;
    try {
      const content = await prepareAgentOperation(() => claudeMessageContent(snapshot));
      this.requireOpen();
      if (this.inputPending()) this.steerMessage(content, options);
      else this.dispatchMessage(content, undefined, options);
    } finally { this.preparingMessage = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  private assertMessageReady(options: AgentMessageOptions): void {
    this.requireOpen();
    if (options.delivery === 'next_turn') throw new AgentOperationRejectedError('operation_rejected', 'Claude queued delivery is not supported.');
    if (this.changingSetting || this.preparingMessage) throw new AgentOperationRejectedError('operation_rejected', 'Claude already has a setting change or message submission in progress.');
  }

  private dispatchMessage(content: SDKUserMessage['message']['content'], turnId = randomUUID(), options: AgentMessageOptions = {}): void {
    const message = { type: 'user' as const, uuid: turnId, session_id: this.config.sessionId,
      parent_tool_use_id: null, message: { role: 'user' as const, content } };
    this.input.push(message);
    this.acceptance = options.onAcceptance;
    this.beginTurn(message);
  }

  private beginTurn(message: SDKUserMessage & { uuid: ReturnType<typeof randomUUID> }): void {
    this.turnId = message.uuid;
    this.inputDispatched = true;
    this.nativeEvidence.noteDispatch(message.uuid);
    this.usage.startTurn();
    this.status = 'running';
    this.cancelRequested = false;
    this.emit({ type: 'turn_started', provider: 'claude', turnId: message.uuid });
    for (const observation of this.projector.project(message)) this.output.push({ ...observation, event: this.withTurn(observation.event) });
    this.runtimeUpdated();
  }

  /** A turn is running or steered input has not yet started, so new input must follow it through the native queue. */
  private inputPending(): boolean {
    return Boolean(this.turnId) || [...this.steering.values()].some(steered => !steered.started);
  }

  /** Native streaming input accepts a message mid-turn; acceptance follows its command lifecycle. */
  private steerMessage(content: SDKUserMessage['message']['content'], options: AgentMessageOptions): void {
    if (this.nativeCapabilities && STEER_CAPABILITIES.some(capability => !this.nativeCapabilities!.has(capability))) {
      throw new AgentOperationRejectedError('operation_rejected', 'This Claude Code version cannot accept input while a turn is running. Wait for the turn to finish or update Claude Code.');
    }
    const message = { type: 'user' as const, uuid: randomUUID(), session_id: this.config.sessionId,
      parent_tool_use_id: null, message: { role: 'user' as const, content } };
    this.steering.set(message.uuid, { message, started: false, onAcceptance: options.onAcceptance, onWithdrawn: options.onWithdrawn });
    this.input.push(message);
  }

  private noteCommandLifecycle(commandUuid: string, state: string): void {
    const steered = this.steering.get(commandUuid);
    if (!steered) return;
    if (state === 'queued') this.acceptSteered(steered, 'queued');
    else if (state === 'started' && !steered.started) {
      // A command that starts while the turn is still active was folded into it; otherwise it runs as the next turn.
      if (this.turnId) {
        steered.started = true;
        for (const observation of this.projector.project(steered.message)) this.output.push({ ...observation, event: this.withTurn(observation.event) });
        this.acceptSteered(steered, 'handled');
      } else this.startSteeredTurn(steered);
    } else if (state === 'cancelled') this.withdrawSteered(commandUuid);
    else if (state === 'completed') this.steering.delete(commandUuid);
  }

  /** Input removed from the native queue before it ran keeps its text visible, marked as never sent. */
  private withdrawSteered(commandUuid: string): void {
    const steered = this.steering.get(commandUuid);
    if (!steered) return;
    this.steering.delete(commandUuid);
    if (steered.started) return;
    for (const observation of this.projector.project(steered.message)) {
      const event = observation.event.type === 'timeline' && observation.event.item.type === 'user_message'
        ? { ...observation.event, item: { ...observation.event.item, withdrawn: { reason: 'stopped' as const } } } : observation.event;
      this.output.push({ ...observation, event: this.withTurn(event) });
    }
    try { steered.onWithdrawn?.({ reason: 'stopped' }); } catch { /* Observers cannot fail the native runtime. */ }
  }

  private startSteeredTurn(steered: NonNullable<ReturnType<typeof this.steering.get>>): void {
    steered.started = true;
    this.beginTurn(steered.message);
    this.acceptSteered(steered, 'started');
  }

  private acceptSteered(steered: NonNullable<ReturnType<typeof this.steering.get>>, disposition: AgentInputAcceptance['disposition']): void {
    try { steered.onAcceptance?.({ disposition }); } catch { /* Observers cannot fail the native runtime. */ }
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.requireOpen(); await this.interactions.respond(requestId, response);
  }

  async listCommands() {
    this.requireOpen();
    const commands = await deadline(discoverClaudeCommands(this.native), this.timeout, 'Claude command discovery');
    this.requireOpen();
    return commands;
  }

  async executeCommand(id: string, args: string) {
    this.requireOpen();
    if (this.turnId || this.changingSetting || this.preparingMessage) throw new AgentOperationRejectedError('operation_rejected', 'Claude commands require an idle session.');
    this.changingSetting = true;
    try {
      const command = (await prepareAgentOperation(() => this.listCommands())).find((entry) => entry.id === id);
      if (!command) throw new AgentOperationRejectedError('operation_rejected', 'Claude command is unavailable in this session.');
      this.changingSetting = false;
      await this.sendMessage(`/${command.name}${args ? ` ${args}` : ''}`);
      return {};
    } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  /** Stop ends the running turn and removes input still waiting in the native queue. */
  async cancel(): Promise<void> {
    this.requireOpen();
    if (!this.inputPending()) return;
    if (this.turnId) this.cancelRequested = true;
    this.interactions.cancelAll();
    let response: unknown;
    try { response = await deadline(this.native.interrupt({ cancelQueued: true }), this.timeout, 'Claude interrupt'); }
    catch (error) { this.fail(error); this.native.close(); throw error; }
    // The receipt lists cancelled input even when its lifecycle notification has not arrived yet.
    const cancelled = response && typeof response === 'object' && 'cancelled' in response && Array.isArray(response.cancelled) ? response.cancelled : [];
    for (const uuid of cancelled) if (typeof uuid === 'string') this.withdrawSteered(uuid);
  }

  async setSessionSetting(id: string, value: string): Promise<void | { status: 'deferred' }> {
    this.requireOpen();
    if (this.changingSetting || this.preparingMessage) return { status: 'deferred' };
    this.changingSetting = true;
    try {
      if (id === 'model' || id === 'reasoning_effort') this.models = await prepareAgentOperation(() => deadline(this.native.supportedModels(), this.timeout, 'Claude model discovery'));
      this.requireOpen();
      validateSessionSetting(this.settings(), id, value);
      if (id === 'model') {
        await this.updateNative(this.native.setModel(value), 'Claude model update');
        if (this.disposed) throw new Error('Claude closed before model confirmation.');
        this.settingsRevision++;
        this.config.model = value;
        if (this.appliedEffort !== undefined) {
          try { await this.readNativeSettings(); }
          catch { this.appliedEffort = undefined; }
        }
      } else if (id === 'reasoning_effort') {
        await this.updateNative(this.native.applyFlagSettings!({ effortLevel: value === 'default' ? null : value as Options['effort'] }), 'Claude effort update');
        if (this.disposed) throw new Error('Claude closed before effort confirmation.');
        this.settingsRevision++;
        await this.readNativeSettings();
        if (value === 'default' || this.appliedEffort === null) delete this.config.reasoningEffort;
        else this.config.reasoningEffort = this.appliedEffort;
        this.runtimeUpdated();
        if (value !== 'default' && value !== this.appliedEffort) throw new AgentOperationRejectedError('operation_rejected', `Claude applied ${this.appliedEffort ?? 'no effort parameter'} instead of requested effort ${value}.`);
      } else await this.updatePermissionMode(value as PermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  async setPlanning(active: boolean): Promise<void> {
    this.requireOpen();
    if (this.inputPending() || this.changingSetting || this.preparingMessage) throw new AgentOperationRejectedError('operation_rejected', 'Claude planning can only change while idle.');
    this.changingSetting = true;
    try {
      await this.updatePermissionMode(active ? 'plan' : this.resumePermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  /** The sandbox is lifted only after YOLO is confirmed and restored before any other mode applies. */
  private async updatePermissionMode(mode: PermissionMode): Promise<void> {
    if (mode !== 'bypassPermissions') await this.applySandbox(mode);
    await this.updateNative(this.native.setPermissionMode(mode), 'Claude permission update');
    if (this.disposed) throw new Error('Claude closed before permission confirmation.');
    this.confirmPermissionMode(mode);
    if (mode === 'bypassPermissions') await this.applySandbox(mode);
  }
  private async applySandbox(mode: PermissionMode): Promise<void> {
    const sandbox = claudeSandbox(mode, !!this.options.restrictedNative), applied = JSON.stringify(sandbox);
    if (applied === this.sandbox) return;
    if (!this.native.applyFlagSettings) {
      // Without a Host sandbox, the user's own settings keep governing a native process that cannot change it.
      if (!this.options.restrictedNative) return;
      throw new AgentOperationRejectedError('operation_rejected', 'This Claude Code version cannot change its sandbox during a session. Update Claude Code.');
    }
    await this.updateNative(this.native.applyFlagSettings({ sandbox }), 'Claude sandbox update');
    if (this.disposed) throw new Error('Claude closed before sandbox confirmation.');
    this.sandbox = applied;
  }
  private async updateNative(operation: Promise<void>, label: string): Promise<void> {
    try { await deadline(operation, this.timeout, label); }
    catch (error) { if (error instanceof DeadlineError) this.fail(error); throw error; }
  }
  private confirmPermissionMode(mode: PermissionMode): void {
    this.settingsRevision++;
    this.permissionMode = mode;
    this.planning = mode === 'plan';
    if (!this.planning) this.resumePermissionMode = isResumableClaudePermissionMode(mode) ? mode : 'default';
    this.rememberPermissionMode();
  }
  private rememberPermissionMode(): void {
    const store = this.options.permissionModes, mode = this.resumePermissionMode;
    if (!store || mode === this.storedPermissionMode) return;
    this.storedPermissionMode = mode;
    this.permissionModeWrites = this.permissionModeWrites.then(() => store.write(this.config.sessionId, mode)).catch(() => {
      this.options.onDiagnostic?.('Claude permission mode could not be saved; a reopened session may start in its previous mode.');
    });
  }
  private async readNativeSettings(refreshModel = false, restoreModel = false): Promise<void> {
    const revision = this.settingsRevision;
    try {
      const response = await deadline(this.native.getSettings!(), this.timeout, 'Claude applied effort readback');
      if (this.disposed || revision !== this.settingsRevision) return;
      const applied = (response as { applied?: { model?: unknown; effort?: unknown } } | null)?.applied;
      const effort = applied?.effort;
      if (effort !== null && (typeof effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))) throw new Error('Claude did not report applied effort.');
      this.settingsRevision++;
      this.appliedEffort = effort;
      if (this.config.reasoningEffort !== undefined) {
        if (effort === null) delete this.config.reasoningEffort;
        else this.config.reasoningEffort = effort;
      }
      const model = applied?.model;
      const selected = this.config.model;
      if (restoreModel && typeof model === 'string' && model.length > 0) { this.config.model = model; this.nativeModelConfirmed = true; }
      if (refreshModel && typeof model === 'string' && model.length > 0 && selected !== undefined && selected !== 'default') {
        const metadata = this.models.find(entry => entry.value === selected);
        if (model !== selected && model !== metadata?.resolvedModel) this.config.model = model;
      }
    } catch (error) {
      if (this.disposed || revision !== this.settingsRevision) return;
      this.settingsRevision++;
      this.appliedEffort = undefined;
      throw error;
    }
  }
  private settings(): AgentSessionSetting[] {
    const model = this.config.model ?? (this.models.some(model => model.value === 'default') ? 'default' : null);
    const settings: AgentSessionSetting[] = [{ id: 'model', category: 'model', label: 'Model', value: model,
      options: this.models.map((model) => ({ value: model.value, label: model.displayName, description: model.description })),
      mutable: true, scope: 'session' },
    { id: 'permissions', category: 'permissions', label: 'Permissions', value: this.permissionMode,
      options: claudePermissionModeOptions(this.permissionMode),
      mutable: true, scope: 'session' }];
    const metadata = this.models.find(entry => entry.value === model || entry.resolvedModel === model);
    if (metadata?.supportsEffort && metadata.supportedEffortLevels?.length && this.appliedEffort !== undefined && this.native.applyFlagSettings && this.native.getSettings) {
      settings.push({ id: 'reasoning_effort', category: 'model', label: 'Reasoning effort',
        value: this.config.reasoningEffort === undefined ? 'default' : this.appliedEffort,
        options: [{ value: 'default', label: 'Native default' }, ...metadata.supportedEffortLevels.map(value => ({ value, label: value }))],
        mutable: true, scope: 'session', description: `Native default clears the session flag override. Applied effort: ${this.appliedEffort ?? 'no effort parameter'}. Changes apply to subsequent native requests.` });
    }
    return settings;
  }

  async runtimeInfo(options?: { refreshSettings?: boolean }): Promise<AgentRuntimeInfo> {
    if (options?.refreshSettings && !this.disposed && !this.failure && this.native.getSettings) await this.readNativeSettings(true);
    return this.info();
  }
  async readResource(locator: string) { return this.images.readResource(locator); }
  async openChildSession(nativeSessionId: string): Promise<AgentSession> { return this.children.open(nativeSessionId); }
  async release(): Promise<void> {
    await this.dispose();
    await this.process.waitForExit(10000);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const firstClose = !this.disposed;
    if (firstClose) {
      this.disposed = true;
      this.process.requestShutdown();
      this.images.stop();
      this.interactions.close();
      this.status = 'closed';
      this.input.close(); this.steering.clear();
      this.native?.close();
    }
    return this.closing = (async () => {
      await this.children.close();
      if (this.hostTools) await this.hostTools.instance.close();
      if (firstClose) {
        if (!this.failure) this.runtimeUpdated();
        this.output.close();
      }
      if (this.process.started) await this.process.waitForExit(10000);
      if (this.pump) await deadline(this.pump, 5000, 'Claude shutdown');
      this.options.onDispose?.();
    })().catch(error => { this.closing = undefined; throw error; });
  }

  private requireOpen(): void {
    if (this.disposed) throw new AgentOperationRejectedError('operation_rejected', 'Claude session is closed.');
    if (this.failure) throw new AgentOperationRejectedError('native_runtime_unavailable', this.failure.message);
  }
  selectionConfig(): Partial<ClaudeSessionConfig> {
    this.requireOpen();
    return { ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      ...(this.config.reasoningEffort !== undefined ? { reasoningEffort: this.config.reasoningEffort } : {}),
      ...(this.config.systemPrompt !== undefined ? { systemPrompt: this.config.systemPrompt } : {}),
      planning: this.planning, permissionMode: this.resumePermissionMode };
  }
  private info(): AgentRuntimeInfo {
    return { providerId: 'claude', sessionId: this.config.sessionId, status: this.status, cwd: this.config.cwd,
      model: this.config.model ?? null, planning: { active: this.planning }, settings: this.settings(), childSessions: this.children.descriptors(),
      persistence: this.options.emptyDescriptor && !this.inputDispatched ? claudeEmptyHandle({ ...this.config, planning: this.planning, permissionMode: this.resumePermissionMode }, this.options) : { providerId: 'claude', sessionId: this.config.sessionId, opaque: JSON.stringify({ ...persistedConfig(this.config), planning: this.planning, permissionMode: this.resumePermissionMode }) } };
  }
  private runtimeUpdated(): void { this.nativeEvidence.invalidate(); this.emit({ type: 'runtime_updated', provider: 'claude', runtimeInfo: this.info(), activeTurnId: this.turnId ?? null }); }
  private emit(event: AgentStreamEvent): void {
    this.output.push({ type: 'observation', sourceKey: `claude:${this.sourceId}:${++this.sequence}`, occurredAt: Date.now(), delivery: 'live',
      event: this.withTurn(event) });
  }
  private withTurn(event: AgentStreamEvent): AgentStreamEvent {
    return this.turnId && event.type !== 'runtime_updated' && event.type !== 'thread_started' ? { ...event, turnId: this.turnId } : event;
  }
  private fail(error: unknown): void {
    if (this.disposed || this.failure) return;
    this.failure = new Error(error instanceof Error ? error.message : String(error));
    this.images.stop();
    this.interactions.cancelAll();
    if (this.turnId) this.emit({ type: 'turn_failed', provider: 'claude', error: this.failure.message });
    this.turnId = undefined;
    this.status = 'failed';
    void this.children.close();
    this.runtimeUpdated();
    this.output.fail(this.failure);
    this.input.close(); this.steering.clear();
    this.native.close();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.native) {
        if (this.disposed) break;
        if (message.session_id && message.session_id !== this.config.sessionId) throw new Error('Claude returned a different native session identity.');
        const lifecycle = message as { type: string; command_uuid?: unknown; state?: unknown };
        if (lifecycle.type === 'command_lifecycle') {
          if (typeof lifecycle.command_uuid === 'string' && typeof lifecycle.state === 'string') this.noteCommandLifecycle(lifecycle.command_uuid, lifecycle.state);
          continue;
        }
        if (this.nativeEvidence.noteMessage(message)) {
          const acceptance = this.acceptance; this.acceptance = undefined;
          try { acceptance?.({ disposition: 'started' }); } catch { /* Observers cannot fail the native runtime. */ }
        }
        this.children.consume(message, this.turnId);
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) continue;
        if (message.type === 'result') {
          if (this.resultIds.has(message.uuid)) continue;
          this.resultIds.add(message.uuid);
          if (message.user_message_uuid && message.user_message_uuid !== this.turnId) continue;
        }
        const context = this.usage.observe(message, this.config.model);
        if (context) this.emit({ type: 'usage_updated', provider: 'claude', usage: context });
        for (const observation of this.projector.project(message)) this.output.push({ ...observation,
          event: this.withTurn(observation.event) });
        if (message.type === 'system' && message.subtype === 'init') {
          const capabilities = (message as { capabilities?: unknown }).capabilities;
          this.nativeCapabilities = new Set(Array.isArray(capabilities) ? capabilities.filter((value): value is string => typeof value === 'string') : []);
          this.config.model = message.model;
          this.nativeModelConfirmed = true;
          this.confirmPermissionMode(message.permissionMode);
          this.runtimeUpdated();
        }
        if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
          this.confirmPermissionMode(message.permissionMode);
          this.runtimeUpdated();
        }
        if (message.type !== 'result' || !this.turnId) continue;
        this.children.finishTurn();
        this.interactions.cancelAll();
        const usage = this.usage.result(message, this.config.model);
        if (this.cancelRequested || message.is_error || message.subtype !== 'success') {
          if (Object.keys(usage).length) this.emit({ type: 'usage_updated', provider: 'claude', usage });
        }
        if (this.cancelRequested) this.emit({ type: 'turn_canceled', provider: 'claude', reason: 'Interrupted by the user.' });
        else if (message.is_error || message.subtype !== 'success') this.emit({ type: 'turn_failed', provider: 'claude',
          error: 'errors' in message ? message.errors.join('\n') : 'Claude turn failed.' });
        else this.emit({ type: 'turn_completed', provider: 'claude', usage });
        this.turnId = undefined;
        this.cancelRequested = false;
        this.status = 'idle';
        this.runtimeUpdated();
      }
      if (!this.disposed) this.fail(new Error('Claude runtime exited. Resume the saved session to reconnect.'));
    } catch (error) { this.fail(error); }
  }
}

function persistedConfig({ tools: _tools, ...config }: ClaudeSessionConfig) { return config; }
