import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentOperationRejectedError, AgentRuntimeError, RESOURCE_INPUT_CAPABILITIES, bindAgentSessionToolNamespaces, bindAgentSessionTools, redactInteractionResponse,
  resourceInputText, unknownNativeEventLine, validateCommandDirectory, validateInteractionResponse, validateSessionSetting,
  type AgentCapabilities, type AgentCommand, type AgentInputAcceptance, type AgentInputPart, type AgentInteractionRequest, type AgentInteractionResponse,
  type AgentMessageOptions, type AgentRuntimeInfo, type AgentSession, type AgentSessionConfig, type AgentSessionSetting, type AgentSessionTool, type AgentStreamEvent,
  type AgentUsage, type ProviderItemIdentity, type ProviderStreamItem,
} from '@orchardworks/agent-provider-sdk';
import { BRIDGE_CONFIG_ENV, BRIDGE_EXTENSION_SOURCE, parseBridgeRequest, type BridgeConfig, type BridgeRequest } from './bridge-extension.js';
import { Channel, DeadlineError } from './channel.js';
import { knownPiEntry, knownPiEvent, knownPiRole } from './native-kinds.js';
import { list, num, provider, record, str, type Json } from './native.js';
import { isPiPermissionMode, type PiPermissionMode, type PiPermissionModeStore } from './permission-mode.js';
import type { PiExit, PiLauncher } from './process.js';
import { PiProjector, type PiEntry, type Projected } from './projector.js';
import { PiClosedError, PiRequestError, PiRpc } from './rpc.js';
import { activeBranch, readPiSession } from './session-file.js';
import { toolDetail, toolSummary } from './tool-detail.js';

export interface PiSessionRuntime {
  launch: PiLauncher;
  env: Record<string, string | undefined>;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  onDiagnostic?: (message: string) => void;
  permissionModes?: PiPermissionModeStore;
  /** Where the work directory of the session is made; the process temporary directory by default. */
  workRoot?: string;
  onDispose(): void;
}

/** What opens a session: a new one, or one read from its file. */
export interface PiSessionStart {
  config: AgentSessionConfig;
  resume?: { sessionId: string; file: string };
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
const MODE_SETTING = 'tool_approval_mode';
const hostToolName = (namespace: string | undefined, name: string) => namespace ? `${namespace}__${name}` : name;

interface PendingApproval { requestId: string; uiId: string; toolName: string; request: AgentInteractionRequest }

export class PiAgentSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { resourceInput: RESOURCE_INPUT_CAPABILITIES, history: true, sendMessage: true, queueMessage: true, steer: true, cancel: true,
    readResource: false, sessionSettings: true, commands: true, planning: false, interactions: { question: false, planApproval: false, toolApproval: true } };
  private readonly stream = new Channel<ProviderStreamItem>();
  private projector: PiProjector;
  private rpc!: PiRpc;
  private observed = false;
  private closed = false;
  private failure: Error | undefined;
  private revision = 0;
  private info: AgentRuntimeInfo;
  private mode: PiPermissionMode;
  private readonly readOnly: boolean;
  private readonly grants = new Set<string>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** The tools the session was created with, and the tools of its namespaces, which the Host may change while it runs. */
  private flatTools = new Map<string, AgentSessionTool>();
  private namespaceTools = new Map<string, AgentSessionTool>();
  /** A prompt was accepted and pi has not yet reported its run, so whether the next input queues is not known. */
  private awaitingStart = false;
  /** The stream has ended, closed or failed: nothing more is pushed. */
  private ended = false;
  private workDirectory: string | undefined;
  private models: Array<{ value: string; label: string; reasoning: boolean }> = [];
  private sessionId = '';
  private file: string | undefined;

  private constructor(private readonly start: PiSessionStart, private readonly runtime: PiSessionRuntime) {
    const { config } = start;
    this.readOnly = config.access === 'read_only';
    this.mode = this.readOnly ? 'allow' : config.yolo === true ? 'allow' : 'ask';
    this.projector = new PiProjector(config.cwd);
    this.info = { providerId: provider, sessionId: null, status: 'starting', cwd: config.cwd, model: config.model ?? null, childSessions: [] };
  }

  /** Starts a pi process for the session and reads its history; the process is stopped again when this fails. */
  static async open(start: PiSessionStart, runtime: PiSessionRuntime): Promise<PiAgentSession> {
    const session = new PiAgentSession(start, runtime);
    try { await session.begin(); return session; }
    catch (error) { await session.dispose().catch(() => undefined); throw error; }
  }

  // Opening ---------------------------------------------------------------------------------------------------------------------

  private bindFlatTools(): void {
    for (const tool of bindAgentSessionTools(this.start.config.tools, () => this.assertOpen())) this.flatTools.set(hostToolName(undefined, tool.name), tool);
  }
  private bindNamespaces(namespaces: AgentSessionConfig['toolNamespaces']): Map<string, AgentSessionTool> {
    const bound = new Map<string, AgentSessionTool>();
    for (const namespace of bindAgentSessionToolNamespaces(namespaces, () => this.assertOpen())) {
      for (const tool of namespace.tools) {
        const name = hostToolName(namespace.name, tool.name);
        if (bound.has(name) || this.flatTools.has(name)) throw new Error('pi session tools have duplicate names.');
        bound.set(name, tool);
      }
    }
    return bound;
  }
  private hostTool(name: string): AgentSessionTool | undefined { return this.flatTools.get(name) ?? this.namespaceTools.get(name); }
  private toolDeclarations(): BridgeConfig['tools'] {
    return [...this.flatTools, ...this.namespaceTools].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  /** The Host changed the session's tool namespaces: pi offers them from its next run (the extension asks at each run's start). */
  async updateToolNamespaces(namespaces: NonNullable<AgentSessionConfig['toolNamespaces']>): Promise<void> {
    this.assertOpen();
    // A read-only session's pi was started with a fixed list of tool names.
    if (this.readOnly) throw new AgentOperationRejectedError('operation_rejected', 'The tools of a read-only pi session cannot change.');
    this.namespaceTools = this.bindNamespaces(namespaces);
  }

  private async begin(): Promise<void> {
    const { config, resume } = this.start;
    this.bindFlatTools();
    this.namespaceTools = this.bindNamespaces(config.toolNamespaces);
    const tools = this.toolDeclarations();
    this.workDirectory = await mkdtemp(join(this.runtime.workRoot ?? tmpdir(), 'arc-pi-'));
    const extension = join(this.workDirectory, 'bridge.mjs'), settings = join(this.workDirectory, 'bridge.json');
    await writeFile(extension, BRIDGE_EXTENSION_SOURCE, { mode: 0o600 });
    await writeFile(settings, JSON.stringify({ tools } satisfies BridgeConfig), { mode: 0o600 });
    const args = ['--mode', 'rpc', '--offline', '-e', extension];
    if (resume) args.push('--session', resume.file);
    // A read-only session has only the tools that cannot write, and the Host's own.
    if (this.readOnly) args.push('--tools', ['read', 'grep', 'find', 'ls', ...tools.map(tool => tool.name)].join(','));
    for (const text of [config.systemPrompt, config.instructions]) if (text) args.push('--append-system-prompt', text);
    if (config.hostAccess?.skills) args.push('--skill', join(config.hostAccess.skills, 'skills'));
    const env = { ...this.runtime.env, ...config.hostAccess?.environment, [BRIDGE_CONFIG_ENV]: settings, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' };
    let channel;
    try { channel = this.runtime.launch({ args, cwd: config.cwd ?? process.cwd(), env }); }
    catch (error) { throw new AgentRuntimeError('native_runtime_unavailable', `pi could not be started: ${error instanceof Error ? error.message : String(error)}`); }
    this.rpc = new PiRpc(channel, this.runtime.requestTimeoutMs, { event: event => this.onEvent(event), ui: request => this.onUi(request), exit: exit => this.onExit(exit) });
    const state = await this.call(() => this.rpc.request('get_state', {}, this.runtime.startTimeoutMs), 'Open pi session');
    this.sessionId = str(state.sessionId) ?? '';
    this.file = str(state.sessionFile);
    if (!this.sessionId || resume && this.sessionId !== resume.sessionId) throw new AgentRuntimeError('native_session_unavailable', 'pi did not open the requested session.');
    this.info.sessionId = this.sessionId;
    if (resume) await this.restoreMode();
    await this.refreshModels();
    this.readSelections(state);
    if (config.model !== undefined && config.model !== this.info.model) await this.selectModel(config.model);
    if (config.reasoningEffort !== undefined && config.reasoningEffort !== this.thinking()) await this.selectThinking(config.reasoningEffort);
    if (resume) await this.projectHistory(resume.file);
    this.stream.push({ type: 'history_boundary' });
    this.info.status = state.isStreaming === true ? 'running' : 'idle';
    this.emit({ type: 'thread_started', provider, sessionId: this.sessionId });
    await this.saveMode();
    this.publishRuntime();
  }

  private async restoreMode(): Promise<void> {
    if (this.readOnly) return;
    const saved = await this.runtime.permissionModes?.read(this.sessionId).catch(() => undefined);
    if (isPiPermissionMode(saved)) this.mode = saved;
  }
  private async saveMode(): Promise<void> {
    if (this.readOnly) return;
    try { await this.runtime.permissionModes?.write(this.sessionId, this.mode); }
    catch (error) { this.runtime.onDiagnostic?.(`pi permission mode could not be saved: ${String(error)}`); }
  }

  /** The conversation of the session file, before the live stream. A file that cannot be read is a failed open, never an empty history. */
  private async projectHistory(file: string): Promise<void> {
    const content = await readPiSession(file);
    if (!content) throw new AgentRuntimeError('native_session_unavailable', 'The pi session history could not be read.');
    const entries = activeBranch(content.entries).filter(entry => {
      if (knownPiEntry(entry.type) && (entry.type !== 'message' || knownPiRole(record(entry.message).role))) return true;
      this.runtime.onDiagnostic?.(unknownNativeEventLine(provider, entry.type === 'message' ? `message:${String(record(entry.message).role)}` : entry.type, 'history'));
      return false;
    });
    for (const row of this.projector.history(entries as PiEntry[])) this.push(row, 'history');
  }

  // Stream ----------------------------------------------------------------------------------------------------------------------

  observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observed) throw new Error('pi observation already attached.');
    this.observed = true;
    return this.stream;
  }
  private emit(event: AgentStreamEvent, identity?: ProviderItemIdentity): void {
    if (this.ended) return;
    this.stream.push({ type: 'observation', sourceKey: `pi:local:${randomUUID()}`, occurredAt: Date.now(), delivery: 'live', event, ...(identity ? { itemIdentity: identity } : {}) });
  }
  private push(row: Projected, delivery: 'history' | 'live'): void {
    if (this.ended) return;
    this.stream.push({ type: 'observation', sourceKey: `pi:${this.sessionId}:${row.key}`, nativeRevision: ++this.revision, occurredAt: row.occurredAt ?? Date.now(), delivery, event: row.event,
      ...(row.identity ? { itemIdentity: row.identity } : {}) });
  }
  private publishRuntime(): void { this.emit({ type: 'runtime_updated', provider, runtimeInfo: this.snapshot(), activeTurnId: this.projector.running ? undefined : null }); }
  private snapshot(): AgentRuntimeInfo {
    const persistence = this.sessionId ? { providerId: provider, sessionId: this.sessionId,
      opaque: JSON.stringify({ cwd: this.info.cwd, ...(this.file ? { file: this.file } : {}), ...(this.readOnly ? { access: 'read_only' } : {}) }) } : undefined;
    return structuredClone({ ...this.info, ...(persistence ? { persistence } : {}) });
  }

  // Live events -----------------------------------------------------------------------------------------------------------------

  private onEvent(event: Json): void {
    if (this.closed) return;
    if (!knownPiEvent(event.type)) {
      try { this.runtime.onDiagnostic?.(unknownNativeEventLine(provider, event.type, 'live')); } catch { /* Diagnostics cannot interrupt native observation. */ }
      return;
    }
    if (event.type === 'agent_start' || event.type === 'agent_end') this.awaitingStart = false;
    if (event.type === 'agent_start') { this.info.status = 'running'; delete this.info.failure; }
    for (const row of this.projector.live(event)) this.push(row, 'live');
    if (event.type === 'agent_start') this.publishRuntime();
    if (event.type === 'agent_end') {
      this.retireApprovals('cancel');
      this.info.status = 'idle';
      this.publishRuntime();
      void this.refreshUsage();
    }
    if (event.type === 'extension_error') this.runtime.onDiagnostic?.(`pi extension error: ${str(event.error) ?? 'unknown'}`);
  }

  private onExit(exit: PiExit): void {
    if (this.closed) return;
    this.runtime.onDiagnostic?.(`pi exited (code ${String(exit.code)}, signal ${String(exit.signal)}): ${exit.stderr.slice(-500)}`);
    this.fail(new Error('pi exited.'));
  }

  /** The session cannot go on: a turn under way fails `native_exited`, and the stream fails so the Controller opens the session again. */
  private fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.retireApprovals('cancel');
    if (this.projector.running) this.emit({ type: 'turn_failed', provider, error: error.message, code: 'native_exited' });
    this.info.status = 'failed'; this.info.failure = { message: error.message };
    this.publishRuntime();
    this.ended = true;
    this.stream.fail(error);
  }

  // Extension UI: approvals and Host tools --------------------------------------------------------------------------------------

  private onUi(request: Json): void {
    const id = str(request.id);
    if (!id || this.closed) return;
    const bridge = parseBridgeRequest(request);
    if (!bridge) {
      // A dialog of an extension the user installed: this adapter cannot show it, so it is declined rather than left waiting.
      if (['select', 'confirm', 'input', 'editor'].includes(String(request.method))) this.rpc.answerUi(id, { cancelled: true });
      return;
    }
    if (bridge.kind === 'tools') this.rpc.answerUi(id, { value: JSON.stringify({ tools: this.toolDeclarations() }) });
    else if (bridge.kind === 'approval') this.approve(id, bridge);
    else void this.runHostTool(id, bridge);
  }

  private approve(uiId: string, request: Extract<BridgeRequest, { kind: 'approval' }>): void {
    if (this.mode === 'allow' || this.grants.has(request.toolName)) return this.rpc.answerUi(uiId, { value: JSON.stringify({ allow: true }) });
    const detail = toolDetail(request.toolName, request.input, this.info.cwd);
    const requestId = randomUUID();
    const interaction: AgentInteractionRequest = { kind: 'tool_approval', requestId, toolCallId: request.toolCallId, toolName: request.toolName, summary: toolSummary(request.toolName, detail), detail,
      allowedDecisions: ['allow', 'deny', 'cancel'], allowScopes: ['once', 'session'] };
    this.approvals.set(requestId, { requestId, uiId, toolName: request.toolName, request: interaction });
    this.emit({ type: 'interaction_requested', provider, request: interaction });
    this.info.status = 'waiting';
    this.publishRuntime();
  }

  private retireApprovals(decision: 'cancel'): void {
    for (const pending of [...this.approvals.values()]) this.settle(pending, { kind: 'tool_approval', decision });
  }

  /** The approval is over: the interaction resolves with the response a reader sees, redacted as the contract says. */
  private settle(pending: PendingApproval, response: AgentInteractionResponse): void {
    this.approvals.delete(pending.requestId);
    this.emit({ type: 'interaction_resolved', provider, requestId: pending.requestId, response: redactInteractionResponse(pending.request, response) },
      { key: `interaction:${pending.requestId}`, completes: true, liveOnly: true });
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.assertOpen();
    const pending = this.approvals.get(requestId);
    if (!pending) throw new AgentOperationRejectedError('operation_rejected', 'Unknown pi interaction.');
    validateInteractionResponse(pending.request, response);
    if (response.kind !== 'tool_approval') throw new AgentOperationRejectedError('operation_rejected', 'pi asks only for tool approvals.');
    const allow = response.decision === 'allow';
    if (allow && response.scope === 'session') this.grants.add(pending.toolName);
    const reason = !allow && response.decision === 'deny' ? response.message : response.decision === 'cancel' ? 'The user canceled this tool call.' : undefined;
    this.rpc.answerUi(pending.uiId, { value: JSON.stringify(allow ? { allow: true } : { allow: false, ...(reason ? { reason } : {}) }) });
    this.settle(pending, response);
    if (this.approvals.size === 0 && this.info.status === 'waiting') this.info.status = 'running';
    this.publishRuntime();
    if (response.decision === 'cancel') await this.cancel();
  }

  private async runHostTool(uiId: string, request: Extract<BridgeRequest, { kind: 'tool' }>): Promise<void> {
    const tool = this.hostTool(request.name);
    let answer: Json;
    if (!tool) answer = { ok: false, error: `The tool ${request.name} is not available in this session.` };
    else {
      try { answer = { ok: true, text: await tool.execute(request.arguments) }; }
      catch (error) { answer = { ok: false, error: error instanceof Error ? error.message : 'The tool failed.' }; }
    }
    if (!this.closed) this.rpc.answerUi(uiId, { value: JSON.stringify(answer) });
  }

  // Input -----------------------------------------------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new AgentOperationRejectedError('operation_rejected', 'pi session is closed.');
    if (this.failure) throw new AgentOperationRejectedError('operation_rejected', 'pi is not running; open the session again.');
  }

  /** A command whose response did not arrive in time or whose process ended has an unknown effect; it is reported, never retried. */
  private async call<T>(operation: () => Promise<T>, label: string): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof DeadlineError) throw new AgentRuntimeError(label.startsWith('Open') ? 'native_resume_timeout' : 'native_request_timeout', `${label} timed out.`);
      if (error instanceof PiClosedError) throw new AgentRuntimeError('native_exited', `pi exited during: ${label}.`);
      throw error;
    }
  }

  async sendMessage(text: string, options?: AgentMessageOptions): Promise<AgentInputAcceptance | void> {
    this.assertOpen();
    const running = this.projector.running;
    // Always say what to do if a run is under way, so a run that began since the last event joins as steering instead of being refused.
    const streamingBehavior = options?.delivery === 'next_turn' ? 'followUp' : 'steer';
    const ambiguous = !running && this.awaitingStart;
    try { await this.call(() => this.rpc.request('prompt', { message: text, streamingBehavior }), 'pi input'); }
    catch (error) {
      if (error instanceof PiRequestError) throw new AgentOperationRejectedError('operation_rejected', error.message);
      throw error;
    }
    if (!running) this.awaitingStart = true;
    return ambiguous ? undefined : { disposition: running ? 'queued' : 'started' };
  }
  async sendMessageContent(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentInputAcceptance | void> {
    if (parts.some(part => part.type === 'image')) throw new AgentOperationRejectedError('operation_rejected', 'pi image input is not supported by this adapter.');
    return this.sendMessage(parts.flatMap(part => part.type === 'text' ? [part.text] : part.type === 'resource' ? [resourceInputText(part)] : []).join('\n'), options);
  }
  steer(text: string): Promise<AgentInputAcceptance | void> { return this.sendMessage(text, { delivery: 'immediate' }); }

  async cancel(): Promise<void> {
    this.assertOpen();
    await this.call(() => this.rpc.request('abort'), 'pi cancellation');
    this.retireApprovals('cancel');
  }

  // Settings and commands -------------------------------------------------------------------------------------------------------

  private thinking(): string | null {
    const value = this.info.settings?.find(setting => setting.id === 'reasoning_effort')?.value;
    return value ?? null;
  }
  private readSelections(state: Json): void {
    const model = record(state.model);
    const value = str(model.provider) && str(model.id) ? `${String(model.provider)}/${String(model.id)}` : null;
    this.info.model = value;
    const level = str(state.thinkingLevel) ?? 'off';
    const reasoning = this.models.find(entry => entry.value === value)?.reasoning ?? false;
    const settings: AgentSessionSetting[] = [{ id: 'model', category: 'model', label: 'Model', value, scope: 'session', mutable: this.models.length > 0,
      options: this.models.map(({ value: id, label }) => ({ value: id, label })) }];
    settings.push({ id: 'reasoning_effort', category: 'model', label: 'Thinking level', value: level, scope: 'session', mutable: reasoning,
      options: (reasoning ? THINKING_LEVELS : ['off' as const]).map(option => ({ value: option, label: option })) });
    settings.push({ id: MODE_SETTING, category: 'permissions', label: 'Tool approvals', value: this.mode, scope: 'session', mutable: !this.readOnly,
      description: 'pi has no permission system; Agent Remote Control asks before each tool call, or lets every tool run.',
      options: [{ value: 'ask', label: 'Ask for approval', description: 'Ask before every tool call. "Allow for this session" lets one tool run unasked until the session closes.' },
        { value: 'allow', label: 'Allow tools', description: 'Every tool runs without asking.' }] });
    this.info.settings = settings;
  }
  private async refreshModels(): Promise<void> {
    try {
      const data = await this.call(() => this.rpc.request('get_available_models'), 'pi models');
      this.models = list(data.models).map(record).filter(model => str(model.provider) && str(model.id))
        .map(model => ({ value: `${String(model.provider)}/${String(model.id)}`, label: str(model.name) ?? String(model.id), reasoning: model.reasoning === true }));
    } catch (error) { this.runtime.onDiagnostic?.(`pi models unavailable: ${String(error)}`); this.models = []; }
  }
  private async refreshState(): Promise<void> {
    const state = await this.call(() => this.rpc.request('get_state'), 'pi state');
    this.readSelections(state);
  }
  private async selectModel(value: string): Promise<void> {
    const separator = value.indexOf('/');
    if (separator < 1 || !this.models.some(model => model.value === value)) throw new AgentOperationRejectedError('invalid_operation', 'Unavailable Model selection.');
    await this.call(() => this.rpc.request('set_model', { provider: value.slice(0, separator), modelId: value.slice(separator + 1) }), 'pi model');
    await this.refreshState();
  }
  private async selectThinking(level: string): Promise<void> {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new AgentOperationRejectedError('invalid_operation', 'Unavailable Thinking level selection.');
    await this.call(() => this.rpc.request('set_thinking_level', { level }), 'pi thinking level');
    await this.refreshState();
  }

  async setSessionSetting(id: string, value: string): Promise<void> {
    this.assertOpen();
    validateSessionSetting(this.info.settings, id, value);
    if (id === MODE_SETTING) {
      this.mode = value as PiPermissionMode;
      await this.saveMode();
      this.readSelections(await this.call(() => this.rpc.request('get_state'), 'pi state'));
      // Approvals already waiting stay waiting; the choice applies to the next tool call.
    } else if (id === 'model') await this.selectModel(value);
    else await this.selectThinking(value);
    this.publishRuntime();
  }

  async listCommands(): Promise<AgentCommand[]> {
    this.assertOpen();
    const data = await this.call(() => this.rpc.request('get_commands'), 'pi commands');
    return validateCommandDirectory(list(data.commands).map(record).flatMap(command => {
      const name = str(command.name);
      if (!name || /\s/.test(name) || name.includes('/')) return [];
      const kind = command.source === 'skill' ? 'skill' as const : command.source === 'prompt' ? 'prompt' as const : 'command' as const;
      return [{ id: name, name, kind, description: str(command.description) ?? name }];
    }));
  }
  async executeCommand(id: string, args: string): Promise<{ text?: string }> {
    const command = (await this.listCommands()).find(entry => entry.id === id);
    if (!command) throw new AgentOperationRejectedError('operation_rejected', 'Unknown pi command.');
    await this.sendMessage(`/${command.name}${args.trim() ? ` ${args.trim()}` : ''}`);
    return {};
  }

  /** `/name`: pi records the display name in the session file itself. */
  async rename(name: string): Promise<void> {
    this.assertOpen();
    await this.call(() => this.rpc.request('set_session_name', { name }), 'pi rename');
  }

  // Usage and runtime ------------------------------------------------------------------------------------------------------------

  /** The session's tokens and the current context fill, from pi's own accounting, after each run. */
  private async refreshUsage(): Promise<void> {
    try {
      const stats = await this.call(() => this.rpc.request('get_session_stats'), 'pi usage');
      if (this.closed) return;
      const tokens = record(stats.tokens), context = record(stats.contextUsage);
      const usage: AgentUsage = { tokenScope: 'session', inputTokens: num(tokens.input), cachedInputTokens: num(tokens.cacheRead), cacheCreationInputTokens: num(tokens.cacheWrite),
        outputTokens: num(tokens.output), totalTokens: num(tokens.total), ...(num(stats.cost) !== undefined ? { totalCostUsd: num(stats.cost) } : {}),
        ...(num(context.tokens) !== undefined && num(context.contextWindow) !== undefined ? { contextScope: 'current' as const, contextWindowUsedTokens: num(context.tokens), contextWindowMaxTokens: num(context.contextWindow) } : {}) };
      this.emit({ type: 'usage_updated', provider, usage });
    } catch (error) { if (!this.closed) this.runtime.onDiagnostic?.(`pi usage unavailable: ${String(error)}`); }
  }

  async runtimeInfo(options?: { refreshSettings?: boolean }): Promise<AgentRuntimeInfo> {
    if (options?.refreshSettings && !this.closed && !this.failure) { await this.refreshModels(); await this.refreshState().catch(() => undefined); }
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.retireApprovals('cancel');
    this.closed = true;
    this.info.status = 'closed';
    if (!this.ended) { this.ended = true; this.stream.close(); }
    try { await this.rpc?.stop(); }
    finally {
      if (this.workDirectory) await rm(this.workDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.runtime.onDispose();
    }
  }
}

