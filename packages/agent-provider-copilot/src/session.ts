import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { validateCommandDirectory, validateSessionSetting, type AgentCapabilities, type AgentChildSession, type AgentCommand, type AgentInteractionResponse, type AgentMessageOptions, type AgentRuntimeInfo, type AgentSession, type AgentSessionConfig, type AgentStreamEvent, type ProviderStreamItem } from '@borgee/agent-provider-sdk';
import type { CopilotAgentProviderOptions } from './provider.js';
import { Channel, deadline } from './channel.js';
import { Projector, provider, record, detail } from './projector.js';
import { CopilotChildSession } from './child-session.js';
import { NativeInteractions } from './interactions.js';
export class CopilotAgentSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, queueMessage: true, steer: true, cancel: true, readResource: true, commands: false, sessionSettings: false, interactions: {question: true, toolApproval: true, planApproval: false} };
  readonly stream = new Channel<ProviderStreamItem>();
  private readonly projector = new Projector();
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
  private native!: CopilotSession;
  private info: AgentRuntimeInfo;
  private constructor(private readonly config: AgentSessionConfig, private readonly options: CopilotAgentProviderOptions, private readonly onDispose: () => void) {
    this.info = {providerId: provider, sessionId: config.sessionId, status: 'idle', cwd: config.cwd, model: config.model, childSessions: [], persistence: {providerId: provider, sessionId: config.sessionId, opaque: JSON.stringify({cwd: config.cwd})}};
  }
  static async open(client: CopilotClient, config: AgentSessionConfig, resume: boolean, options: CopilotAgentProviderOptions, onDispose: () => void): Promise<CopilotAgentSession> {
    const self = new CopilotAgentSession(config, options, onDispose);
    const nativeConfig: SessionConfig = { ...options.nativeSessionConfig, sessionId: config.sessionId, workingDirectory: config.cwd, model: config.model, reasoningEffort: reasoningEffort(config.reasoningEffort), streaming: true, includeSubAgentStreamingEvents: true,
      systemMessage: config.systemPrompt ? {mode: 'append', content: config.systemPrompt} : undefined,
      onPermissionRequest: async () => ({kind: 'no-result'}),
      onUserInputRequest: request => self.interactions.bindQuestion(request)};
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
      for (const event of history) self.interactions.trackTool(event);
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
      for (const event of self.deferredEvents.splice(0)) self.emit(event);
      for (const event of buffered) self.accept(event, 'live');
      if (!processing && self.foregroundRevision === activityRevision) self.accept({type: 'assistant.idle', id: `activity-idle:${randomUUID()}`, parentId: null, timestamp: new Date().toISOString(), ephemeral: true, data: {}} as SessionEvent, 'live');
      self.emit({type: 'thread_started', provider, sessionId: config.sessionId});
      await self.refreshControls(); await self.refreshChildren(); self.emitRuntime(); return self;
    } catch (error) { await self.dispose(); throw error; }
  }
  call<T>(operation: Promise<T>, label: string): Promise<T> { return deadline(operation, this.options.requestTimeoutMs ?? 15000, label); }
  get rpc(): CopilotSession['rpc'] { return this.native.rpc; }
  get isClosed() { return this.closed; }
  observe(): AsyncIterable<ProviderStreamItem> { if (this.observed) throw new Error('Copilot observation already attached.'); this.observed = true; return this.stream; }
  emit(event: AgentStreamEvent): void { if (this.buffered) { this.deferredEvents.push(event); return; } if (!this.closed) this.stream.push({type: 'observation', sourceKey: `copilot:local:${randomUUID()}`, occurredAt: Date.now(), delivery: 'live', event}); }
  private emitRuntime() { this.emit({type: 'runtime_updated', provider, runtimeInfo: structuredClone({...this.info, status: this.interactions.waiting && !this.closed ? 'waiting' : this.info.status})}); }
  private accept(event: SessionEvent, delivery: 'history' | 'live'): void {
    if (this.closed || this.seen.has(event.id)) return; this.seen.add(event.id);
    
    const d = record(event.data); const owner = event.agentId ?? (typeof d.parentToolCallId === 'string' ? d.parentToolCallId : undefined);
    if (owner) { for (const child of this.children.values()) child.accept(event, delivery); }
    else {
      const projected = this.projector.project(event, delivery);
      if (projected) this.stream.push({type: 'observation', sourceKey: `copilot:${this.config.sessionId}:${projected.key}`, nativeRevision: ++this.revision, occurredAt: Date.parse(event.timestamp), delivery, event: projected.event});
      if (delivery === 'live') {
        if (event.type === 'assistant.turn_start') this.info.status = 'running';
        if (event.type === 'assistant.idle' || event.type === 'session.idle' || event.type === 'abort') this.info.status = 'idle';
        if (event.type === 'session.error') this.info.status = 'failed';
      }
    }
    if (delivery === 'live' && (event.type.startsWith('subagent.') || event.type === 'assistant.idle' || event.type === 'session.task_complete')) void this.refreshChildren().then(() => this.emitRuntime()).catch(error => this.options.onDiagnostic?.(String(error)));
  }
  async respondToInteraction(id: string, response: AgentInteractionResponse): Promise<void> {
    await this.interactions.respond(id, response); this.emitRuntime();
  }
  private assertOpen() { if (this.closed) throw new Error('Copilot session is closed.'); }
  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> { this.assertOpen(); await this.call(this.native.send({prompt: text, mode: options?.delivery === 'next_turn' ? 'enqueue' : 'immediate'}), 'Copilot input'); }
  async steer(text: string): Promise<void> { await this.sendMessage(text, {delivery: 'immediate'}); }
  async cancel(): Promise<void> { this.assertOpen(); await this.call(this.rpc.interruptMainTurn({}), 'Copilot cancellation');
    this.interactions.cancelOwner(); this.emitRuntime();
  }
  private async refreshControls(): Promise<void> {
    try {
      const [current, listing] = await Promise.all([this.call(this.rpc.model.getCurrent(), 'Copilot model'), this.call(this.rpc.model.list(), 'Copilot models')]);
      this.info.model = current.modelId;
      this.info.settings = [{id: 'model', category: 'model', label: 'Model', value: current.modelId ?? null, options: listing.list.map(record).filter(model => typeof model.id === 'string').map(model => ({value: model.id as string, label: typeof model.name === 'string' ? model.name : model.id as string})), mutable: true, scope: 'session'}];
      this.capabilities.sessionSettings = this.info.settings.some(setting => setting.options.length > 0);
      this.info.settings[0]!.mutable = this.capabilities.sessionSettings;
    } catch (error) { this.capabilities.sessionSettings = false; this.options.onDiagnostic?.(`Copilot model controls unavailable: ${String(error)}`); }
    try { await this.listCommands(); this.capabilities.commands = true; } catch (error) { this.capabilities.commands = false; this.options.onDiagnostic?.(`Copilot skills unavailable: ${String(error)}`); }
  }
  async setSessionSetting(id: string, value: string): Promise<void> {
    this.assertOpen(); validateSessionSetting(this.info.settings, id, value);
    await this.call(this.rpc.model.switchTo({modelId: value}), 'Copilot model switch'); await this.refreshControls(); this.emitRuntime();
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
    const command = (await this.listCommands()).find(command => command.id === id);
    if (!command) throw new Error('Unknown or disabled Copilot skill.');
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
    const path = this.resources.get(locator);
    if (!path) return {status: 'unavailable' as const, reason: 'Unknown Copilot resource.'};
    try { return {status: 'available' as const, bytes: await readFile(path), mediaType: 'text/markdown'}; }
    catch { return {status: 'unavailable' as const, reason: 'Copilot skill document is unavailable.'}; }
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
    if (this.closed) return; this.interactions.dispose(); this.closed = true; this.unsubscribe?.(); await Promise.allSettled([...this.children.values()].map(child => child.dispose()));
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
