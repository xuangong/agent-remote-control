import { OpenCodePromptEditEvidence } from './prompt-edit-evidence.js';
import { openCodeSessionNativeEvidence } from './native-evidence.js';
import { readOpenCodeInputResponse } from './input-response.js';
import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import { randomBytes } from 'node:crypto';
import { IMAGE_INPUT_CAPABILITIES, validateInteractionResponse, type AgentInputAcceptance, type AgentCapabilities, type AgentCommand, type AgentInputPart, type AgentInteractionRequest, type AgentInteractionResponse, type AgentMessageOptions, type AgentRuntimeInfo, type AgentSession, type AgentSessionNativeEvidence, type AgentStreamEvent, type ProviderObservation, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { V2Event, SessionInfo as Session, FormInfo, SessionStructuredError } from '@opencode/client';
import { nativeHistoryPage } from './native-history.js';
import { turnIds, type NativeInput } from './v2-native.js';
import type { OpenCodePersistence } from './provider.js';
import { OpenCodeTransport } from './transport.js';
import { ObservationChannel } from './channel.js';
import { OpenCodeImages } from './images.js';
import { fingerprint, nativeError, normalize, usage, type NativeMessage } from './normalize.js';
import { orderedSnapshot, reconcileTimeline, type SupplementalObservation } from './timeline.js';
import { OpenCodeSettings } from './settings.js';
import { OpenCodeCommands } from './commands.js';
import { permissionRequest, formRequest, formAnswer, formResponse } from './interactions.js';

export class OpenCodeSession implements AgentSession {
  readonly capabilities: AgentCapabilities;
  readonly nativeEvidence: AgentSessionNativeEvidence = openCodeSessionNativeEvidence;
  readonly promptEditEvidence: OpenCodePromptEditEvidence;
  private readonly output = new ObservationChannel();
  private readonly images: OpenCodeImages;
  private readonly abort = new AbortController();
  private readonly messages = new Map<string, NativeMessage>();
  private readonly pending = new Map<string, AgentInteractionRequest>();
  private readonly submitting = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private readonly terminalTurns = new Set<string>();
  private readonly supplemental = new Map<string, SupplementalObservation>();
  private readonly controls: OpenCodeSettings;
  private readonly commands: OpenCodeCommands;
  private nativeSession?: Session;
  private children: NonNullable<AgentRuntimeInfo['childSessions']> = [];
  private readonly forms = new Map<string, FormInfo>();
  private readonly unsupportedForms = new Set<string>();
  private startsAtBeginning = false;
  private failure?: AgentRuntimeInfo['failure'];
  private failureIdleId?: string;
  private streamConnected = false;
  private olderCursor?: string;
  private observed = false;
  private timeline: ProviderObservation[] = [];
  private status: AgentRuntimeInfo['status'] = 'starting';
  private connection: NonNullable<AgentRuntimeInfo['connection']> = { state: 'restoring' };
  private activeTurnId: string | null = null;
  private active = false;
  private execution?: { turnId?: string; beforeIdle?: string };
  private pendingInput?: string;
  private readonly inputInvocations = new Map<string, { input?: NativeInput; accepted?: AgentInputAcceptance; notify?: AgentMessageOptions['onAcceptance'] }>();
  private pendingInputWhileRunning = false;
  private closed = false;
  private initialized = false;
  private recovering = false;
  private recoveryDirty = false;
  private catalogDirty = false;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private stream?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private initialResolve!: () => void;
  private initialReject!: (error: unknown) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.initialResolve = resolve; this.initialReject = reject; });
  private lastUsage = '';
  constructor(private readonly transport: OpenCodeTransport, readonly nativeId: string, private readonly config: OpenCodePersistence, private readonly onClose: () => void) {
    this.promptEditEvidence = new OpenCodePromptEditEvidence({ transport, nativeId, cwd: config.cwd,
      readable: () => !this.closed && this.initialized && this.streamConnected && this.connection.state === 'connected' && !this.recovering && !this.recoveryDirty,
      local: () => ({ idle: !this.active && !this.execution && this.status !== 'closed', pendingInputs: Number(!!this.pendingInput) + this.inputInvocations.size,
        pendingInteractions: this.pending.size + this.unsupportedForms.size + this.submitting.size }),
    });
    this.images = new OpenCodeImages(nativeId, { allowLocalFiles: transport.local });
    this.controls = new OpenCodeSettings(transport, nativeId, config.cwd, config);
    this.commands = new OpenCodeCommands(transport, nativeId, config.cwd);
    this.capabilities = { history: true, sendMessage: !transport.restricted, steer: !transport.restricted, cancel: !transport.restricted, readResource: true, imageInput: IMAGE_INPUT_CAPABILITIES, sessionSettings: !transport.restricted, commands: !transport.restricted, planning: !transport.restricted, interactions: { question: true, planApproval: false, toolApproval: true } };
  }
  async start(): Promise<void> {
    const deadline = setTimeout(() => this.initialReject(new Error('OpenCode session observation did not become ready.')), this.transport.timeout);
    this.emit({ type: 'thread_started', provider: 'opencode', sessionId: this.nativeId }, 'thread');
    this.stream = this.transport.events(this.abort.signal, () => this.connected(), attempt => {
      this.promptEditEvidence.invalidate();
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
      this.promptEditEvidence.invalidate();
      this.connection = { state: 'restoring', reason: 'OpenCode state reconciliation is retrying.' };
      this.emitRuntime(); this.scheduleRefresh();
    });
  }
  private connected(): void {
    if (this.closed) return;
    this.promptEditEvidence.invalidate();
    this.streamConnected = true;
    this.recovering = true;
    this.connection = { state: 'restoring' }; this.emitRuntime();
    this.enqueue(async () => {
      try {
        this.nativeSession = await this.controls.refresh();
        await this.refresh();
        if (!this.initialized) {
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
    if (this.closed) return;
    this.promptEditEvidence.invalidate();
    if (this.refreshTimer) return;
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
  private receive(event: V2Event): void {
    if (this.closed) return;
    if (['model.updated', 'agent.updated', 'provider.updated', 'config.updated', 'plugin.updated', 'credential.updated', 'models.dev.refreshed'].includes(event.type)
      && (!event.location || event.location.directory === this.config.cwd)) {
      this.promptEditEvidence.invalidate();
      this.catalogDirty = true;
      this.scheduleRefresh();
      return;
    }
    const data = event.data as Record<string, unknown>;
    const sessionID = event.type === 'form.created' ? event.data.form.sessionID : data.sessionID;
    if (sessionID !== this.nativeId) {
      if (this.promptEditEvidence.observes(sessionID, data.parentID) || this.children.some(child => child.nativeSessionId === sessionID)) this.scheduleRefresh();
      return;
    }
    this.promptEditEvidence.invalidate();
    if (event.id) {
      if (this.seenEvents.has(event.id)) return;
      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 20000) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    // Exact native delivery settles ordinary admission even while its timeline snapshot is still loading.
    if (event.type === 'session.inbox.delivered' && event.data.inboxID === this.pendingInput) this.releaseOrdinaryInput();
    if (this.recovering) { this.recoveryDirty = true; return; }
    this.enqueue(() => this.applyEvent(event));
  }
  private async applyEvent(event: V2Event): Promise<void> {
    switch (event.type) {
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const message = this.messages.get(event.data.assistantMessageID);
        const part = message?.type === 'assistant' ? message.content[event.data.ordinal] : undefined;
        const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        if (part?.type === kind && 'text' in part) { part.text += event.data.delta; this.publishTimeline(); }
        else this.scheduleRefresh();
        return;
      }
      case 'session.execution.started': this.applyStatus(true); break;
      case 'session.execution.failed': this.finishTurn('failed', event.data.error); break;
      case 'session.execution.interrupted': this.finishTurn('interrupted'); break;
      case 'session.execution.succeeded': this.finishTurn('succeeded'); break;
      case 'permission.asked': this.addInteraction(permissionRequest(event.data, this.transport.restricted)); break;
      case 'permission.replied': this.resolveInteraction(event.data.requestID, event.data.reply === 'reject' ? { kind: 'tool_approval', decision: 'deny' } : event.data.reply === 'always' ? { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'opencode:save' } : { kind: 'tool_approval', decision: 'allow', scope: 'once' }); break;
      case 'form.replied': {
        const form = this.forms.get(event.data.id);
        if (form) {
          try { this.resolveInteraction(form.id, formResponse(form, event.data.answer)); }
          catch { this.invalidateInteraction(form.id, 'The native form was answered outside this client and its response cannot be represented.'); }
        }
        this.forms.delete(event.data.id); this.unsupportedForms.delete(event.data.id);
        break;
      }
      case 'session.deleted': this.status = 'closed'; this.emitRuntime(); return;
    }
    // Durable v2 events update multiple native projections. Re-read their common baseline.
    this.scheduleRefresh();
  }
  private async refresh(): Promise<void> {
    this.promptEditEvidence.invalidate();
    if (this.catalogDirty) {
      this.catalogDirty = false;
      try { await this.controls.refresh(); }
      catch (error) { this.catalogDirty = true; throw error; }
    }
    const revision = this.controls.revision;
    const parameters = { sessionID: this.nativeId };
    const location = { location: { directory: this.config.cwd } };
    const [history, active, permissionPage, formPage, native, childPage] = await Promise.all([
      nativeHistoryPage(this.transport, this.nativeId),
      this.transport.request(() => this.transport.client.session.active()),
      this.transport.request(() => this.transport.client.permission.request.list(location)),
      this.transport.request(() => this.transport.client.form.list(location)),
      this.transport.request(() => this.transport.client.session.get(parameters)),
      this.transport.request(() => this.transport.client.session.list({ parentID: this.nativeId, limit: 200 })),
    ]);
    if (this.closed) return;
    const permissions = permissionPage.data.filter(request => request.sessionID === this.nativeId);
    const forms = formPage.data.filter(form => form.sessionID === this.nativeId);
    const waitingSessions = new Set([...permissionPage.data, ...formPage.data].map(request => request.sessionID));
    const children = [...childPage.data];
    let cursor = childPage.data.length === 200 ? childPage.cursor.next : undefined;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error('OpenCode child pagination did not advance.');
      seen.add(cursor);
      const page = await this.transport.request(() => this.transport.client.session.list({ parentID: this.nativeId, limit: 200, cursor: cursor! }));
      children.push(...page.data); cursor = page.data.length === 200 ? page.cursor.next : undefined;
    }
    if (this.controls.updateNative(native, revision)) this.nativeSession = native;
    this.capabilities.planning = this.controls.planningAvailable;
    this.children = children.map(child => ({ nativeSessionId: child.id, title: child.title ?? child.id, createdAt: new Date(child.time.created).toISOString(), status: waitingSessions.has(child.id) ? 'waiting' : active[child.id] ? 'running' : 'idle', observation: 'live' }));
    this.olderCursor = history.nextCursor; this.startsAtBeginning = history.startsAtBeginning;
    this.messages.clear(); for (const message of history.messages) this.messages.set(message.id, message);
    if (this.pendingInput && this.messages.has(this.pendingInput)) this.releaseOrdinaryInput();
    this.forms.clear(); this.unsupportedForms.clear();
    const requests: AgentInteractionRequest[] = permissions.map(p => permissionRequest(p, this.transport.restricted));
    for (const form of forms) {
      this.forms.set(form.id, form);
      try { requests.push(formRequest(form)); }
      catch (error) {
        this.unsupportedForms.add(form.id);
        this.publishUnsupportedForm(form, error);
      }
    }
    for (const [id] of this.pending) if (!requests.some(request => request.requestId === id)) {
      this.invalidateInteraction(id, 'Native request is no longer pending or representable.');
    }
    this.publishTimeline(true); this.publishUsage();
    for (const request of requests) this.addInteraction(request);
    const terminal = this.latestTerminal();
    if (!active[this.nativeId] && this.execution && terminal &&
      (terminal.id !== this.execution.beforeIdle || terminal.turnId !== undefined && terminal.turnId === this.execution.turnId)) {
      this.finishTurn(terminal.outcome, terminal.error, terminal.turnId);
    }
    this.applyStatus(!!active[this.nativeId]);
    await this.reconcileInputInvocations();
  }
  private publishUnsupportedForm(form: FormInfo, error: unknown): void {
    const key = `form:${form.id}:unsupported`;
    if (this.supplemental.has(key)) return;
    const observation: ProviderObservation = { type: 'observation', sourceKey: key, occurredAt: Date.now(), delivery: this.initialized ? 'live' : 'history', event: { type: 'timeline', provider: 'opencode', item: { type: 'error', message: `${form.title}: ${error instanceof Error ? error.message : 'This native form cannot be represented.'} Complete this interaction in OpenCode.` } } };
    this.supplemental.set(key, { observation, after: this.timeline.at(-1)?.sourceKey }); this.output.push(observation);
  }
  private orderedMessages(): NativeMessage[] { return [...this.messages.values()]; }
  private publishTimeline(pagedSnapshot = false): void {
    const next = normalize(this.orderedMessages(), this.images, { startsAtBeginning: this.startsAtBeginning, sessionId: this.nativeId });
    for (const item of reconcileTimeline(this.timeline, next, [...this.supplemental.values()], this.initialized, this.olderCursor, pagedSnapshot)) this.output.push(item);
    this.timeline = next;
  }
  private currentUsage() { return usage(this.orderedMessages(), { session: this.nativeSession, contextWindows: this.controls.contextWindows() }); }
  private publishUsage(): void {
    const current = this.currentUsage(); const key = fingerprint(current);
    if (key === this.lastUsage) return;
    this.lastUsage = key; this.emit({ type: 'usage_updated', provider: 'opencode', usage: current }, `usage:${key}`);
  }
  private latestTerminal() {
    const messages = this.orderedMessages();
    let index = messages.length - 1;
    while (index >= 0 && messages[index]!.type !== 'idle') index--;
    const idle = messages[index];
    if (idle?.type !== 'idle') return;
    let error: SessionStructuredError | undefined;
    for (let before = index - 1; before >= 0; before--) {
      const message = messages[before]!;
      if (message.type === 'idle') break;
      if (message.type === 'assistant' && message.error) { error = message.error; break; }
    }
    const current = !messages.slice(index + 1).some(message => message.type === 'user' || message.type === 'assistant');
    return { id: idle.id, outcome: idle.outcome, turnId: turnIds(messages, { startsAtBeginning: this.startsAtBeginning }).get(idle.id), error, current };
  }
  private applyStatus(running: boolean): void {
    if (running) {
      const messages = this.orderedMessages(), latest = messages.at(-1);
      const turnId = latest?.type === 'idle' ? undefined : turnIds(messages, { startsAtBeginning: this.startsAtBeginning }).get(latest?.id ?? '');
      this.activeTurnId = turnId ?? null;
      if (!this.execution) {
        this.execution = { turnId, beforeIdle: this.latestTerminal()?.id };
        this.failure = undefined; this.failureIdleId = undefined;
        this.emit({ type: 'turn_started', provider: 'opencode', turnId });
      } else if (turnId) this.execution.turnId = turnId;
      this.active = true;
    }
    if (!running) { this.active = false; this.activeTurnId = null; }
    this.status = this.pending.size || this.unsupportedForms.size ? 'waiting' : running ? 'running' : this.nativeSession?.outcome === 'failed' ? 'failed' : 'idle';
    if (this.status === 'failed') {
      const terminal = this.latestTerminal();
      if (terminal?.current && terminal.outcome === 'failed') {
        if (this.failureIdleId !== undefined && this.failureIdleId !== terminal.id) this.failure = undefined;
        if (terminal.error) this.failure = { message: nativeError(terminal.error), turnId: terminal.turnId };
        this.failureIdleId = terminal.id;
      } else { this.failure = undefined; this.failureIdleId = undefined; }
    }
    this.emitRuntime();
  }
  private finishTurn(outcome: 'succeeded' | 'failed' | 'interrupted', error?: SessionStructuredError, confirmedTurnId?: string): void {
    if (!this.execution) return;
    const turnId = confirmedTurnId ?? this.execution.turnId;
    this.execution = undefined;
    if (turnId && this.terminalTurns.has(turnId)) return;
    if (turnId) this.terminalTurns.add(turnId);
    if (outcome === 'failed') {
      const message = error ? nativeError(error) : 'OpenCode reported a failed execution without a failure reason.';
      this.failure = { message, turnId }; this.failureIdleId = undefined;
      this.emit({ type: 'turn_failed', provider: 'opencode', turnId, error: message });
    } else if (outcome === 'interrupted') this.emit({ type: 'turn_canceled', provider: 'opencode', turnId, reason: 'OpenCode execution interrupted.' });
    else this.emit({ type: 'turn_completed', provider: 'opencode', turnId, usage: this.currentUsage() });
    this.active = false; this.activeTurnId = null;
    this.status = outcome === 'failed' ? 'failed' : 'idle';
    this.emitRuntime();
  }
  private addInteraction(request: AgentInteractionRequest): void {
    if (fingerprint(this.pending.get(request.requestId) ?? null) === fingerprint(request)) return;
    this.pending.set(request.requestId, request);
    this.emit({ type: 'interaction_requested', provider: 'opencode', request }, `interaction:${request.requestId}:request`); this.emitRuntime();
  }
  private invalidateInteraction(requestId: string, reason: string): void {
    if (this.pending.delete(requestId)) this.emit({ type: 'interaction_invalidated', provider: 'opencode', requestId, reason }, `interaction:${requestId}:invalidated`);
  }
  private resolveInteraction(requestId: string, response: AgentInteractionResponse): void {
    const request = this.pending.get(requestId);
    if (!request || !this.pending.delete(requestId)) return;
    this.supplemental.set(`interaction:${requestId}`, { after: this.timeline.at(-1)?.sourceKey, observation: { type: 'observation', sourceKey: `interaction:${requestId}:receipt`, occurredAt: Date.now(), delivery: 'history', event: { type: 'timeline', provider: 'opencode', item: { type: 'interaction', request, response } } } });
    // Relay creates the live receipt from interaction_resolved; replacements carry it explicitly.
    this.emit({ type: 'interaction_resolved', provider: 'opencode', requestId, response }, `interaction:${requestId}:resolved`);
    this.emitRuntime();
  }
  private emit(event: AgentStreamEvent, key?: string): void {
    this.output.push({ type: 'observation', sourceKey: key ?? `runtime:${this.sequence + 1}`, nativeRevision: ++this.sequence, occurredAt: Date.now(), delivery: 'live', event });
  }
  private info(): AgentRuntimeInfo {
    return { providerId: 'opencode', sessionId: this.nativeId, status: this.status, ...(this.status === 'failed' && this.failure ? { failure: this.failure } : {}), cwd: this.config.cwd, model: this.config.model ?? null, mode: this.config.agent ?? null, planning: { active: this.config.agent !== undefined && this.config.agent === this.controls.planningAgentId('plan') }, settings: this.controls.list(), childSessions: this.children.map(child => ({ ...child })), connection: { ...this.connection }, persistence: { providerId: 'opencode', sessionId: this.nativeId, opaque: JSON.stringify(this.config) } };
  }
  private emitRuntime(): void { this.emit({ type: 'runtime_updated', provider: 'opencode', runtimeInfo: this.info(), activeTurnId: this.activeTurnId && !this.terminalTurns.has(this.activeTurnId) ? this.activeTurnId : null }); }
  async runtimeInfo(options?: { refreshSettings?: boolean }): Promise<AgentRuntimeInfo> {
    if (options?.refreshSettings && !this.closed) {
      this.promptEditEvidence.invalidate();
      const revision = this.controls.revision;
      try {
        const native = await this.transport.request(() => this.transport.client.session.get({ sessionID: this.nativeId }));
        if (!this.closed && this.controls.updateNative(native, revision)) this.nativeSession = native;
      } catch (error) { this.scheduleRefresh(); throw error; }
    }
    return this.info();
  }
  private writable(): void {
    if (this.closed) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode session is closed.');
    if (this.transport.restricted) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode native execution is locked by Host policy.');
    if (this.connection.state !== 'connected') throw new AgentOperationRejectedError('operation_rejected', 'OpenCode is reconnecting. Wait for native state recovery before sending input.');
  }
  async sendMessage(text: string, options?: AgentMessageOptions): Promise<AgentInputAcceptance | void> { return this.sendMessageContent([{ type: 'text', text }], options); }
  async sendMessageContent(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentInputAcceptance | void> {
    return this.admitInput(parts, options);
  }
  async steer(text: string, options?: AgentMessageOptions): Promise<AgentInputAcceptance | void> {
    this.writable();
    if (!this.active) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode has no active turn to steer.');
    return this.admitInput([{ type: 'text', text }], options, true);
  }
  private async admitInput(parts: readonly AgentInputPart[], options?: AgentMessageOptions, requireActive = false): Promise<AgentInputAcceptance | void> {
    this.writable();
    if (this.pendingInput) throw new AgentOperationRejectedError('operation_rejected', 'Wait for the OpenCode turn and pending interactions before sending another message.');
    if (options?.delivery && options.delivery !== 'immediate') throw new AgentOperationRejectedError('operation_rejected', 'OpenCode does not support queued message delivery.');
    if (this.inputInvocations.size >= 512) throw new AgentOperationRejectedError('input_evidence_capacity', 'Unsettled input evidence capacity is full.');
    const messageID = this.messageId();
    const invocation: { input?: NativeInput; accepted?: AgentInputAcceptance; notify?: AgentMessageOptions['onAcceptance'] } = { notify: options?.onAcceptance };
    this.inputInvocations.set(messageID, invocation);
    this.promptEditEvidence.invalidate();
    this.pendingInput = messageID;
    this.pendingInputWhileRunning = this.active;
    let dispatched = false;
    try {
      const nativeParts = await prepareAgentOperation(() => this.images.input(parts));
      this.writable();
      if (this.pendingInput !== messageID) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode input admission changed before dispatch.');
      if (requireActive && !this.active) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode has no active turn to steer.');
      this.pendingInputWhileRunning = this.active;
      invocation.input = structuredClone(nativeParts);
      dispatched = true;
      const accepted = await this.transport.request(() => this.transport.client.session.prompt({ sessionID: this.nativeId, id: messageID, ...nativeParts, delivery: 'steer' }));
      if (accepted.id !== messageID || accepted.sessionID !== this.nativeId || accepted.type !== 'user') throw new Error('OpenCode input acknowledgement identity did not match.');
      if (this.inputInvocations.get(messageID) === invocation) {
        invocation.accepted = { disposition: 'queued' };
        this.inputInvocations.delete(messageID);
        try { invocation.notify?.(invocation.accepted); } catch { /* The caller owns its callback. */ }
      }
      if (this.pendingInputWhileRunning && this.pendingInput === messageID) this.releaseOrdinaryInput();
      await this.reconcileInputInvocations(messageID);
      return invocation.accepted;
    } catch (error) {
      // A lost acknowledgement may have accepted the input. Only native evidence can release it.
      if (!dispatched) { this.inputInvocations.delete(messageID); if (this.pendingInput === messageID) this.releaseOrdinaryInput(); }
      throw error;
    } finally { if (dispatched) this.scheduleRefresh(); }
  }

  private async reconcileInputInvocations(inputID?: string): Promise<void> {
    for (const [id, invocation] of this.inputInvocations) {
      if (inputID !== undefined && id !== inputID) continue;
      if (!invocation.input) continue;
      try {
        const response = await readOpenCodeInputResponse(this.transport, this.nativeId, id, invocation.input, () => !this.closed && this.inputInvocations.get(id) === invocation);
        if (!response) continue;
        invocation.accepted = { disposition: 'started' };
        this.inputInvocations.delete(id);
        // Subscriber failures cannot invalidate native evidence or replay the invocation.
        try { invocation.notify?.(invocation.accepted); } catch { /* The caller owns its callback. */ }
      } catch { /* Unavailable readback leaves the original invocation unresolved. */ }
    }
  }

  private releaseOrdinaryInput(): void { this.promptEditEvidence.invalidate(); this.pendingInput = undefined; }

  private messageId(): string { return `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(10).toString('hex')}`; }
  async cancel(): Promise<void> {
    this.writable();
    this.promptEditEvidence.invalidate();
    const canceledInput = this.pendingInput;
    try {
      await this.transport.request(() => this.transport.client.session.interrupt({ sessionID: this.nativeId }));
      if (this.pendingInput === canceledInput) this.releaseOrdinaryInput();
    } finally { this.scheduleRefresh(); }
  }
  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.writable();
    const request = this.pending.get(requestId);
    if (!request) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode interaction is no longer pending.');
    if (this.submitting.has(requestId)) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode interaction response is already pending.');
    validateInteractionResponse(request, response);
    this.promptEditEvidence.invalidate();
    this.submitting.add(requestId);
    try {
      const form = this.forms.get(requestId);
      if (form) {
        const answer = formAnswer(form, response);
        if (answer === undefined) await this.transport.request(() => this.transport.client.session.form.cancel({ sessionID: this.nativeId, formID: requestId }));
        else await this.transport.request(() => this.transport.client.session.form.reply({ sessionID: this.nativeId, formID: requestId, answer }));
      } else if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
        await this.transport.request(() => this.transport.client.permission.reply({ sessionID: this.nativeId, requestID: requestId, decision: response.decision === 'allow' ? response.scope === 'policy' && response.policyId === 'opencode:save' ? 'always' : 'once' : 'reject' }));
      } else throw new AgentOperationRejectedError('operation_rejected', 'Unsupported OpenCode interaction response.');
      this.resolveInteraction(requestId, response);
    } finally { this.submitting.delete(requestId); this.scheduleRefresh(); }
  }
  async setSessionSetting(id: string, value: string): Promise<void> {
    this.writable();
    this.promptEditEvidence.invalidate();
    try { await this.controls.set(id, value); this.emitRuntime(); } finally { this.scheduleRefresh(); }
  }
  async setPlanning(active: boolean): Promise<void> {
    const agent = this.controls.planningAgentId(active ? 'plan' : 'build');
    if (!agent) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode does not expose the requested planning agent.');
    await this.setSessionSetting('agent', agent);
  }
  async listCommands(): Promise<AgentCommand[]> {
    if (this.closed) throw new Error('OpenCode session is closed.');
    return this.commands.list();
  }
  async executeCommand(id: string, args: string): Promise<{ text?: string }> {
    this.writable();
    if (this.active || this.pending.size || this.pendingInput) throw new AgentOperationRejectedError('operation_rejected', 'Wait for the OpenCode turn and pending interactions before executing a command.');
    const messageID = this.messageId();
    this.promptEditEvidence.invalidate();
    this.pendingInput = messageID;
    this.pendingInputWhileRunning = this.active;
    let dispatched = false;
    try {
      await this.commands.execute(id, args, messageID, () => {
        this.writable();
        if (this.active || this.pending.size || this.pendingInput !== messageID) throw new AgentOperationRejectedError('operation_rejected', 'Wait for the OpenCode turn and pending interactions before executing a command.');
        dispatched = true;
      });
      if (this.pendingInput === messageID) this.releaseOrdinaryInput();
    } catch (error) {
      if (!dispatched && this.pendingInput === messageID) this.releaseOrdinaryInput();
      throw error;
    } finally { if (dispatched) this.scheduleRefresh(); }
    return {};
  }
  async readTimelineHistory(cursor: string): Promise<{ observations: ProviderObservation[]; nextCursor?: string }> {
    if (!cursor || cursor.length > 8192) throw new Error('Invalid OpenCode history cursor.');
    const page = await nativeHistoryPage(this.transport, this.nativeId, cursor);
    return { observations: orderedSnapshot(normalize(page.messages, this.images, { startsAtBeginning: page.startsAtBeginning, sessionId: this.nativeId }), [...this.supplemental.values()].filter(item => item.after !== undefined)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  async readResource(locator: string) { return this.commands.ownsResource(locator) ? this.commands.readResource(locator) : this.images.read(locator); }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.promptEditEvidence.invalidate();
    this.closed = true; this.abort.abort(); clearTimeout(this.refreshTimer);
    this.initialReject(new Error('OpenCode session closed.'));
    await this.stream; await this.queue;
    this.status = 'closed'; this.output.close(); this.images.close(); this.pending.clear(); this.inputInvocations.clear(); this.onClose();
  }
}
