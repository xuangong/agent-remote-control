import {
  PROTOCOL_VERSION,
  type ImageUploadResult,
  type MessagePart,
  type AgentInteractionResponse,
  type AgentMessageOptions,
  type ClientMessage,
  type CommandAcknowledgementMessage,
  type AgentCommand,
  type AgentCommandResult,
  type CommandListResponse,
  type CommandResultResponse,
  type HistoryPage,
  type InteractionResolvedMessage,
  type ResourceBinding,
  type ResourceResolveResponse,
  type ResourceResponse,
  type TimelineCursor,
  type TimelineDirection,
} from '@orchardworks/agent-remote-protocol';

import { uploadImage, checkUploadAborted, type ImageUploadOptions, type ImageUploadRequest } from './image-upload.js';
import type { AgentReplica } from '../replica/store.js';
import type { TimelineReduction } from '../replica/types.js';
import {
  RemoteOperationError,
  type RemoteAgentTransport,
  type RemoteConnection,
  type RemoteServerMessage,
} from './transport.js';

export type RemoteSessionStatus = 'idle' | 'connecting' | 'catching_up' | 'ready' | 'disconnected';

export interface RemoteSessionClientOptions {
  readonly historyPageSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly scheduleReconnect?: (delayMs: number, reconnect: () => void) => () => void;
  readonly requestId?: () => string;
  readonly operationId?: () => string;
}

type RemoteOperationResult = ImageUploadResult | CommandAcknowledgementMessage | InteractionResolvedMessage | ResourceResponse | ResourceResolveResponse | CommandListResponse | CommandResultResponse;

interface PendingOperation {
  readonly matches: (message: RemoteServerMessage) => message is RemoteOperationResult;
  readonly resolve: (message: RemoteOperationResult) => void;
  readonly reject: (error: RemoteOperationError) => void;
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

export class RemoteSessionClient {
  private readonly historyPageSize: number;
  private readonly connectionTimeoutMs: number;
  private connectionDeadline?: ReturnType<typeof setTimeout>;
  private connectionOpen = false;
  private readonly operationTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly scheduleReconnectTask: (delayMs: number, reconnect: () => void) => () => void;
  private readonly createRequestId: () => string;
  private readonly createOperationId: () => string;
  private readonly statusListeners = new Set<(status: RemoteSessionStatus) => void>();
  private readonly pendingOperations = new Map<string, Map<string, PendingOperation>>();
  private connection: RemoteConnection | undefined;
  private unsubscribeDiagnostic: (() => void) | undefined;
  private recovery: AbortController | undefined;
  private olderHistory?: { controller: AbortController; promise: Promise<void> };
  private generation = 0;
  private uploadQueue: Promise<unknown> = Promise.resolve();
  private readonly imageDigests = new Map<string, string>();
  private requestCounter = 0;
  private reconnectAttempt = 0;
  private cancelReconnect: (() => void) | undefined;
  private subscriptionRequestId: string | undefined;
  private currentStatus: RemoteSessionStatus = 'idle';

  constructor(
    private readonly agentId: string,
    private readonly transport: RemoteAgentTransport,
    private readonly replica: AgentReplica,
    options: RemoteSessionClientOptions = {},
  ) {
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 20_000;
    this.historyPageSize = options.historyPageSize ?? 100;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 250;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5_000;
    this.scheduleReconnectTask = options.scheduleReconnect ?? scheduleReconnect;
    this.createRequestId = options.requestId ?? (() => `remote-web-${++this.requestCounter}`);
    this.createOperationId = options.operationId ?? (() => crypto.randomUUID());
  }

  start(): void {
    this.reconnectAttempt = 0;
    this.connect();
  }

  private connect(): void {
    const generation = ++this.generation;
    if (this.connection) {
      this.rejectPendingOperations(
        'connection_disconnected',
        'Remote session connection disconnected.',
        true,
      );
    }
    this.stopConnection();
    this.setStatus('connecting');
    this.armConnectionDeadline(generation);
    this.unsubscribeDiagnostic = this.transport.onDiagnostic((diagnostic) => {
      if (generation !== this.generation) return;
      this.replica.reportDiagnostic(diagnostic.code, diagnostic.message, diagnostic.recoverable);
    });
    this.connection = this.transport.connect(this.agentId, {
      onOpen: () => {
        if (generation !== this.generation) return;
        this.connectionOpen = true;
        this.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
      },
      onMessage: (message) => this.receive(generation, message),
      onDisconnect: () => {
        if (generation !== this.generation) return;
        this.restartDisconnected(generation);
      },
    });
  }

  stop(): void {
    this.generation += 1;
    this.rejectPendingOperations('operation_stopped', 'Remote session client was stopped.', false);
    this.stopConnection();
    this.setStatus('idle');
  }

  subscribeStatus(listener: (status: RemoteSessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  loadOlder(): Promise<void> {
    const state = this.replica.getState().timeline;
    const first = state.entries[0];
    if (!state.initialized || !state.epoch || !state.hasOlder) return Promise.resolve();
    if (this.olderHistory) return this.olderHistory.promise;
    const generation = this.generation;
    const controller = new AbortController();
    const promise = this.transport.fetchTimeline(this.agentId, 'before', { epoch: state.epoch, seq: first?.seqStart ?? 1 }, this.historyPageSize, { signal: controller.signal }).then((page) => {
      if (generation !== this.generation || controller.signal.aborted) return;
      if (page.payload.epoch !== this.replica.getState().timeline.epoch || page.payload.reset || page.payload.staleCursor || page.payload.gap) {
        throw new Error('Earlier activity changed. Retry loading history.');
      }
      if (page.payload.error) throw new Error(page.payload.error);
      const result = this.replica.applyHistory(page);
      if (result.status !== 'applied' && result.status !== 'duplicate') throw new Error('Earlier activity could not be loaded.');
    }).finally(() => {
      if (this.olderHistory?.controller === controller) this.olderHistory = undefined;
    });
    this.olderHistory = { controller, promise };
    return promise;
  }

  sendMessage(text: string, options?: AgentMessageOptions & { operationId?: string }): Promise<CommandAcknowledgementMessage> {
    const operationId = options?.operationId ?? this.createOperationId();
    const outgoingId = this.replica.beginMessage(this.agentId, text, options?.delivery, operationId);
    return this.sendOutgoingMessage(outgoingId, operationId, text, options);
  }

  sendMessageContent(content: readonly MessagePart[], options?: AgentMessageOptions & { operationId?: string; imageDigests?: Readonly<Record<string, string>> }): Promise<CommandAcknowledgementMessage> {
    const parts = content.map(part => ({ ...part }));
    const operationId = options?.operationId ?? this.createOperationId();
    const text = parts.map(part => part.type === 'text' ? part.text : part.label).join('');
    const imageDigests: Record<string, string> = {};
    for (const part of parts) if (part.type === 'image') {
      const digest = options?.imageDigests?.[part.attachmentId] ?? this.imageDigests.get(part.attachmentId);
      if (digest) imageDigests[part.attachmentId] = digest;
    }
    const outgoingId = this.replica.beginMessage(this.agentId, text, options?.delivery, operationId, { content: parts, imageDigests });
    return this.sendOutgoingMessage(outgoingId, operationId, text, options, parts);
  }

  uploadImage(file: Blob, uploadId: string, options: ImageUploadOptions = {}) {
    const generation = this.generation;
    const assertActive = () => {
      checkUploadAborted(options.signal);
      if (generation !== this.generation || this.currentStatus !== 'ready') throw new Error('Image upload paused. Wait for the session to reconnect, then retry.');
    };
    const request = async (input: ImageUploadRequest) => {
      assertActive();
      const requestId = this.createRequestId();
      const { type, ...payload } = input;
      const operation = this.sendOperation<ImageUploadResult>({ protocolVersion: PROTOCOL_VERSION, type,
        payload: { ...payload, requestId, agentId: this.agentId, uploadId } } as Extract<ClientMessage, { type: ImageUploadRequest['type'] }>,
      'image_upload_result', (response): response is ImageUploadResult => response.type === 'image_upload_result' && response.payload.agentId === this.agentId && response.payload.uploadId === uploadId);
      const abort = () => this.rejectPendingOperation(requestId, 'image_upload_result', new RemoteOperationError('upload_paused', 'Image upload paused.', true, requestId));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const result = await operation;
        assertActive();
        return result.payload;
      } finally { options.signal?.removeEventListener('abort', abort); }
    };
    const result = this.uploadQueue.catch(() => undefined).then(async () => {
      assertActive();
      const attachment = await uploadImage(file, uploadId, request, options);
      assertActive();
      this.imageDigests.set(attachment.attachmentId, attachment.sha256);
      return attachment;
    });
    this.uploadQueue = result;
    return result;
  }

  retryMessage(id: string): Promise<CommandAcknowledgementMessage> {
    const state = this.replica.getState();
    const message = state.outgoingMessages?.find(item => item.id === id && item.agentId === this.agentId);
    if (!message || !['failed', 'unconfirmed'].includes(message.status)) return Promise.reject(new Error('This message is not available to retry.'));
    if (!this.connectionOpen) return Promise.reject(new RemoteOperationError('connection_not_ready', 'Wait for the session to reconnect, then retry.', true));
    const operationId = message.status === 'unconfirmed' && !message.retryRequiresNewOperation && message.epoch === state.timeline.epoch && message.operationId
      ? message.operationId : this.createOperationId();
    this.replica.retryMessage(id, operationId);
    return this.sendOutgoingMessage(id, operationId, message.text, { delivery: message.delivery }, message.content);
  }

  deleteMessage(id: string): void {
    const message = this.replica.getState().outgoingMessages?.find(item => item.id === id && item.agentId === this.agentId);
    if (message && ['failed', 'unconfirmed'].includes(message.status)) this.replica.deleteMessage(id);
  }

  private sendOutgoingMessage(outgoingId: string, operationId: string, text: string, options?: AgentMessageOptions, content?: readonly MessagePart[]): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'send_message',
      payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId, ...(content ? { content: [...content] } : { text }),
        ...(options?.delivery === undefined ? {} : { delivery: options.delivery }) },
    } as const;
    // Native compaction can delay acceptance. Connection teardown and native errors
    // still settle the operation; elapsed processing time does not prove failure.
    const operation = this.sendOperation(message, 'command_acknowledged:send_message', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'send_message'
    ), null);
    void operation.then(() => this.replica.updateMessage(outgoingId, 'awaiting_echo'), error => {
      const uncertain = error instanceof RemoteOperationError && [
        'operation_timeout', 'connection_disconnected', 'operation_stopped', 'command_failed', 'operation_outcome_unknown',
      ].includes(error.code);
      const retryRequiresNewOperation = error instanceof RemoteOperationError && ['command_failed', 'operation_outcome_unknown'].includes(error.code);
      this.replica.updateMessage(outgoingId, uncertain ? 'unconfirmed' : 'failed',
        retryRequiresNewOperation ? 'The previous result cannot be recovered. Check the conversation before retrying; Retry starts a new attempt.'
          : uncertain ? 'Delivery is not confirmed. Check the conversation before sending again.'
          : error instanceof Error ? error.message : 'The message could not be sent.', retryRequiresNewOperation);
    });
    return operation;
  }

  steer(text: string, operationId = this.createOperationId()): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'steer',
      payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId, text },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:steer', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'steer'
    ));
  }

  cancel(operationId = this.createOperationId()): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'cancel',
      payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:cancel', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'cancel'
    ));
  }

  setSessionSetting(settingId: string, value: string, operationId = this.createOperationId()): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'set_session_setting',
      payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId, settingId, value },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:set_session_setting', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'set_session_setting'
    ));
  }

  setPlanning(active: boolean, operationId = this.createOperationId()): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'set_planning',
      payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId, active },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:set_planning', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'set_planning'
    ));
  }

  respondToInteraction(requestId: string, response: AgentInteractionResponse, operationId?: string): Promise<CommandAcknowledgementMessage> {
    if (!operationId && !this.replica.getState().pendingInteractions.some((request) => request.requestId === requestId)) {
      return this.observeRejection(Promise.reject(new RemoteOperationError(
        'stale_interaction', 'This interaction is no longer pending.', false, requestId,
      )));
    }
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'interaction_response',
      payload: { agentId: this.agentId, requestId, submissionId: this.createRequestId(), operationId: operationId ?? this.createOperationId(), response },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:interaction_response', (result): result is CommandAcknowledgementMessage => (
      result.type === 'command_acknowledged' && result.payload.command === 'interaction_response'
    ), this.operationTimeoutMs, message.payload.submissionId);
  }

  requestResource(resourceId: string): Promise<ResourceResponse> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'resource_request',
      payload: { requestId: this.createRequestId(), agentId: this.agentId, resourceId },
    } as const;
    return this.sendOperation(message, 'resource_response', (result): result is ResourceResponse => result.type === 'resource_response');
  }

  async resolveResource(locator: string, sourceLocator?: string): Promise<ResourceBinding> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'resource_resolve_request',
      payload: {
        requestId: this.createRequestId(), agentId: this.agentId, locator,
        ...(sourceLocator === undefined ? {} : { sourceLocator }),
      },
    } as const;
    const response = await this.sendOperation(
      message,
      'resource_resolve_response',
      (result): result is ResourceResolveResponse => result.type === 'resource_resolve_response',
    );
    return response.payload.binding;
  }

  async listCommands(): Promise<AgentCommand[]> {
    const response = await this.sendOperation({ protocolVersion: PROTOCOL_VERSION, type: 'list_commands', payload: { requestId: this.createRequestId(), agentId: this.agentId } }, 'command_list', (message): message is CommandListResponse => message.type === 'command_list' && message.payload.agentId === this.agentId);
    return response.payload.commands;
  }

  async executeCommand(commandId: string, args: string, operationId = this.createOperationId()): Promise<AgentCommandResult> {
    // Native commands may wait for user interactions; connection teardown still rejects pending work.
    const response = await this.sendOperation({ protocolVersion: PROTOCOL_VERSION, type: 'execute_command', payload: { requestId: this.createRequestId(), operationId, agentId: this.agentId, commandId, args } }, 'command_result', (message): message is CommandResultResponse => message.type === 'command_result' && message.payload.agentId === this.agentId, null);
    return response.payload.result;
  }

  private receive(generation: number, message: RemoteServerMessage): void {
    if (generation !== this.generation) return;
    switch (message.type) {
      case 'negotiated':
        this.setStatus('catching_up');
        return;
      case 'provider_list':
      case 'agent_session':
      case 'timeline_page':
        return;
      case 'command_acknowledged':
      case 'command_list':
      case 'image_upload_result':
      case 'command_result':
        this.resolvePendingOperation(message.payload.requestId, message);
        return;
      case 'agent_snapshot':
        this.replica.applySnapshot(message);
        this.subscriptionRequestId = this.createRequestId();
        this.send({
          protocolVersion: PROTOCOL_VERSION,
          type: 'timeline_subscription',
          payload: { requestId: this.subscriptionRequestId, agentIds: [this.agentId] },
        });
        return;
      case 'agent_update':
        this.replica.applySnapshot(message);
        return;
      case 'timeline_subscribed':
        if (message.payload.requestId !== this.subscriptionRequestId) return;
        this.catchUpAfterSubscription(generation);
        return;
      case 'timeline_replacement':
        this.replica.replaceTimeline(message.payload.epoch);
        this.retireRecovery();
        void this.fetchTimeline(generation, 'tail');
        return;
      case 'agent_stream':
        this.handleTimelineReduction(generation, this.replica.applyStream(message));
        return;
      case 'interaction_requested':
        this.replica.applyInteractionRequested(message);
        return;
      case 'interaction_resolved':
        this.replica.applyInteractionResolved(message);
        this.resolvePendingOperation(message.payload.requestId, message);
        return;
      case 'interaction_invalidated':
        this.replica.applyInteractionInvalidated(message);
        return;
      case 'resource_response':
        this.replica.applyResource(message);
        this.resolvePendingOperation(message.payload.requestId, message);
        return;
      case 'resource_resolve_response':
        if (message.payload.state) this.replica.applyResource({
          protocolVersion: PROTOCOL_VERSION, type: 'resource_update',
          payload: { agentId: message.payload.agentId, resourceId: message.payload.binding.resourceId, state: message.payload.state },
        });
        this.resolvePendingOperation(message.payload.requestId, message);
        return;
      case 'resource_update':
        this.replica.applyResource(message);
        return;
      case 'timeline_resource_binding_replaced':
        this.replica.replaceTimelineResourceBinding(message);
        return;
      case 'protocol_error':
        this.replica.reportDiagnostic(message.payload.code, message.payload.message, message.payload.recoverable);
        if (message.payload.requestId) {
          this.rejectPendingOperationsForRequestId(message.payload.requestId, new RemoteOperationError(
            message.payload.code, message.payload.message, message.payload.recoverable, message.payload.requestId,
          ));
        }
        return;
    }
  }

  private catchUpAfterSubscription(generation: number): void {
    const timeline = this.replica.getState().timeline;
    if (timeline.initialized && timeline.epoch) {
      void this.fetchTimeline(generation, 'after', { epoch: timeline.epoch, seq: timeline.nextSeq - 1 });
    } else {
      void this.fetchTimeline(generation, 'tail');
    }
  }

  private handleTimelineReduction(generation: number, reduction: TimelineReduction): void {
    if (reduction.status === 'gap') {
      const timeline = reduction.state.timeline;
      if (timeline.epoch) {
        void this.fetchTimeline(generation, 'after', { epoch: timeline.epoch, seq: reduction.expectedSeq - 1 });
      }
    } else if (reduction.status === 'epoch_changed' || reduction.status === 'reset_required') {
      this.retireRecovery();
      void this.fetchTimeline(generation, 'tail');
    }
  }

  private async fetchTimeline(
    generation: number,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
  ): Promise<void> {
    if (generation !== this.generation || this.recovery) return;
    const controller = new AbortController();
    this.recovery = controller;
    this.setStatus('catching_up');
    this.armConnectionDeadline(generation);
    let nextCursor = cursor;
    try {
      while (true) {
        const page = await this.transport.fetchTimeline(
          this.agentId,
          direction,
          nextCursor,
          this.historyPageSize,
          { signal: controller.signal },
        );
        if (generation !== this.generation || this.recovery !== controller) return;
        const continuation = direction === 'after' && page.payload.hasNewer && page.payload.epoch === nextCursor?.epoch
          ? this.afterContinuation(page, nextCursor)
          : undefined;
        const result = this.replica.applyHistory(page);
        if (generation !== this.generation || this.recovery !== controller) return;
        if (result.status !== 'applied' && result.status !== 'duplicate') {
          this.recovery = undefined;
          this.handleTimelineReduction(generation, result);
          return;
        }
        if (!continuation) {
          this.recovery = undefined;
          this.reconnectAttempt = 0;
          clearTimeout(this.connectionDeadline);
          this.connectionDeadline = undefined;
          this.setStatus('ready');
          return;
        }
        nextCursor = continuation;
        this.armConnectionDeadline(generation);
      }
    } catch {
      if (generation !== this.generation || this.recovery !== controller) return;
      this.recovery = undefined;
      this.replica.reportDiagnostic('timeline_recovery_failed', 'Timeline recovery failed.', true);
      this.restartDisconnected(generation);
    }
  }

  private afterContinuation(page: HistoryPage, cursor: TimelineCursor): TimelineCursor {
    const continuation = page.payload.endCursor;
    if (
      !continuation
      || continuation.epoch !== page.payload.epoch
      || continuation.seq <= cursor.seq
    ) throw new Error('Timeline recovery did not advance.');
    return continuation;
  }

  private armConnectionDeadline(generation: number): void {
    clearTimeout(this.connectionDeadline);
    this.connectionDeadline = setTimeout(() => {
      if (generation !== this.generation) return;
      this.replica.reportDiagnostic('connection_timeout', 'Session synchronization timed out. Reconnecting.', true);
      this.restartDisconnected(generation);
    }, this.connectionTimeoutMs);
    if (typeof this.connectionDeadline === 'object') this.connectionDeadline.unref?.();
  }

  private restartDisconnected(generation: number): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.rejectPendingOperations('connection_disconnected', 'Remote session connection disconnected.', true);
    this.stopConnection();
    const nextGeneration = this.generation;
    this.setStatus('disconnected');
    this.scheduleRestart(nextGeneration);
  }

  private scheduleRestart(generation: number): void {
    if (generation !== this.generation || this.cancelReconnect) return;
    const exponent = Math.min(this.reconnectAttempt, 30);
    const delayMs = Math.min(this.reconnectMaxDelayMs, this.reconnectInitialDelayMs * (2 ** exponent));
    this.reconnectAttempt += 1;
    this.cancelReconnect = this.scheduleReconnectTask(delayMs, () => {
      this.cancelReconnect = undefined;
      if (generation === this.generation) this.connect();
    });
  }

  private send(message: ClientMessage): void {
    if (!this.connection) throw new Error('Remote session is not connected.');
    this.connection.send(message);
  }

  private sendOperation<T extends RemoteOperationResult>(
    message: Extract<ClientMessage, { payload: { requestId: string } }>,
    operationType: string,
    matches: (response: RemoteServerMessage) => response is T,
    timeoutMs: number | null = this.operationTimeoutMs,
    correlationId = message.payload.requestId,
  ): Promise<T> {
    const requestId = correlationId;
    if (!this.connectionOpen) return this.observeRejection(Promise.reject(new RemoteOperationError(
      'connection_not_ready', 'Not sent. Wait for the session to reconnect, then retry.', true, requestId,
    )));
    const operations = this.pendingOperations.get(requestId) ?? new Map<string, PendingOperation>();
    if (operations.has(operationType)) {
      return this.observeRejection(Promise.reject(new RemoteOperationError(
        'duplicate_request_id',
        'A matching remote operation is already pending.',
        true,
        requestId,
      )));
    }
    this.pendingOperations.set(requestId, operations);
    const operation = new Promise<T>((resolve, reject) => {
      const generation = this.generation;
      const timeout = timeoutMs === null ? undefined : setTimeout(() => {
        this.rejectPendingOperation(requestId, operationType, new RemoteOperationError(
          'operation_timeout',
          'Remote operation timed out waiting for a relay response.',
          true,
          requestId,
        ));
        this.restartDisconnected(generation);
      }, timeoutMs);
      operations.set(operationType, {
        matches: matches as PendingOperation['matches'],
        resolve: resolve as PendingOperation['resolve'],
        reject,
        timeout,
      });
      try {
        this.send(message);
      } catch {
        this.rejectPendingOperation(requestId, operationType, new RemoteOperationError(
          'operation_send_failed',
          'Remote operation could not be sent.',
          true,
          requestId,
        ));
        this.restartDisconnected(generation);
      }
    });
    return this.observeRejection(operation);
  }

  private resolvePendingOperation(requestId: string, message: RemoteServerMessage): void {
    const operations = this.pendingOperations.get(requestId);
    if (!operations) return;
    for (const [operationType, pending] of operations) {
      if (!pending.matches(message)) continue;
      this.removePendingOperation(requestId, operationType);
      clearTimeout(pending.timeout);
      pending.resolve(message);
    }
  }

  private rejectPendingOperation(requestId: string, operationType: string, error: RemoteOperationError): void {
    const pending = this.pendingOperations.get(requestId)?.get(operationType);
    if (!pending) return;
    this.removePendingOperation(requestId, operationType);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private rejectPendingOperationsForRequestId(requestId: string, error: RemoteOperationError): void {
    for (const operationType of [...(this.pendingOperations.get(requestId)?.keys() ?? [])]) {
      this.rejectPendingOperation(requestId, operationType, error);
    }
  }

  private rejectPendingOperations(code: string, message: string, recoverable: boolean): void {
    for (const requestId of [...this.pendingOperations.keys()]) {
      this.rejectPendingOperationsForRequestId(
        requestId,
        new RemoteOperationError(code, message, recoverable, requestId),
      );
    }
  }

  private removePendingOperation(requestId: string, operationType: string): void {
    const operations = this.pendingOperations.get(requestId);
    if (!operations) return;
    operations.delete(operationType);
    if (operations.size === 0) this.pendingOperations.delete(requestId);
  }

  private observeRejection<T>(operation: Promise<T>): Promise<T> {
    void operation.catch(() => undefined);
    return operation;
  }

  private stopConnection(): void {
    this.connectionOpen = false;
    clearTimeout(this.connectionDeadline);
    this.connectionDeadline = undefined;
    this.olderHistory?.controller.abort();
    this.olderHistory = undefined;
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    this.retireRecovery();
    this.connection?.close();
    this.connection = undefined;
    this.unsubscribeDiagnostic?.();
    this.unsubscribeDiagnostic = undefined;
    this.subscriptionRequestId = undefined;
  }

  private retireRecovery(): void {
    this.recovery?.abort();
    this.recovery = undefined;
  }

  private setStatus(status: RemoteSessionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function scheduleReconnect(delayMs: number, reconnect: () => void): () => void {
  const timeout = setTimeout(reconnect, delayMs);
  return () => clearTimeout(timeout);
}
