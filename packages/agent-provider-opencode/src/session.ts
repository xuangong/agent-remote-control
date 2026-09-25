import { randomBytes } from 'node:crypto';
import { IMAGE_INPUT_CAPABILITIES, validateInteractionResponse, validateSessionSetting, type AgentCapabilities, type AgentCommand, type AgentInputPart, type AgentInteractionRequest, type AgentInteractionResponse, type AgentMessageOptions, type AgentRuntimeInfo, type AgentSession, type AgentSessionExtensions, type AgentSessionSetting, type AgentStreamEvent, type ProviderObservation, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { Event, GlobalEvent, Message, Part } from '@opencode-ai/sdk/v2/client';
import type { OpenCodePersistence } from './provider.js';
import { OpenCodeTransport } from './transport.js';
import { ObservationChannel } from './channel.js';
import { OpenCodeImages } from './images.js';
import { fingerprint, nativeError, normalize, todoItem, usage, type NativeMessage } from './normalize.js';
import { permissionRequest, questionRequest, questionResponse } from './interactions.js';

export class OpenCodeSession implements AgentSession {
  readonly capabilities: AgentCapabilities;
  private readonly output = new ObservationChannel();
  private readonly images: OpenCodeImages;
  private readonly abort = new AbortController();
  private readonly messages = new Map<string, NativeMessage>();
  private readonly pending = new Map<string, AgentInteractionRequest>();
  private readonly submitting = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private readonly terminalMessages = new Set<string>();
  private readonly terminalTurns = new Set<string>();
  private readonly supplemental = new Map<string, ProviderObservation>();
  private readonly pendingSelections = new Set<string>();
  private readonly sentSelections = new Map<string, { model?: string; agent?: string }>();
  private lastNativeUserId?: string;
  private streamConnected = false;
  private olderCursor?: string;
  private observed = false;
  private timeline: ProviderObservation[] = [];
  private settings: AgentSessionSetting[] = [];
  private status: AgentRuntimeInfo['status'] = 'starting';
  private connection: NonNullable<AgentRuntimeInfo['connection']> = { state: 'restoring' };
  private activeTurnId: string | null = null;
  private active = false;
  private closed = false;
  private initialized = false;
  private recovering = false;
  private recoveryDirty = false;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private stream?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private initialResolve!: () => void;
  private initialReject!: (error: unknown) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.initialResolve = resolve; this.initialReject = reject; });
  private lastUsage = '';
  private lastTodos = '';
  constructor(private readonly transport: OpenCodeTransport, readonly nativeId: string, private readonly config: OpenCodePersistence, private readonly extensions: AgentSessionExtensions, private readonly onClose: () => void) {
    this.images = new OpenCodeImages(nativeId);
    if (config.model !== undefined) this.pendingSelections.add('model');
    if (config.agent !== undefined) this.pendingSelections.add('agent');
    this.capabilities = { sessionControl: 'shared', history: true, sendMessage: !transport.restricted, steer: false, cancel: !transport.restricted, readResource: true, imageInput: IMAGE_INPUT_CAPABILITIES, sessionSettings: !transport.restricted, commands: !transport.restricted, planning: !transport.restricted, interactions: { question: true, planApproval: false, toolApproval: true } };
  }
  async start(): Promise<void> {
    const deadline = setTimeout(() => this.initialReject(new Error('OpenCode session observation did not become ready.')), this.transport.timeout);
    this.emit({ type: 'thread_started', provider: 'opencode', sessionId: this.nativeId }, 'thread');
    this.stream = this.transport.events(this.abort.signal, () => this.connected(), attempt => {
      this.streamConnected = false;
      this.connection = { state: 'reconnecting', attempt, reason: 'OpenCode event connection interrupted.' };
      this.emitRuntime();
    }, event => this.receive(event));
    try { await this.ready; } finally { clearTimeout(deadline); }
  }
  observe(): AsyncIterable<ProviderStreamItem> { if (this.observed) throw new Error('OpenCode observation already attached.'); this.observed = true; return this.output; }
  private enqueue(operation: () => Promise<void> | void): void {
    this.queue = this.queue.then(async () => { if (!this.closed) await operation(); }).catch(() => {
      if (this.closed) return;
      this.connection = { state: 'restoring', reason: 'OpenCode state reconciliation is retrying.' };
      this.emitRuntime(); this.scheduleRefresh();
    });
  }
  private connected(): void {
    if (this.closed) return;
    this.streamConnected = true;
    this.recovering = true;
    this.connection = { state: 'restoring' }; this.emitRuntime();
    this.enqueue(async () => {
      try {
        await this.refresh();
        if (!this.initialized) {
          await this.loadSettings();
          this.output.push({ type: 'history_boundary', ...(this.olderCursor ? { olderCursor: this.olderCursor } : {}) }); this.initialized = true;
        }
        if (this.streamConnected) this.connection = { state: 'connected' };
        this.emitRuntime(); this.initialResolve();
      } catch (error) {
        if (!this.initialized) this.initialReject(error);
        throw error;
      } finally {
        this.recovering = false;
        if (this.recoveryDirty) { this.recoveryDirty = false; this.scheduleRefresh(); }
      }
    });
  }
  private scheduleRefresh(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.enqueue(async () => {
        this.recovering = true;
        try {
          await this.refresh();
          if (this.streamConnected && this.connection.state === 'restoring') { this.connection = { state: 'connected' }; this.emitRuntime(); }
        } finally {
          this.recovering = false;
          if (this.recoveryDirty) { this.recoveryDirty = false; this.scheduleRefresh(); }
        }
      });
    }, 100);
    this.refreshTimer.unref();
  }
  private receive(global: GlobalEvent): void {
    if (this.closed || !global.payload || !('properties' in global.payload)) return;
    const event = global.payload;
    const properties = event.properties as Record<string, unknown>;
    const nested = (properties.info ?? properties.part) as { sessionID?: string; id?: string } | undefined;
    const sessionID = properties.sessionID ?? nested?.sessionID ?? (event.type.startsWith('session.') ? nested?.id : undefined);
    if (sessionID !== this.nativeId) return;
    if ('id' in event && typeof event.id === 'string') {
      if (this.seenEvents.has(event.id)) return;
      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 20000) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    if (this.recovering) { this.recoveryDirty = true; return; }
    this.enqueue(() => this.applyEvent(event));
  }
  private applyEvent(event: Event): void {
    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info;
        const old = this.messages.get(info.id);
        this.messages.set(info.id, { info, parts: old?.parts ?? [] });
        if (!old) this.scheduleRefresh();
        if (info.role === 'user') {
          const latest = this.orderedMessages().filter(message => message.info.role === 'user').at(-1)?.info;
          if (latest?.id === info.id) { if (this.active) this.activeTurnId = info.id; this.hydrateSelection(info); this.emitRuntime(); }
        }
        this.publishTimeline(); this.publishUsage();
        if (info.role === 'assistant' && info.error) this.failTurn(info.error, info.id);
        break;
      }
      case 'message.part.updated': {
        const part = event.properties.part;
        const message = this.messages.get(part.messageID);
        if (!message) { this.scheduleRefresh(); break; }
        const index = message.parts.findIndex(p => p.id === part.id);
        const previous = message.parts[index];
        if (previous && (part.type === 'text' || part.type === 'reasoning') && previous.type === part.type && previous.text.startsWith(part.text) && previous.text.length > part.text.length) { this.scheduleRefresh(); break; }
        if (index < 0) message.parts.push(part); else message.parts[index] = part;
        this.publishTimeline(); break;
      }
      case 'message.part.delta': {
        const p = event.properties;
        const part = this.messages.get(p.messageID)?.parts.find(part => part.id === p.partID);
        if (!part || !('text' in part) || p.field !== 'text') { this.scheduleRefresh(); break; }
        part.text += p.delta; this.publishTimeline(); break;
      }
      case 'message.removed': this.messages.delete(event.properties.messageID); this.publishTimeline(); break;
      case 'message.part.removed': {
        const p = event.properties; const message = this.messages.get(p.messageID);
        if (message) message.parts = message.parts.filter(part => part.id !== p.partID);
        this.publishTimeline(); break;
      }
      case 'session.status': if (event.properties.status.type === 'idle') this.scheduleRefresh(); else this.applyStatus(event.properties.status.type); break;
      case 'session.idle': this.scheduleRefresh(); break;
      case 'session.error': this.failTurn(event.properties.error ?? { name: 'UnknownError' }); this.scheduleRefresh(); break;
      case 'todo.updated': this.publishTodos(event.properties.todos); break;
      case 'session.compacted': this.scheduleRefresh(); break;
      case 'permission.asked': this.addInteraction(permissionRequest(event.properties, this.transport.restricted)); break;
      case 'question.asked': this.addInteraction(questionRequest(event.properties)); break;
      case 'permission.replied': this.resolveInteraction(event.properties.requestID, event.properties.reply === 'reject' ? { kind: 'tool_approval', decision: 'deny' } : { kind: 'tool_approval', decision: 'allow', scope: event.properties.reply === 'always' ? 'session' : 'once' }); break;
      case 'question.rejected': this.resolveInteraction(event.properties.requestID, { kind: 'question', answers: [], dismissed: true }); break;
      case 'question.replied': {
        const request = this.pending.get(event.properties.requestID);
        if (request?.kind === 'question') this.resolveInteraction(request.requestId, questionResponse(request, event.properties.answers));
        break;
      }
      case 'session.deleted': this.status = 'closed'; this.emitRuntime(); break;
    }
  }
  private async refresh(): Promise<void> {
    const parameters = { sessionID: this.nativeId, directory: this.config.cwd };
    const [history, statuses, permissions, questions, todos] = await Promise.all([
      this.transport.requestWithResponse(() => this.transport.client.session.messages({ ...parameters, limit: 200 })),
      this.transport.request(() => this.transport.client.session.status({ directory: this.config.cwd })),
      this.transport.request(() => this.transport.client.permission.list({ directory: this.config.cwd })),
      this.transport.request(() => this.transport.client.question.list({ directory: this.config.cwd })),
      this.transport.request(() => this.transport.client.session.todo(parameters)),
    ]);
    if (this.closed) return;
    const messages = history.data;
    this.olderCursor = history.response.headers.get('x-next-cursor') || undefined;
    this.messages.clear(); for (const message of messages) this.messages.set(message.info.id, message);
    const requests = [...permissions.filter(p => p.sessionID === this.nativeId).map(p => permissionRequest(p, this.transport.restricted)), ...questions.filter(q => q.sessionID === this.nativeId).map(questionRequest)];
    for (const [id] of this.pending) if (!requests.some(request => request.requestId === id)) {
      this.pending.delete(id); this.emit({ type: 'interaction_invalidated', provider: 'opencode', requestId: id, reason: 'Native request is no longer pending.' }, `interaction:${id}:invalidated`);
    }
    this.publishTimeline(); this.publishUsage(); this.publishTodos(todos);
    for (const request of requests) this.addInteraction(request);
    const latestUser = messages.filter(message => message.info.role === 'user').at(-1);
    const latestAssistant = messages.filter(message => message.info.role === 'assistant').at(-1)?.info;
    if (latestUser?.info.role === 'user') this.hydrateSelection(latestUser.info);
    const nativeStatus = statuses[this.nativeId]?.type ?? 'idle';
    if (latestAssistant?.role === 'assistant' && latestAssistant.error && nativeStatus === 'idle' && (!latestUser || latestAssistant.parentID === latestUser.info.id)) {
      this.failTurn(latestAssistant.error, latestAssistant.id);
      this.active = false; this.activeTurnId = null;
      this.status = latestAssistant.error.name === 'MessageAbortedError' ? 'idle' : 'failed'; this.emitRuntime();
    } else this.applyStatus(nativeStatus);
    if (!this.initialized) for (const message of messages) if (message.info.role === 'assistant' && message.info.time.completed) this.terminalMessages.add(message.info.id);
  }
  private orderedMessages(): NativeMessage[] { return [...this.messages.values()].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id)); }
  private publishTimeline(): void {
    const next = [...normalize(this.orderedMessages(), this.images), ...this.supplemental.values()];
    const previous = this.timeline;
    this.timeline = next;
    let common = 0;
    while (common < previous.length && common < next.length && fingerprint(previous[common]!.event) === fingerprint(next[common]!.event)) common++;
    if (common === previous.length) {
      for (const item of next.slice(common)) this.output.push({ ...item, delivery: this.initialized ? 'live' : 'history' });
      return;
    }
    const old = previous[common]; const changed = next[common];
    if (common === previous.length - 1 && changed && old && changed.sourceKey === old.sourceKey && old.event.type === 'timeline' && changed.event.type === 'timeline') {
      const before = old.event.item; const after = changed.event.item;
      if ((before.type === 'assistant_message' && after.type === 'assistant_message') || (before.type === 'reasoning' && after.type === 'reasoning')) {
        if (after.text.startsWith(before.text)) {
          const delta = after.text.slice(before.text.length);
          if (delta) this.output.push({ ...changed, sourceKey: `${changed.sourceKey}:text:${after.text.length}:${fingerprint(after.text)}`, delivery: 'live', event: { ...changed.event, item: { ...after, text: delta } } });
          for (const item of next.slice(common + 1)) this.output.push({ ...item, delivery: 'live' });
          return;
        }
      }
    }
    this.output.push({ type: 'timeline_replacement', observations: next, ...(this.olderCursor ? { olderCursor: this.olderCursor } : {}) });
  }
  private publishUsage(): void {
    const current = usage(this.orderedMessages()); const key = fingerprint(current);
    if (key === this.lastUsage) return;
    this.lastUsage = key; this.emit({ type: 'usage_updated', provider: 'opencode', usage: current }, `usage:${key}`);
  }
  private publishTodos(todos: Parameters<typeof todoItem>[0]): void {
    const key = fingerprint(todos); if (key === this.lastTodos || (!this.lastTodos && todos.length === 0)) return;
    this.lastTodos = key;
    this.supplemental.set('todo', { type: 'observation', sourceKey: 'todo', occurredAt: Date.now(), delivery: 'history', event: { type: 'timeline', provider: 'opencode', item: todoItem(todos) } });
    this.publishTimeline();
  }
  private applyStatus(nativeStatus: string): void {
    const running = nativeStatus === 'busy' || nativeStatus === 'retry';
    if (running && !this.active) {
      const latestUser = this.orderedMessages().filter(message => message.info.role === 'user').at(-1)?.info;
      const latest = this.orderedMessages().at(-1)?.info;
      this.activeTurnId = latestUser?.id ?? (latest?.role === 'assistant' ? latest.parentID : null);
      this.active = true; this.emit({ type: 'turn_started', provider: 'opencode', turnId: this.activeTurnId ?? undefined }); }
    if (!running && this.active) {
      this.active = false;
      this.emit({ type: 'turn_completed', provider: 'opencode', turnId: this.activeTurnId ?? undefined, usage: usage(this.orderedMessages()) });
    }
    this.status = this.pending.size ? 'waiting' : running ? 'running' : 'idle';
    if (!running) this.activeTurnId = null;
    this.emitRuntime();
  }
  private failTurn(error: { name: string }, messageId?: string): void {
    if (messageId && this.terminalMessages.has(messageId)) return;
    if (messageId) this.terminalMessages.add(messageId);
    const latest = this.orderedMessages().at(-1)?.info;
    const turnId = this.activeTurnId ?? (latest?.role === 'assistant' ? latest.parentID : latest?.id);
    if (turnId && this.terminalTurns.has(turnId)) return;
    if (turnId) this.terminalTurns.add(turnId);
    const canceled = error.name === 'MessageAbortedError';
    this.emit(canceled ? { type: 'turn_canceled', provider: 'opencode', turnId: this.activeTurnId ?? undefined, reason: 'OpenCode turn canceled.' } : { type: 'turn_failed', provider: 'opencode', turnId: this.activeTurnId ?? undefined, error: nativeError(error) });
    this.active = false; this.activeTurnId = null; this.status = canceled ? 'idle' : 'failed'; this.emitRuntime();
  }
  private addInteraction(request: AgentInteractionRequest): void {
    if (fingerprint(this.pending.get(request.requestId) ?? null) === fingerprint(request)) return;
    this.pending.set(request.requestId, request); this.status = 'waiting';
    this.emit({ type: 'interaction_requested', provider: 'opencode', request }, `interaction:${request.requestId}:request`); this.emitRuntime();
  }
  private resolveInteraction(requestId: string, response: AgentInteractionResponse): void {
    const request = this.pending.get(requestId);
    if (!request || !this.pending.delete(requestId)) return;
    this.supplemental.set(`interaction:${requestId}`, { type: 'observation', sourceKey: `interaction:${requestId}:receipt`, occurredAt: Date.now(), delivery: 'history', event: { type: 'timeline', provider: 'opencode', item: { type: 'interaction', request, response } } });
    // Relay creates the live receipt from interaction_resolved; replacements carry it explicitly.
    this.timeline = [...normalize(this.orderedMessages(), this.images), ...this.supplemental.values()];
    this.emit({ type: 'interaction_resolved', provider: 'opencode', requestId, response }, `interaction:${requestId}:resolved`);
    this.status = this.pending.size ? 'waiting' : this.active ? 'running' : 'idle'; this.emitRuntime();
  }
  private emit(event: AgentStreamEvent, key?: string): void {
    this.output.push({ type: 'observation', sourceKey: key ?? `runtime:${this.sequence + 1}`, nativeRevision: ++this.sequence, occurredAt: Date.now(), delivery: this.initialized ? 'live' : 'history', event });
  }
  private info(): AgentRuntimeInfo {
    return { providerId: 'opencode', sessionId: this.nativeId, status: this.status, cwd: this.config.cwd, model: this.config.model ?? null, mode: this.config.agent ?? null, planning: { active: this.config.agent === 'plan' }, settings: this.settings.map(setting => ({ ...setting, value: setting.id === 'model' ? this.config.model ?? null : this.config.agent ?? null })), connection: { ...this.connection }, persistence: { providerId: 'opencode', sessionId: this.nativeId, opaque: JSON.stringify({ cwd: this.config.cwd, model: this.config.model, agent: this.config.agent }) } };
  }
  private emitRuntime(): void { this.emit({ type: 'runtime_updated', provider: 'opencode', runtimeInfo: this.info(), activeTurnId: this.activeTurnId }); }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return this.info(); }
  private writable(): void {
    if (this.closed) throw new Error('OpenCode session is closed.');
    if (this.transport.restricted) throw new Error('OpenCode native execution is locked by Host policy.');
    if (this.connection.state !== 'connected') throw new Error('OpenCode is reconnecting. Wait for native state recovery before sending input.');
  }
  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> { await this.sendMessageContent([{ type: 'text', text }], options); }
  async sendMessageContent(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<void> {
    this.writable();
    if (options?.delivery && options.delivery !== 'immediate') throw new Error('OpenCode does not support queued message delivery.');
    const nativeParts = await this.images.input(parts);
    const selected = this.model();
    const messageID = this.messageId();
    this.sentSelections.set(messageID, { model: this.config.model, agent: this.config.agent });
    await this.transport.request(() => this.transport.client.session.promptAsync({ sessionID: this.nativeId, directory: this.config.cwd, messageID, parts: nativeParts, ...(selected ? { model: selected } : {}), agent: this.config.agent, system: this.extensions.systemPrompt }));
    this.scheduleRefresh();
  }
  private messageId(): string { return `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(10).toString('hex')}`; }
  private model(): { providerID: string; modelID: string } | undefined {
    if (!this.config.model) return;
    const separator = this.config.model.indexOf('/');
    if (separator < 1 || separator === this.config.model.length - 1) throw new Error('OpenCode models use provider/model identifiers.');
    return { providerID: this.config.model.slice(0, separator), modelID: this.config.model.slice(separator + 1) };
  }
  async cancel(): Promise<void> {
    this.writable();
    await this.transport.request(() => this.transport.client.session.abort({ sessionID: this.nativeId, directory: this.config.cwd }));
    this.scheduleRefresh();
  }
  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.writable();
    const request = this.pending.get(requestId);
    if (!request) throw new Error('OpenCode interaction is no longer pending.');
    if (this.submitting.has(requestId)) throw new Error('OpenCode interaction response is already pending.');
    validateInteractionResponse(request, response);
    this.submitting.add(requestId);
    try {
      const parameters = { requestID: requestId, directory: this.config.cwd };
      if (request.kind === 'question' && response.kind === 'question') {
        if (response.dismissed) await this.transport.request(() => this.transport.client.question.reject(parameters));
        else await this.transport.request(() => this.transport.client.question.reply({ ...parameters, answers: request.questions.map(question => {
          const answer = response.answers.find(answer => answer.questionId === question.questionId)!;
          return [...answer.selectedValues, ...(answer.customText ? [answer.customText] : [])];
        }) }));
      } else if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
        await this.transport.request(() => this.transport.client.permission.reply({ ...parameters, reply: response.decision === 'allow' ? response.scope === 'session' ? 'always' : 'once' : 'reject' }));
      } else throw new Error('Unsupported OpenCode interaction response.');
      this.resolveInteraction(requestId, response);
    } finally { this.submitting.delete(requestId); }
  }
  private hydrateSelection(info: Extract<Message, { role: 'user' }>): void {
    const sent = this.sentSelections.get(info.id);
    if (sent) {
      if (sent.model === this.config.model) this.pendingSelections.delete('model');
      if (sent.agent === this.config.agent) this.pendingSelections.delete('agent');
      this.sentSelections.delete(info.id);
    }
    if (this.lastNativeUserId === info.id) return;
    this.lastNativeUserId = info.id;
    if (!this.pendingSelections.has('model') && info.model?.providerID && info.model.modelID) this.config.model = `${info.model.providerID}/${info.model.modelID}`;
    if (!this.pendingSelections.has('agent') && info.agent) this.config.agent = info.agent;
  }
  private async loadSettings(): Promise<void> {
    const [providers, agents] = await Promise.all([
      this.transport.request(() => this.transport.client.provider.list({ directory: this.config.cwd })),
      this.transport.request(() => this.transport.client.app.agents({ directory: this.config.cwd })),
    ]);
    this.settings = [
      { id: 'model', category: 'model', label: 'Model', value: this.config.model ?? null, mutable: !this.transport.restricted, scope: 'session', description: 'Used for the next prompt. Unsent selections persist only in this connection or its persistence handle.', options: providers.all.filter(provider => providers.connected.includes(provider.id)).flatMap(provider => Object.values(provider.models).map(model => ({ value: `${provider.id}/${model.id}`, label: `${provider.name}: ${model.name}` }))) },
      { id: 'agent', category: 'model', label: 'Agent', value: this.config.agent ?? null, mutable: !this.transport.restricted, scope: 'session', description: 'Used for the next prompt. Unsent selections persist only in this connection or its persistence handle.', options: agents.filter(agent => !agent.hidden && agent.mode !== 'subagent').map(agent => ({ value: agent.name, label: agent.name, description: agent.description })) },
    ];
  }
  async setSessionSetting(id: string, value: string): Promise<void> {
    this.writable(); validateSessionSetting(this.settings, id, value);
    this.pendingSelections.add(id);
    if (id === 'model') this.config.model = value;
    else if (id === 'agent') this.config.agent = value;
    else throw new Error('Unsupported OpenCode setting.');
    this.emitRuntime();
  }
  async setPlanning(active: boolean): Promise<void> { await this.setSessionSetting('agent', active ? 'plan' : 'build'); }
  async listCommands(): Promise<AgentCommand[]> {
    if (this.closed) throw new Error('OpenCode session is closed.');
    const commands = await this.transport.request(() => this.transport.client.command.list({ directory: this.config.cwd }));
    return commands.map(command => ({ id: command.name, name: command.name, description: command.description ?? '', kind: 'command' }));
  }
  async executeCommand(id: string, args: string): Promise<{ text?: string }> {
    this.writable();
    if (!(await this.listCommands()).some(command => command.id === id)) throw new Error('Unknown OpenCode command.');
    await this.transport.request(() => this.transport.client.session.command({ sessionID: this.nativeId, directory: this.config.cwd, command: id, arguments: args, messageID: this.messageId(), model: this.config.model, agent: this.config.agent }));
    this.scheduleRefresh(); return {};
  }
  async readTimelineHistory(cursor: string): Promise<{ observations: ProviderObservation[]; nextCursor?: string }> {
    if (!cursor || cursor.length > 8192) throw new Error('Invalid OpenCode history cursor.');
    const page = await this.transport.requestWithResponse(() => this.transport.client.session.messages({ sessionID: this.nativeId, directory: this.config.cwd, limit: 200, before: cursor }));
    const nextCursor = page.response.headers.get('x-next-cursor');
    return { observations: normalize(page.data, this.images), ...(nextCursor && nextCursor !== cursor ? { nextCursor } : {}) };
  }
  async readResource(locator: string) { return this.images.read(locator); }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.abort.abort(); clearTimeout(this.refreshTimer);
    this.initialReject(new Error('OpenCode session closed.'));
    await this.stream; await this.queue;
    this.status = 'closed'; this.output.close(); this.images.close(); this.pending.clear(); this.onClose();
  }
}
