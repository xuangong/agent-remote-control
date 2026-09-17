import {
  PROTOCOL_VERSION,
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
} from '@agent-remote-controller/agent-remote-protocol';

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
  readonly operationTimeoutMs?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly scheduleReconnect?: (delayMs: number, reconnect: () => void) => () => void;
  readonly requestId?: () => string;
}

type RemoteOperationResult = CommandAcknowledgementMessage | InteractionResolvedMessage | ResourceResponse | ResourceResolveResponse | CommandListResponse | CommandResultResponse;

interface PendingOperation {
  readonly matches: (message: RemoteServerMessage) => message is RemoteOperationResult;
  readonly resolve: (message: RemoteOperationResult) => void;
  readonly reject: (error: RemoteOperationError) => void;
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

export class RemoteSessionClient {
  private readonly historyPageSize: number;
  private readonly operationTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly scheduleReconnectTask: (delayMs: number, reconnect: () => void) => () => void;
  private readonly createRequestId: () => string;
  private readonly statusListeners = new Set<(status: RemoteSessionStatus) => void>();
  private readonly pendingOperations = new Map<string, Map<string, PendingOperation>>();
  private connection: RemoteConnection | undefined;
  private unsubscribeDiagnostic: (() => void) | undefined;
  private recovery: AbortController | undefined;
  private olderHistory?: { controller: AbortController; promise: Promise<void> };
  private generation = 0;
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
    this.historyPageSize = options.historyPageSize ?? 100;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 250;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5_000;
    this.scheduleReconnectTask = options.scheduleReconnect ?? scheduleReconnect;
    this.createRequestId = options.requestId ?? (() => `remote-web-${++this.requestCounter}`);
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
    this.unsubscribeDiagnostic = this.transport.onDiagnostic((diagnostic) => {
      if (generation !== this.generation) return;
      this.replica.reportDiagnostic(diagnostic.code, diagnostic.message, diagnostic.recoverable);
    });
    this.connection = this.transport.connect(this.agentId, {
      onOpen: () => {
        if (generation !== this.generation) return;
        this.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
      },
      onMessage: (message) => this.receive(generation, message),
      onDisconnect: () => {
        if (generation !== this.generation) return;
        this.rejectPendingOperations('connection_disconnected', 'Remote session connection disconnected.', true);
        this.setStatus('disconnected');
        this.scheduleRestart(generation);
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
    if (!state.initialized || !state.epoch || !first || !state.hasOlder) return Promise.resolve();
    if (this.olderHistory) return this.olderHistory.promise;
    const generation = this.generation;
    const controller = new AbortController();
    const promise = this.transport.fetchTimeline(this.agentId, 'before', { epoch: state.epoch, seq: first.seqStart }, this.historyPageSize, { signal: controller.signal }).then((page) => {
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

  sendMessage(text: string, options?: AgentMessageOptions): Promise<CommandAcknowledgementMessage> {
    const outgoingId = this.replica.beginMessage(this.agentId, text, options?.delivery);
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'send_message',
      payload: { requestId: this.createRequestId(), agentId: this.agentId, text, ...(options?.delivery === undefined ? {} : { delivery: options.delivery }) },
    } as const;
    const operation = this.sendOperation(message, 'command_acknowledged:send_message', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'send_message'
    ));
    void operation.then(() => this.replica.updateMessage(outgoingId, 'awaiting_echo'), error => {
      const uncertain = error instanceof RemoteOperationError && [
        'operation_timeout', 'connection_disconnected', 'operation_stopped', 'operation_send_failed', 'command_failed',
      ].includes(error.code);
      this.replica.updateMessage(outgoingId, uncertain ? 'unconfirmed' : 'failed',
        uncertain ? 'Delivery is not confirmed. Check the conversation before sending again.'
          : error instanceof Error ? error.message : 'The message could not be sent.');
    });
    return operation;
  }

  steer(text: string): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'steer',
      payload: { requestId: this.createRequestId(), agentId: this.agentId, text },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:steer', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'steer'
    ));
  }

  cancel(): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'cancel',
      payload: { requestId: this.createRequestId(), agentId: this.agentId },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:cancel', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'cancel'
    ));
  }

  setSessionSetting(settingId: string, value: string): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'set_session_setting',
      payload: { requestId: this.createRequestId(), agentId: this.agentId, settingId, value },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:set_session_setting', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'set_session_setting'
    ));
  }

  setPlanning(active: boolean): Promise<CommandAcknowledgementMessage> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'set_planning',
      payload: { requestId: this.createRequestId(), agentId: this.agentId, active },
    } as const;
    return this.sendOperation(message, 'command_acknowledged:set_planning', (response): response is CommandAcknowledgementMessage => (
      response.type === 'command_acknowledged' && response.payload.command === 'set_planning'
    ));
  }

  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<InteractionResolvedMessage> {
    if (!this.replica.getState().pendingInteractions.some((request) => request.requestId === requestId)) {
      return this.observeRejection(Promise.reject(new RemoteOperationError(
        'stale_interaction', 'This interaction is no longer pending.', false, requestId,
      )));
    }
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'interaction_response',
      payload: { agentId: this.agentId, requestId, response },
    } as const;
    return this.sendOperation(message, 'interaction_resolved', (result): result is InteractionResolvedMessage => (
      result.type === 'interaction_resolved'
    ));
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

  async executeCommand(commandId: string, args: string): Promise<AgentCommandResult> {
    // Native commands may wait for user interactions; connection teardown still rejects pending work.
    const response = await this.sendOperation({ protocolVersion: PROTOCOL_VERSION, type: 'execute_command', payload: { requestId: this.createRequestId(), agentId: this.agentId, commandId, args } }, 'command_result', (message): message is CommandResultResponse => message.type === 'command_result' && message.payload.agentId === this.agentId, null);
    return response.payload.result;
  }

  private receive(generation: number, message: RemoteServerMessage): void {
    if (generation !== this.generation) return;
    switch (message.type) {
      case 'negotiated':
      case 'provider_list':
      case 'agent_session':
      case 'timeline_page':
        return;
      case 'command_acknowledged':
      case 'command_list':
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
        this.rejectPendingOperationsForRequestId(message.payload.requestId, new RemoteOperationError(
          'interaction_invalidated',
          'This interaction is no longer available.',
          false,
          message.payload.requestId,
        ));
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
          this.setStatus('ready');
          return;
        }
        nextCursor = continuation;
      }
    } catch {
      if (generation !== this.generation || this.recovery !== controller) return;
      this.recovery = undefined;
      this.replica.reportDiagnostic('timeline_recovery_failed', 'Timeline recovery failed.', true);
      this.setStatus('disconnected');
      this.scheduleRestart(generation);
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
  ): Promise<T> {
    const { requestId } = message.payload;
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
      const timeout = timeoutMs === null ? undefined : setTimeout(() => {
        this.rejectPendingOperation(requestId, operationType, new RemoteOperationError(
          'operation_timeout',
          'Remote operation timed out waiting for a relay response.',
          true,
          requestId,
        ));
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
