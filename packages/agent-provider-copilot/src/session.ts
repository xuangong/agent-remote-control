import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { IMAGE_INPUT_CAPABILITIES, type AgentInputPart, validateCommandDirectory, validateSessionSetting, type AgentCapabilities, type AgentChildSession, type AgentCommand, type AgentInteractionResponse, type AgentMessageOptions, type AgentRuntimeInfo, type AgentSession, type AgentSessionConfig, type AgentStreamEvent, type AgentTaskItem, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { CopilotAgentProviderOptions } from './provider.js';
import { Channel, deadline } from './channel.js';
import { Projector, provider, record } from './projector.js';
import { CopilotChildSession } from './child-session.js';
import {isNativeInteraction} from './interaction-mapping.js';
import {CopilotImages} from './images.js';
import { NativeInteractions } from './interactions.js';
export class CopilotAgentSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { imageInput: structuredClone(IMAGE_INPUT_CAPABILITIES), history: true, sendMessage: true, queueMessage: true, steer: true, cancel: true, readResource: true, commands: false, sessionSettings: false, interactions: {question: true, toolApproval: true, planApproval: false, form: true, externalAction: true} };
  readonly stream = new Channel<ProviderStreamItem>();
  private readonly projector: Projector;
  private readonly images: CopilotImages;
  private readonly seen = new Set<string>();
  private readonly interactions = new NativeInteractions(event => this.emit(event), () => this.rpc, (operation, label) => this.call(operation, label));
  private readonly children = new Map<string, CopilotChildSession>();
  private readonly resources = new Map<string, string>();
  private unsubscribe?: () => void;
  private buffered: SessionEvent[] | undefined = [];
  private readonly deferredEvents: AgentStreamEvent[] = [];
  private closed = false;
  private observed = false;
  private revision = 0;
  private foregroundRevision = 0;
  private todosRefresh: Promise<void> = Promise.resolve();
  private updatingPermissions = false;
  private todosSignature = '[]';
  private native!: CopilotSession;
  private info: AgentRuntimeInfo;
  private constructor(private readonly config: AgentSessionConfig, private readonly options: CopilotAgentProviderOptions, private readonly onDispose: () => void) {
    this.projector = new Projector(config.cwd);
    this.images = new CopilotImages(config.sessionId);
    this.info = {providerId: provider, sessionId: config.sessionId, status: 'idle', cwd: config.cwd, model: config.model, childSessions: [], persistence: {providerId: provider, sessionId: config.sessionId, opaque: JSON.stringify({cwd: config.cwd})}};
  }
  static async open(client: CopilotClient, config: AgentSessionConfig, resume: boolean, options: CopilotAgentProviderOptions, onDispose: () => void): Promise<CopilotAgentSession> {
    const self = new CopilotAgentSession(config, options, onDispose);
    const nativeConfig: SessionConfig = { ...options.nativeSessionConfig, sessionId: config.sessionId, workingDirectory: config.cwd, model: config.model, reasoningEffort: reasoningEffort(config.reasoningEffort), streaming: true, includeSubAgentStreamingEvents: true,
      systemMessage: config.systemPrompt ? {mode: 'append', content: config.systemPrompt} : undefined,
      onPermissionRequest: async () => ({kind: 'no-result'}),
      onUserInputRequest: request => self.interactions.bindQuestion(request),
      onExitPlanModeRequest: request => self.interactions.bindPlan(request),
      onElicitationRequest: request => self.interactions.bindElicitation(request)};
    try {
      const opening = resume ? client.resumeSession(config.sessionId, nativeConfig) : client.createSession(nativeConfig);
      void opening.then(async native => {
        if (self.closed) await self.call(native.disconnect(), 'Disconnect late Copilot session');
      }).catch(error => options.onDiagnostic?.(`Copilot late session cleanup: ${String(error)}`));
      self.native = await self.call(opening, 'Open Copilot session');
      self.unsubscribe = self.native.on(event => {
        if (!event.agentId && !record(event.data).parentToolCallId && ['assistant.turn_start', 'assistant.idle', 'abort', 'session.error'].includes(event.type)) self.foregroundRevision++;
        self.interactions.accept(event); if (self.buffered) self.buffered.push(event); else self.accept(event, 'live'); });
      const history = await self.call(self.native.getEvents(), 'Read Copilot history');
      const completedInteractions = new Set<string>();
      for (const event of history) {
        self.interactions.trackTool(event);
        if (isNativeInteraction(event) && event.type.endsWith('.completed')) {
          const id = record(event.data).requestId; if (typeof id === 'string') completedInteractions.add(id);
          // Reconcile already-live callbacks only; historical requests are never reopened.
          self.interactions.accept(event);
        }
        if (event.type === 'session.binary_asset') self.images.register(event.data);
      }
      const activityRevision = self.foregroundRevision;
      const {processing} = await self.call(self.rpc.metadata.isProcessing(), 'Copilot foreground activity');
      const historicalIds = new Set(history.map(event => event.id));
      const finals = new Set(history.filter(event => event.type === 'assistant.message').map(event => event.data.messageId));
      const bufferedForeground = self.buffered!.some(event => !event.agentId && !record(event.data).parentToolCallId && !historicalIds.has(event.id)
        && ['assistant.turn_start', 'assistant.turn_end', 'assistant.idle', 'assistant.message', 'assistant.message_delta', 'abort', 'session.error'].includes(event.type)
        && !(event.type === 'assistant.message_delta' && finals.has(event.data.messageId)));
      self.projector.prepareHistory(history.filter(event => !event.agentId && !record(event.data).parentToolCallId), !processing && !bufferedForeground);
      self.info.status = processing ? 'running' : 'idle';
      for (const event of history) self.accept(event, 'history');
      self.stream.push({type: 'history_boundary'});
      const buffered = self.buffered!; self.buffered = undefined;
      for (const event of self.deferredEvents.splice(0)) {
        const id = event.type === 'interaction_requested' ? event.request.requestId : event.type === 'interaction_resolved' || event.type === 'interaction_invalidated' ? event.requestId : undefined;
        if (!id || !completedInteractions.has(id)) self.emit(event);
      }
      for (const event of buffered) self.accept(event, 'live');
      if (!processing && self.foregroundRevision === activityRevision) self.accept({type: 'assistant.idle', id: `activity-idle:${randomUUID()}`, parentId: null, timestamp: new Date().toISOString(), ephemeral: true, data: {}} as SessionEvent, 'live');
      self.emit({type: 'thread_started', provider, sessionId: config.sessionId});
      await self.refreshControls(); await self.initializePermissions(resume); await self.refreshMode();
      if (config.planning !== undefined) await self.setPlanning(config.planning);
      await self.refreshTodos(); await self.refreshChildren(); self.emitRuntime(); return self;
    } catch (error) { await self.dispose(); throw error; }
  }
  call<T>(operation: Promise<T>, label: string): Promise<T> { return deadline(operation, this.options.requestTimeoutMs ?? 15000, label); }
  get rpc(): CopilotSession['rpc'] { return this.native.rpc; }
  get isClosed() { return this.closed; }
  get cwd() { return this.config.cwd; }
  observe(): AsyncIterable<ProviderStreamItem> { if (this.observed) throw new Error('Copilot observation already attached.'); this.observed = true; return this.stream; }
  emit(event: AgentStreamEvent): void { if (this.buffered) { this.deferredEvents.push(event); return; } if (!this.closed) this.stream.push({type: 'observation', sourceKey: `copilot:local:${randomUUID()}`, occurredAt: Date.now(), delivery: 'live', event}); }
  private emitRuntime() { this.emit({type: 'runtime_updated', provider, runtimeInfo: structuredClone({...this.info, status: this.interactions.waiting && !this.closed ? 'waiting' : this.info.status})}); }
  private accept(event: SessionEvent, delivery: 'history' | 'live'): void {
    if (this.closed || this.seen.has(event.id)) return; this.seen.add(event.id);
    
    if (event.type === 'session.binary_asset') this.images.register(event.data);
    const d = record(event.data); const owner = event.agentId ?? (typeof d.parentToolCallId === 'string' ? d.parentToolCallId : undefined);
    if (owner && !(delivery === 'history' && isNativeInteraction(event))) { for (const child of this.children.values()) child.accept(event, delivery); }
    else {
      for (const projected of this.projector.projectAll(event, delivery)) {
        if (owner && 'turnId' in projected.event) delete projected.event.turnId;
        const images = event.type === 'user.message' && event.data.attachments?.length ? this.images.project(event.id, event.data.content, event.data.attachments) : undefined;
        if (images && projected.event.type === 'timeline' && projected.event.item.type === 'user_message') projected.event.item.content = images.content;
        this.stream.push({type: 'observation', sourceKey: `copilot:${this.config.sessionId}:${projected.key}`, nativeRevision: ++this.revision, occurredAt: Date.parse(event.timestamp), delivery, event: projected.event, ...(images ? {resourceReferences: images.resourceReferences} : {})});
      }
      if (delivery === 'live') {
        if (event.type === 'assistant.turn_start') this.info.status = 'running';
        if (event.type === 'assistant.idle' || event.type === 'session.idle' || event.type === 'abort') this.info.status = 'idle';
        if (event.type === 'session.error') this.info.status = 'failed';
      }
    }
    if (delivery === 'live' && event.type === 'session.permissions_changed') {
      // Aggregate permission notifications do not identify the tool-approval toggle.
      if (!this.updatingPermissions) {this.applyPermissions(null); this.emitRuntime();}
    }
    if (delivery === 'live' && event.type === 'session.mode_changed') {
      this.info.mode = event.data.newMode; this.info.planning = {active: event.data.newMode === 'plan'}; this.emitRuntime();
    }
    if (delivery === 'live' && event.type === 'session.todos_changed') void this.refreshTodos();
    if (delivery === 'live' && event.type === 'session.model_change') void this.refreshControls().then(() => this.emitRuntime()).catch(error => this.options.onDiagnostic?.(String(error)));
    if (delivery === 'live' && (event.type.startsWith('subagent.') || event.type === 'assistant.idle' || event.type === 'session.task_complete')) void this.refreshChildren().then(() => this.emitRuntime()).catch(error => this.options.onDiagnostic?.(String(error)));
  }
  async respondToInteraction(id: string, response: AgentInteractionResponse): Promise<void> {
    await this.interactions.respond(id, response); this.emitRuntime();
  }
  private assertOpen() { if (this.closed) throw new AgentOperationRejectedError('operation_rejected', 'Copilot session is closed.'); }
  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> { this.assertOpen(); await this.call(this.native.send({prompt: text, mode: options?.delivery === 'next_turn' ? 'enqueue' : 'immediate'}), 'Copilot input'); }
  async sendMessageContent(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<void> {
    this.assertOpen();
    if (!parts.some(p => p.type === 'image')) return this.sendMessage(parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n'), options);
    if (!this.capabilities.imageInput) throw new AgentOperationRejectedError('operation_rejected', 'The selected Copilot model does not advertise image input.');
    const input = await prepareAgentOperation(() => this.images.input(parts, this.capabilities.imageInput!));
    this.assertOpen();
    await this.call(this.native.send({...input, mode: options?.delivery === 'next_turn' ? 'enqueue' : 'immediate'}), 'Copilot image input');
  }
  async steer(text: string): Promise<void> { await this.sendMessage(text, {delivery: 'immediate'}); }
  async cancel(): Promise<void> { this.assertOpen(); await this.call(this.rpc.interruptMainTurn({}), 'Copilot cancellation');
    this.interactions.cancelOwner(); this.emitRuntime();
  }
  private async refreshControls(): Promise<void> {
    try {
      const [current, listing] = await Promise.all([this.call(this.rpc.model.getCurrent(), 'Copilot model'), this.call(this.rpc.model.list(), 'Copilot models')]);
      this.info.model = current.modelId;
      const permissions = this.info.settings?.filter(s => s.category === 'permissions') ?? [];
      this.info.settings = [...permissions, {id: 'model', category: 'model', label: 'Model', value: current.modelId ?? null, options: listing.list.map(record).filter(model => typeof model.id === 'string').map(model => ({value: model.id as string, label: typeof model.name === 'string' ? model.name : model.id as string})), mutable: true, scope: 'session'}];
      const model = listing.list.map(record).find(m => m.id === current.modelId);
      const supports = record(record(model?.capabilities).supports);
      const limits = record(record(record(model?.capabilities).limits).vision);
      if (supports.vision === false) delete this.capabilities.imageInput;
      else {
        const bounded = (value: unknown, maximum: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
        const media = limits.supported_media_types ?? limits.supportedMediaTypes;
        const mediaTypes = IMAGE_INPUT_CAPABILITIES.mediaTypes.filter(type => !Array.isArray(media) || media.includes(type));
        this.capabilities.imageInput = {...IMAGE_INPUT_CAPABILITIES, mediaTypes, maxImages: bounded(limits.max_prompt_images ?? limits.maxPromptImages, IMAGE_INPUT_CAPABILITIES.maxImages), maxImageBytes: bounded(limits.max_prompt_image_size ?? limits.maxPromptImageSize, IMAGE_INPUT_CAPABILITIES.maxImageBytes)};
        if (!mediaTypes.length) delete this.capabilities.imageInput;
      }
      const supportedEfforts = model?.supportedReasoningEfforts ?? supports.reasoning_effort;
      const efforts = Array.isArray(supportedEfforts) ? [...new Set(supportedEfforts.filter((v): v is string => typeof v === 'string' && v.length > 0))] : [];
      if (efforts.length || current.reasoningEffort) this.info.settings.push({id: 'reasoning_effort', category: 'model', label: 'Reasoning effort', value: current.reasoningEffort ?? null, options: efforts.map(value => ({value, label: value})), mutable: efforts.length > 0, scope: 'session'});
      this.capabilities.sessionSettings = this.info.settings.some(setting => setting.options.length > 0);
      const modelSetting = this.info.settings.find(s => s.id === 'model')!; modelSetting.mutable = modelSetting.options.length > 0;
    } catch (error) { this.capabilities.sessionSettings = this.info.settings?.some(s => s.category === 'permissions' && s.mutable) ?? false; this.options.onDiagnostic?.(`Copilot model controls unavailable: ${String(error)}`); }
    try { await this.listCommands(); this.capabilities.commands = true; } catch (error) { this.capabilities.commands = false; this.options.onDiagnostic?.(`Copilot skills unavailable: ${String(error)}`); }
  }
  private applyPermissions(value: 'ask' | 'allow' | null): void {
    this.info.settings = [...(this.info.settings ?? []).filter(s => s.id !== 'tool_approval_mode'), {
      id: 'tool_approval_mode', category: 'permissions', label: 'Tool approvals', value, mutable: true, scope: 'session',
      description: 'Controls native tool approval. Path, URL, and managed permission rules are checked separately.',
      options: [
        {value: 'ask', label: 'Ask for approval', description: 'Use native tool rules and ask when approval is required. Existing session grants remain in effect.'},
        {value: 'allow', label: 'Allow tools', description: 'Automatically approve tool operations in this session. Path and network access may still require approval.'},
      ],
    }];
    this.capabilities.sessionSettings = true;
  }
  private async initializePermissions(resume: boolean): Promise<void> {
    try {
      // The stdio runtime exposes mutations but no tool-policy getter. Do not infer restored policy.
      const result = await this.call(resume ? this.rpc.permissions.configure({}) : this.rpc.permissions.setApproveAll({enabled: false}), 'Copilot tool permissions');
      if (result.success) this.applyPermissions(resume ? null : 'ask');
    } catch (error) {this.options.onDiagnostic?.(`Copilot permission controls unavailable: ${String(error)}`);}
  }
  async setSessionSetting(id: string, value: string): Promise<void> {
    this.assertOpen(); validateSessionSetting(this.info.settings, id, value);
    if (id === 'tool_approval_mode') {
      this.updatingPermissions = true;
      try {
        const result = await this.call(this.rpc.permissions.setApproveAll({enabled: value === 'allow'}), 'Copilot tool permissions');
        if (!result.success) throw new Error('Copilot did not confirm the requested tool approval mode.');
        this.applyPermissions(value as 'ask' | 'allow'); this.emitRuntime();
      } catch (error) {
        // A timed-out mutation may have applied; do not display an unverified old value.
        this.applyPermissions(null); this.emitRuntime(); throw error;
      } finally {this.updatingPermissions = false;}
      return;
    }
    if ((await prepareAgentOperation(() => this.call(this.rpc.metadata.isProcessing(), 'Copilot foreground activity'))).processing) throw new AgentOperationRejectedError('operation_rejected', 'Copilot model changes require an idle session.');
    this.assertOpen();
    if (id === 'reasoning_effort') await this.call(this.rpc.model.setReasoningEffort({reasoningEffort: value}), 'Copilot reasoning effort');
    else {
      const result = await this.call(this.rpc.model.switchTo({modelId: value}), 'Copilot model switch');
      if (result.deferred) throw new Error('Copilot deferred the model change; confirmation is pending native application.');
    }
    await this.refreshControls(); this.emitRuntime();
  }
  private async refreshMode(): Promise<void> {
    try {
      this.info.mode = await this.call(this.rpc.mode.get(), 'Copilot mode');
      this.info.planning = {active: this.info.mode === 'plan'};
      this.capabilities.planning = true; this.capabilities.interactions.planApproval = true;
    } catch (error) {this.options.onDiagnostic?.(`Copilot planning unavailable: ${String(error)}`);}
  }
  async setPlanning(active: boolean): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.planning) throw new AgentOperationRejectedError('operation_rejected', 'Copilot planning is unavailable.');
    await this.call(this.rpc.mode.set({mode: active ? 'plan' : 'interactive'}), 'Copilot planning mode');
    await this.refreshMode(); this.emitRuntime();
    if (this.info.planning?.active !== active) throw new Error('Copilot did not confirm the requested planning mode.');
  }
  private refreshTodos(): Promise<void> {
    this.todosRefresh = this.todosRefresh.then(async () => {
      if (this.closed) return;
      const {rows} = await this.call(this.rpc.plan.readSqlTodos(), 'Copilot todos');
      const items: AgentTaskItem[] = rows.flatMap(row => {
        const text = row.title || row.description; if (!text) return [];
        const status = row.status === 'done' || row.status === 'completed' ? 'completed' : row.status === 'in_progress' ? 'in_progress' : row.status === 'pending' ? 'pending' : undefined;
        return [{text, completed: status === 'completed', ...(row.id ? {id: row.id} : {}), ...(status ? {status} : {})}];
      });
      const signature = JSON.stringify(items); if (signature === this.todosSignature) return;
      this.todosSignature = signature;
      this.emit({type: 'timeline', provider, item: {type: 'todo', items}});
    }).catch(error => this.options.onDiagnostic?.(`Copilot todos unavailable: ${String(error)}`));
    return this.todosRefresh;
  }
  async listCommands(): Promise<AgentCommand[]> {
    this.assertOpen(); await this.call(this.rpc.skills.ensureLoaded(), 'Load Copilot skills');
    const listing = await this.call(this.rpc.skills.list(), 'Copilot skills'); this.resources.clear();
    return validateCommandDirectory(listing.skills.filter(skill => skill.enabled && skill.userInvocable).map(skill => {
      const locator = `copilot:skill:${encodeURIComponent(skill.name)}`;
      if (skill.path) this.resources.set(locator, skill.path);
      return {id: skill.name, name: skill.commandName ?? skill.name, kind: 'skill', description: skill.description, inputHint: skill.argumentHint, ...(skill.path ? {documentation: locator} : {})};
    }));
  }
  async executeCommand(id: string, args: string) {
    const command = (await prepareAgentOperation(() => this.listCommands())).find(command => command.id === id);
    if (!command) throw new AgentOperationRejectedError('operation_rejected', 'Unknown or disabled Copilot skill.');
    this.assertOpen();
    const result = await this.call(this.rpc.commands.invoke({name: command.name, input: args}), 'Invoke Copilot skill');
    if (result.runtimeSettingsChanged) { await this.refreshControls(); this.emitRuntime(); }
    if (result.kind === 'agent-prompt') {
      if (result.mode && result.mode !== 'interactive') throw new Error('Copilot skill requested an unsupported agent mode.');
      await this.call(this.native.send({prompt: result.prompt, displayPrompt: result.displayPrompt, mode: 'immediate'}), 'Send Copilot skill prompt');
      return {text: result.notice};
    }
    if (result.kind === 'text') return {text: result.text};
    if (result.kind === 'completed') return {text: result.message};
    throw new Error('Copilot skill requires unsupported subcommand selection.');
  }
  async readResource(locator: string) {
    this.assertOpen();
    if (locator.startsWith('copilot-image:')) return this.images.read(locator);
    try {
      await this.listCommands();
      const path = this.resources.get(locator);
      if (!path) return {status: 'unavailable' as const, reason: 'Unknown Copilot resource.'};
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const limit = 256 * 1024;
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported skill document.');
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > limit) throw new Error('Skill document exceeds limit.');
        return {status: 'available' as const, bytes: bytes.subarray(0, length), mediaType: 'text/plain'};
      } finally { await handle.close(); }
    } catch { return {status: 'unavailable' as const, reason: 'Copilot skill document is unavailable.'}; }
  }

  async refreshChildren(): Promise<void> {
    try {
      const generations = new Map([...this.children].map(([id, child]) => [id, child.activityGeneration]));
      const listing = await this.call(this.rpc.tasks.list(), 'Copilot child sessions');
      this.info.childSessions = listing.tasks.filter(task => task.type === 'agent').map(task => ({ nativeSessionId: task.id, title: task.description || task.agentType, role: task.agentType, description: task.description, createdAt: task.startedAt, parentCallId: task.toolCallId, status: childStatus(task.status), observation: 'live' }));
      for (const info of this.info.childSessions) this.children.get(info.nativeSessionId)?.updateTask(info, generations.get(info.nativeSessionId), listing.tasks.find(task => task.id === info.nativeSessionId)?.status);
    } catch (error) { this.options.onDiagnostic?.(`Copilot child directory unavailable: ${String(error)}`); }
  }
  cancelChildInteractions(id: string): void { this.interactions.cancelOwner(id); this.emitRuntime(); }
  async openChildSession(id: string): Promise<AgentSession> {
    this.assertOpen(); await this.refreshChildren();
    const info = this.info.childSessions?.find(child => child.nativeSessionId === id);
    if (!info) throw new Error('Copilot child does not belong to this loaded parent.');
    if (this.children.has(id)) throw new Error('Copilot child session is already loaded.');
    const child = new CopilotChildSession(this, info, () => this.children.delete(id)); this.children.set(id, child);
    try { await child.initialize(); return child; } catch (error) { await child.dispose(); throw error; }
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return structuredClone({...this.info, status: this.interactions.waiting && !this.closed ? 'waiting' : this.info.status}); }
  async dispose(): Promise<void> {
    if (this.closed) return; this.interactions.dispose(); this.images.stop(); this.closed = true; this.unsubscribe?.(); await Promise.allSettled([...this.children.values()].map(child => child.dispose()));
    this.info.status = 'closed'; this.stream.close(); this.onDispose();
    if (this.native) await this.call(this.native.disconnect(), 'Disconnect Copilot session');
  }
}
function childStatus(status: string): AgentChildSession['status'] {
  if (status === 'running' || status === 'idle') return status;
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'starting';
  return 'closed';
}

function reasoningEffort(value?: string): SessionConfig['reasoningEffort'] {
  if (value === undefined || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  throw new Error('Unsupported Copilot reasoning effort.');
}
