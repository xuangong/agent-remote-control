import { randomUUID } from 'node:crypto';
import { query, type Options, type ModelInfo, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentCapabilities, AgentInteractionResponse, AgentMessageOptions, AgentRuntimeInfo, AgentSession, AgentSessionConfig,
  AgentStreamEvent, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { validateSessionSetting, type AgentSessionSetting } from '@agent-remote-controller/agent-provider-sdk';
import { Channel, deadline, DeadlineError } from './channel.js';
import { ClaudeInteractions } from './interactions.js';
import { ClaudeUsage } from './usage.js';
import { ClaudeImageRegistry } from './images.js';
import { ClaudeEventProjector } from './projector.js';
import { discoverClaudeCommands } from './commands.js';
import { ClaudeChildren } from './children.js';
import { createClaudeCatalog, type ClaudeCatalog } from './catalog.js';

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'interrupt' | 'setPermissionMode' | 'close' | 'supportedCommands' | 'reloadSkills' | 'supportedModels' | 'setModel'>;
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

export class ClaudeAgentSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: true, readResource: true,
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
  private changingSetting = false;
  private observing = false;
  private disposed = false;
  private failure: Error | undefined;
  private native!: ClaudeQuery;
  private pump!: Promise<void>;

  private constructor(private readonly config: ClaudeSessionConfig, private readonly options: ClaudeSessionOptions,
    messages: SessionMessage[]) {
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
      if (this.changingSetting) throw new Error('Claude already has a setting change in progress.');
      this.changingSetting = true;
      try {
        await this.updatePermissionMode(this.resumePermissionMode);
        this.runtimeUpdated();
      } finally { this.changingSetting = false; }
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
        stderr: options.onDiagnostic,
      } });
      session.pump = session.consume();
      const initialized = await deadline(session.native.initializationResult(), session.timeout, 'Claude initialization');
      session.models = initialized.models ?? [];
      if (session.failure) throw session.failure;
      session.status = 'idle';
      session.runtimeUpdated();
      return session;
    } catch (error) { await session.dispose(); throw error; }
  }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observing) throw new Error('Claude session already has an observer.');
    this.observing = true;
    yield* this.history;
    yield { type: 'history_boundary' };
    yield* this.output;
  }

  async sendMessage(text: string, options: AgentMessageOptions = {}): Promise<void> {
    this.requireOpen();
    if (!text.trim()) throw new Error('Claude message cannot be empty.');
    if (options.delivery === 'next_turn') throw new Error('Claude queued delivery is not supported.');
    if (this.turnId || this.changingSetting) throw new Error('Claude already has an active turn or setting change.');
    this.turnId = randomUUID();
    this.usage.startTurn();
    this.status = 'running';
    this.cancelRequested = false;
    const message: SDKUserMessage = { type: 'user', uuid: this.turnId, session_id: this.config.sessionId,
      parent_tool_use_id: null, message: { role: 'user', content: text } };
    this.emit({ type: 'turn_started', provider: 'claude', turnId: this.turnId });
    for (const observation of this.projector.project(message)) this.output.push({ ...observation, event: this.withTurn(observation.event) });
    this.runtimeUpdated();
    this.input.push(message);
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
    if (this.turnId || this.changingSetting) throw new Error('Claude commands require an idle session.');
    this.changingSetting = true;
    try {
      const command = (await this.listCommands()).find((entry) => entry.id === id);
      if (!command) throw new Error('Claude command is unavailable in this session.');
      this.changingSetting = false;
      await this.sendMessage(`/${command.name}${args ? ` ${args}` : ''}`);
      return {};
    } finally { this.changingSetting = false; }
  }

  async cancel(): Promise<void> {
    this.requireOpen();
    if (!this.turnId) return;
    this.cancelRequested = true;
    this.interactions.cancelAll();
    try { await deadline(this.native.interrupt(), this.timeout, 'Claude interrupt'); }
    catch (error) { this.fail(error); this.native.close(); throw error; }
  }

  async setSessionSetting(id: string, value: string): Promise<void> {
    this.requireOpen();
    if (this.turnId || this.changingSetting) throw new Error('Claude settings can only change while idle.');
    this.changingSetting = true;
    try {
      if (id === 'model') this.models = await deadline(this.native.supportedModels(), this.timeout, 'Claude model discovery');
      this.requireOpen();
      validateSessionSetting(this.settings(), id, value);
      if (id === 'model') {
        await this.updateNative(this.native.setModel(value), 'Claude model update');
        this.requireOpen();
        this.config.model = value;
      } else await this.updatePermissionMode(value as PermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; }
  }

  async setPlanning(active: boolean): Promise<void> {
    this.requireOpen();
    if (this.turnId || this.changingSetting) throw new Error('Claude planning can only change while idle.');
    this.changingSetting = true;
    try {
      await this.updatePermissionMode(active ? 'plan' : this.resumePermissionMode);
      this.runtimeUpdated();
    } finally { this.changingSetting = false; }
  }

  private async updatePermissionMode(mode: PermissionMode): Promise<void> {
    await this.updateNative(this.native.setPermissionMode(mode), 'Claude permission update');
    this.requireOpen();
    this.confirmPermissionMode(mode);
  }
  private async updateNative(operation: Promise<void>, label: string): Promise<void> {
    try { await deadline(operation, this.timeout, label); }
    catch (error) { if (error instanceof DeadlineError) this.fail(error); throw error; }
  }
  private confirmPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.planning = mode === 'plan';
    if (!this.planning) this.resumePermissionMode = mode;
  }
  private settings(): AgentSessionSetting[] {
    return [{ id: 'model', category: 'model', label: 'Model', value: this.config.model ?? null,
      options: this.models.map((model) => ({ value: model.value, label: model.displayName, description: model.description })),
      mutable: true, scope: 'session' },
    { id: 'permissions', category: 'permissions', label: 'Permissions', value: this.permissionMode,
      options: [{ value: 'default', label: 'Ask for permissions' }, { value: 'acceptEdits', label: 'Accept edits' },
        { value: 'dontAsk', label: 'Deny unapproved tools' }, { value: 'plan', label: 'Plan' }],
      mutable: true, scope: 'session' }];
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> { return this.info(); }
  async readResource(locator: string) { return this.images.readResource(locator); }
  async openChildSession(nativeSessionId: string): Promise<AgentSession> { return this.children.open(nativeSessionId); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.images.stop();
    this.interactions.close();
    this.status = 'closed';
    this.input.close();
    this.native?.close();
    await this.children.close();
    if (!this.failure) this.runtimeUpdated();
    this.output.close();
    if (this.pump) await deadline(this.pump, Math.min(this.timeout, 5000), 'Claude shutdown').catch(() => undefined);
    this.options.onDispose?.();
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error('Claude session is closed.');
    if (this.failure) throw this.failure;
  }
  private info(): AgentRuntimeInfo {
    return { providerId: 'claude', sessionId: this.config.sessionId, status: this.status, cwd: this.config.cwd,
      model: this.config.model ?? null, planning: { active: this.planning }, settings: this.settings(), childSessions: this.children.descriptors(),
      persistence: { providerId: 'claude', sessionId: this.config.sessionId, opaque: JSON.stringify({ ...this.config, planning: this.planning, permissionMode: this.resumePermissionMode }) } };
  }
  private runtimeUpdated(): void { this.emit({ type: 'runtime_updated', provider: 'claude', runtimeInfo: this.info() }); }
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
