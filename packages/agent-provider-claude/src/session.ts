import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import {ClaudeNativeProcess} from './native-process.js';
import { claudeMessageContent } from './message-content.js';
import { randomUUID } from 'node:crypto';
import { query, type Options, type ModelInfo, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentCapabilities, AgentInputPart, AgentInteractionResponse, AgentMessageOptions, AgentRuntimeInfo, AgentSession, AgentSessionConfig,
  AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { IMAGE_INPUT_CAPABILITIES, validateSessionSetting, type AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import { Channel, deadline, DeadlineError } from './channel.js';
import { ClaudeInteractions } from './interactions.js';
import { ClaudeUsage } from './usage.js';
import { ClaudeImageRegistry } from './images.js';
import { ClaudeEventProjector } from './projector.js';
import { discoverClaudeCommands } from './commands.js';
import { ClaudeChildren } from './children.js';
import { createClaudeCatalog, type ClaudeCatalog } from './catalog.js';

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'interrupt' | 'setPermissionMode' | 'close' | 'supportedCommands' | 'reloadSkills' | 'supportedModels' | 'setModel'> & Partial<Pick<Query, 'applyFlagSettings'>> & {
  /** The pinned SDK implements this control without declaring it on public Query. */
  getSettings?: () => Promise<unknown>;
};
export interface ClaudeSessionOptions {
  executable?: string;
  restrictedNative?: boolean;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  catalog?: ClaudeCatalog;
  onDispose?: () => void;
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
}

export interface ClaudeSessionConfig extends AgentSessionConfig { permissionMode?: PermissionMode }

/** Retains the owned runtime when failed startup could not confirm native shutdown. */
export class ClaudeShutdownError extends Error {
  constructor(readonly session: ClaudeAgentSession, cause: unknown) {
    super('Claude native shutdown is unconfirmed.', {cause});
  }
}

export class ClaudeAgentSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { imageInput: IMAGE_INPUT_CAPABILITIES, history: true, sendMessage: true, steer: false, cancel: true, readResource: true,
    planning: true, commands: true, sessionSettings: true, interactions: { question: true, toolApproval: true, planApproval: true } };
  private readonly input = new Channel<SDKUserMessage>();
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
  private resumePermissionMode: PermissionMode = 'default';
  private models: ModelInfo[] = [];
  private appliedEffort: string | null | undefined;
  private settingsRevision = 0;
  private changingSetting = false;
  private preparingMessage = false;
  private observing = false;
  private disposed = false;
  private failure: Error | undefined;
  private native!: ClaudeQuery;
  private readonly process: ClaudeNativeProcess;
  private closing?: Promise<void>;
  private pump!: Promise<void>;

  private constructor(private readonly config: ClaudeSessionConfig, private readonly options: ClaudeSessionOptions,
    messages: SessionMessage[]) {
    this.process = new ClaudeNativeProcess(options.onDiagnostic);
    this.timeout = options.requestTimeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new Error('Claude request timeout must be positive.');
    this.planning = config.planning ?? false;
    this.resumePermissionMode = !options.restrictedNative && ['default', 'acceptEdits', 'dontAsk'].includes(config.permissionMode ?? '') ? config.permissionMode! : 'default';
    this.permissionMode = this.planning ? 'plan' : this.resumePermissionMode;
    this.images = new ClaudeImageRegistry(config.sessionId);
    this.projector = new ClaudeEventProjector(config.sessionId, 'live', this.images);
    const history = new ClaudeEventProjector(config.sessionId, 'history', this.images);
    this.history = messages.flatMap((message) => history.project(message));
    this.children = new ClaudeChildren(config.sessionId, config.cwd,
      options.catalog ?? createClaudeCatalog(options.env ?? {}, this.timeout), () => this.runtimeUpdated());
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

  static async open(config: ClaudeSessionConfig, options: ClaudeSessionOptions = {}, messages: SessionMessage[] = [], resume = false): Promise<ClaudeAgentSession> {
    if (config.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)) throw new Error('Unsupported Claude reasoning effort.');
    const session = new ClaudeAgentSession(config, options, messages);
    try {
      if (resume) await session.children.restore();
      session.native = (options.query ?? query)({ prompt: session.input, options: {
        ...(resume ? { resume: config.sessionId } : { sessionId: config.sessionId }), cwd: config.cwd,
        model: config.model, ...(config.reasoningEffort ? { effort: config.reasoningEffort as Options['effort'] } : {}),
        pathToClaudeCodeExecutable: options.executable ?? 'claude', env: { ...process.env, ...options.env },
        includePartialMessages: true, forwardSubagentText: true, persistSession: true, settingSources: ['user', 'project', 'local'],
        systemPrompt: config.systemPrompt ?? { type: 'preset', preset: 'claude_code' },
        ...(options.restrictedNative ? { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } } : {}),
        permissionMode: session.permissionMode, canUseTool: session.interactions.request,
        stderr: options.onDiagnostic, spawnClaudeCodeProcess: session.process.spawn,
      } });
      session.pump = session.consume();
      const initialized = await deadline(session.native.initializationResult(), session.timeout, 'Claude initialization');
      session.models = initialized.models ?? [];
      if (session.native.applyFlagSettings && session.native.getSettings) {
        try { await session.readNativeSettings(); }
        catch { session.appliedEffort = undefined; }
      }
      if (session.failure) throw session.failure;
      session.status = 'idle';
      session.runtimeUpdated();
      return session;
    } catch (error) {
      try { await session.dispose(); } catch (shutdownError) { throw new ClaudeShutdownError(session, shutdownError); }
      throw error;
    }
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
    this.dispatchMessage(text);
  }

  async sendMessageContent(parts: readonly AgentInputPart[], options: AgentMessageOptions = {}): Promise<void> {
    this.assertMessageReady(options);
    if (!parts.some(part => part.type === 'image' || part.text.trim())) throw new AgentOperationRejectedError('operation_rejected', 'Claude message cannot be empty.');
    const snapshot = parts.map(part => ({ ...part }));
    this.preparingMessage = true;
    try {
      const content = await prepareAgentOperation(() => claudeMessageContent(snapshot));
      this.requireOpen();
      this.dispatchMessage(content);
    } finally { this.preparingMessage = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  private assertMessageReady(options: AgentMessageOptions): void {
    this.requireOpen();
    if (options.delivery === 'next_turn') throw new AgentOperationRejectedError('operation_rejected', 'Claude queued delivery is not supported.');
    if (this.turnId || this.changingSetting || this.preparingMessage) throw new AgentOperationRejectedError('operation_rejected', 'Claude already has an active turn or setting change.');
  }

  private dispatchMessage(content: SDKUserMessage['message']['content']): void {
    const turnId = randomUUID();
    const message: SDKUserMessage = { type: 'user', uuid: turnId, session_id: this.config.sessionId,
      parent_tool_use_id: null, message: { role: 'user', content } };
    this.input.push(message);
    this.turnId = turnId;
    this.usage.startTurn();
    this.status = 'running';
    this.cancelRequested = false;
    this.emit({ type: 'turn_started', provider: 'claude', turnId });
    for (const observation of this.projector.project(message)) this.output.push({ ...observation, event: this.withTurn(observation.event) });
    this.runtimeUpdated();
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

  async cancel(): Promise<void> {
    this.requireOpen();
    if (!this.turnId) return;
    this.cancelRequested = true;
    this.interactions.cancelAll();
    try { await deadline(this.native.interrupt(), this.timeout, 'Claude interrupt'); }
    catch (error) { this.fail(error); this.native.close(); throw error; }
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
        if (value === 'default') delete this.config.reasoningEffort;
        else if (this.appliedEffort !== null) this.config.reasoningEffort = this.appliedEffort;
        else this.config.reasoningEffort = value;
        this.runtimeUpdated();
        if (value !== 'default' && value !== this.appliedEffort) throw new AgentOperationRejectedError('operation_rejected', `Claude applied ${this.appliedEffort ?? 'no effort parameter'} instead of requested effort ${value}.`);
      } else await this.updatePermissionMode(value as PermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  async setPlanning(active: boolean): Promise<void> {
    this.requireOpen();
    if (this.turnId || this.changingSetting || this.preparingMessage) throw new AgentOperationRejectedError('operation_rejected', 'Claude planning can only change while idle.');
    this.changingSetting = true;
    try {
      await this.updatePermissionMode(active ? 'plan' : this.resumePermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; if (!this.disposed && !this.failure) this.runtimeUpdated(); }
  }

  private async updatePermissionMode(mode: PermissionMode): Promise<void> {
    await this.updateNative(this.native.setPermissionMode(mode), 'Claude permission update');
    if (this.disposed) throw new Error('Claude closed before permission confirmation.');
    this.confirmPermissionMode(mode);
  }
  private async updateNative(operation: Promise<void>, label: string): Promise<void> {
    try { await deadline(operation, this.timeout, label); }
    catch (error) { if (error instanceof DeadlineError) this.fail(error); throw error; }
  }
  private confirmPermissionMode(mode: PermissionMode): void {
    this.settingsRevision++;
    this.permissionMode = mode;
    this.planning = mode === 'plan';
    if (!this.planning) this.resumePermissionMode = mode;
  }
  private async readNativeSettings(refreshModel = false): Promise<void> {
    const revision = this.settingsRevision;
    try {
      const response = await deadline(this.native.getSettings!(), this.timeout, 'Claude applied effort readback');
      if (this.disposed || revision !== this.settingsRevision) return;
      const applied = (response as { applied?: { model?: unknown; effort?: unknown } } | null)?.applied;
      const effort = applied?.effort;
      if (effort !== null && (typeof effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))) throw new Error('Claude did not report applied effort.');
      this.settingsRevision++;
      this.appliedEffort = effort;
      const model = applied?.model;
      const selected = this.config.model;
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
      options: [{ value: 'default', label: 'Ask for permissions' }, { value: 'acceptEdits', label: 'Accept edits' },
        { value: 'dontAsk', label: 'Deny unapproved tools' }, { value: 'plan', label: 'Plan' }],
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
      this.input.close();
      this.native?.close();
    }
    return this.closing = (async () => {
      await this.children.close();
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
  private info(): AgentRuntimeInfo {
    return { providerId: 'claude', sessionId: this.config.sessionId, status: this.status, cwd: this.config.cwd,
      model: this.config.model ?? null, planning: { active: this.planning }, settings: this.settings(), childSessions: this.children.descriptors(),
      persistence: { providerId: 'claude', sessionId: this.config.sessionId, opaque: JSON.stringify({ ...this.config, planning: this.planning, permissionMode: this.resumePermissionMode }) } };
  }
  private runtimeUpdated(): void { this.emit({ type: 'runtime_updated', provider: 'claude', runtimeInfo: this.info(), activeTurnId: this.turnId ?? null }); }
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
    this.input.close();
    this.native.close();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.native) {
        if (this.disposed) break;
        if (message.session_id && message.session_id !== this.config.sessionId) throw new Error('Claude returned a different native session identity.');
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
          this.config.model = message.model;
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
