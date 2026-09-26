import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { OperationCacheError } from './operation-cache.js';
import { isSessionMutation } from '@orchardworks/agent-remote-protocol';
import { SessionControlError, type SessionControlRegistry, type SessionControlLease } from './session-control.js';
import type { MessagePart, ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';
import { InputImageError, type ImageUploadDeclaration, type ImageUploadChunk } from './resources/input-image-store.js';
import type { AgentCommandResult, AgentInteractionResponse, AgentMessageOptions, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type AgentCommand,
  type SessionOperationKind,
  decodeClientMessage,
  encodeServerMessage,
  type AgentSnapshot,
  type AgentStatus,
  type TimelineCursor,
  type ClientMessage,
  type HistoryPage,
  type ResourceResponse,
  type ResourceResolveResponse,
  type ServerMessage,
} from '@orchardworks/agent-remote-protocol';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { AgentBusyError, UnsupportedAgentCapabilityError, type AgentManagerListener } from './agent-manager.js';
import type { TimelinePageRequest } from './timeline-projector.js';

export interface SessionWireAgent {
  readonly agentId: string;
  runOperation?<T>(work: () => Promise<T>, beforeDispatch?: () => void): Promise<T>;
  validateOperation?(kind: SessionOperationKind): void;
  snapshot(): AgentSnapshot;
  timelineCursor?(): TimelineCursor;
  fetchTimeline(request: TimelinePageRequest): HistoryPage;
  loadTimeline?(request: TimelinePageRequest): Promise<HistoryPage>;
  subscribe(listener: AgentManagerListener): () => void;
  sendMessage(text: string, options?: AgentMessageOptions): Promise<void>;
  sendMessageContent?(parts: readonly MessagePart[], options?: AgentMessageOptions, scope?: string): Promise<void>;
  validateMessageContent?(parts: readonly MessagePart[], options?: AgentMessageOptions, scope?: string): Promise<void>;
  beginImageUpload?(input: ImageUploadDeclaration, scope?: string): Promise<ImageUploadReceipt>;
  chunkImageUpload?(input: ImageUploadChunk, scope?: string): Promise<ImageUploadReceipt>;
  finishImageUpload?(uploadId: string, scope?: string): Promise<ImageUploadReceipt>;
  validateInteractionResponse?(requestId: string, response: AgentInteractionResponse): Promise<void> | void;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
  readResource?(requestId: string, resourceId: string, scope?: string): Promise<ResourceResponse>;
  resolveResource?(requestId: string, locator: string, sourceLocator?: string, scope?: string): Promise<ResourceResolveResponse>;
}

export interface SessionWire {
  receive(json: string): Promise<void>;
  close(): void;
}

export type SessionWireFailure =
  | { kind: 'manager_event_buffer_overflow'; error: Error }
  | { kind: 'manager_event_delivery'; error: Error };

export interface SessionWireOptions {
  sessionControls?: SessionControlRegistry;
  imageScope?: () => string;
  authorize?: (action: 'read_resource' | 'resolve_resource' | 'image_upload' | 'send_message') => boolean | Promise<boolean>;
  executeOperation?: SessionWireOperationExecutor;
  maxBufferedManagerEvents?: number;
  onFailure?: (failure: SessionWireFailure) => void;
}

export interface SessionWireOperation {
  readonly operationId: string;
  readonly kind: 'send_message' | 'steer' | 'cancel' | 'set_planning' | 'set_session_setting' | 'interaction_response' | 'execute_command';
  readonly parameters: unknown;
  readonly maximumResultBytes: number;
}

export interface SessionWireOperationWork<T> {
  readonly validate?: () => Promise<void> | void;
  /** Synchronous, side-effect-free admission; may run again after queued preparation. */
  readonly beforeDispatch?: () => void;
  readonly dispatch: () => Promise<T>;
}

export interface SessionWireOperationExecutor {
  <T>(agent: SessionWireAgent, operation: SessionWireOperation, work: SessionWireOperationWork<T>): Promise<T>;
}

export function createSessionWire(
  agentOrResolver: SessionWireAgent | (() => SessionWireAgent),
  send: (json: string) => void,
  options: SessionWireOptions = {},
): SessionWire {
  const maxBufferedManagerEvents = options.maxBufferedManagerEvents ?? 1_024;
  const runOperation: SessionWireOperationExecutor = options.executeOperation
    ?? (async () => { throw new OperationCacheError('operation_settlement_unavailable', 'This session requires a runtime-owned operation settlement service.'); });
  if (!Number.isSafeInteger(maxBufferedManagerEvents) || maxBufferedManagerEvents < 1) {
    throw new RangeError('maxBufferedManagerEvents must be a positive safe integer.');
  }
  let control: SessionControlLease | undefined;
  let activityOnly = false;
  let lastActivity: AgentStatus | undefined;
  let negotiated = false;
  let closed = false;
  let agent: SessionWireAgent | undefined;
  let unsubscribe: (() => void) | undefined;
  let bufferingSnapshotHandoff = false;
  let timelineSubscribed = false;
  let acknowledgingTimelineSubscription = false;
  const queuedDuringSnapshotHandoff: AgentManagerEvent[] = [];
  const queuedDuringSubscriptionAck: AgentManagerEvent[] = [];

  const receiveManagerEvent = (event: AgentManagerEvent): void => {
    if (closed || (activityOnly && event.type !== 'agent_state')) return;
    if (bufferingSnapshotHandoff) {
      enqueueManagerEvent(queuedDuringSnapshotHandoff, event);
      return;
    }
    if (acknowledgingTimelineSubscription && isTimelineDelivery(event)) {
      enqueueManagerEvent(queuedDuringSubscriptionAck, event);
      return;
    }
    sendManagerEvent(event);
  };

  function sendMessage(message: ServerMessage): void {
    const encoded = encodeServerMessage(message);
    if (encoded.status === 'rejected') {
      throw new Error(`Relay produced an invalid server message: ${encoded.issues.map(({ message: issue }) => issue).join(' ')}`);
    }
    send(encoded.json);
  }

  function sendManagerEvent(event: AgentManagerEvent): void {
    try {
      if (activityOnly) {
        if (event.type === 'agent_state') sendActivity(event.snapshot, event.cursor);
        return;
      }
      const message = managerEventToServerMessage(event, timelineSubscribed);
      if (message) sendMessage(message);
    } catch (error) {
      failSession({
        kind: 'manager_event_delivery',
        error: error instanceof Error ? error : new Error('Agent manager event delivery failed.'),
      });
    }
  }

  return {
    async receive(json: string): Promise<void> {
      if (closed) return;
      const decoded = decodeClientMessage(json);
      if (decoded.status === 'rejected') {
        const issue = decoded.issues[0];
        sendMessage(protocolError(
          issue?.code ?? 'invalid_shape',
          issue?.message ?? 'Client message was rejected.',
          negotiated,
        ));
        return;
      }
      const message = decoded.value;
      if (!negotiated) {
        if (message.type !== 'negotiate') {
          sendMessage(protocolError('negotiation_required', 'Protocol negotiation must be the first message.', false));
          return;
        }
        activityOnly = message.observation === 'activity';
        bindAgent();
        if (closed) return;
        const boundAgent = requireBoundAgent();
        const snapshot = boundAgent.snapshot();
        const cursor = activityOnly ? boundAgent.timelineCursor?.() : undefined;
        sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', ...(options.sessionControls ? { sessionControl: true as const } : {}) });
        if (!activityOnly && options.sessionControls) {
          control = snapshot.payload.capabilities.sessionControl === 'shared'
            ? options.sessionControls.attachShared(boundAgent.agentId)
            : options.sessionControls.attach(boundAgent.agentId, state => {
              if (!closed) {
                try { sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: state }); }
                catch (error) { failSession({ kind: 'manager_event_delivery', error: error instanceof Error ? error : new Error('Control state delivery failed.') }); }
              }
            });
        }
        if (closed) return;
        if (activityOnly) sendActivity(snapshot, cursor);
        else sendMessage(snapshot);
        if (closed) return;
        negotiated = true;
        if (control) sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: control.state() });
        drainManagerEvents(queuedDuringSnapshotHandoff);
        bufferingSnapshotHandoff = false;
        return;
      }
      if (message.type === 'negotiate') {
        sendMessage(protocolError('already_negotiated', 'Protocol version has already been negotiated.', true));
        return;
      }
      if (activityOnly) {
        sendMessage(protocolError('activity_only', 'This connection observes activity only. Open the session to use content and controls.', false));
        return;
      }
      await handleClientMessage(message);
    },
    close(): void {
      closeSession();
    },
  };

  async function handleClientMessage(message: Exclude<ClientMessage, { type: 'negotiate' }>): Promise<void> {
    const boundAgent = requireBoundAgent();
    const requestId = message.type === 'interaction_response' ? message.payload.submissionId
      : 'payload' in message && 'requestId' in message.payload ? message.payload.requestId : undefined;
    if ('payload' in message && 'agentId' in message.payload && message.payload.agentId !== boundAgent.agentId) {
      sendMessage(protocolError('agent_identity_mismatch', 'Client message identifies a different Agent.', true, requestId));
      return;
    }
    const assertControl = () => { if (isSessionMutation(message)) control?.assert(message.controlToken); };
    const executeOperation: SessionWireOperationExecutor = async (agent, operation, work) => {
      assertControl();
      if (options.authorize && !await options.authorize('send_message')) {
        throw new OperationCacheError('forbidden', 'This connection cannot mutate the session.');
      }
      assertControl();
      return runOperation(agent, operation, {
      ...work,
      beforeDispatch: () => { assertControl(); agent.validateOperation?.(message.type === 'send_message' && message.payload.delivery === 'next_turn' ? 'queue_message' : operation.kind); work.beforeDispatch?.(); },
      dispatch: () => { assertControl(); return work.dispatch(); },
      });
    };
    try {
      assertControl();
      switch (message.type) {
        case 'session_control_request': {
          if (options.authorize && !await options.authorize('send_message')) {
            sendMessage(protocolError('forbidden', 'This connection may observe but cannot control the session.', true, requestId));
            return;
          }
          if (!control) throw new SessionControlError('session_control_unavailable', 'Session control requires an updated Controller.');
          const state = control.request(message.payload.action, message.payload.revision, message.payload.resumeToken, message.payload.retainOnDisconnect, message.payload.clientKind);
          sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { ...state, requestId: message.payload.requestId } });
          return;
        }
        case 'list_commands': {
          if (!boundAgent.listCommands) throw new UnsupportedSessionCommandError('list_commands');
          const commands = await boundAgent.listCommands();
          sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'command_list', payload: { requestId: message.payload.requestId, agentId: boundAgent.agentId, commands } });
          return;
        }
        case 'execute_command': {
          if (!boundAgent.executeCommand) throw new UnsupportedSessionCommandError('execute_command');
          const result = await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'execute_command',
            parameters: { commandId: message.payload.commandId, args: message.payload.args }, maximumResultBytes: 256 * 1024,
          }, { dispatch: () => boundAgent.executeCommand!(message.payload.commandId, message.payload.args) });
          sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'command_result', payload: { requestId: message.payload.requestId, agentId: boundAgent.agentId, result } });
          return;
        }
        case 'create_agent':
        case 'resume_agent':
          sendMessage(protocolError(
            'invalid_session_command',
            'Agent creation and resume are not valid on an attached Agent session.',
            true,
            message.payload.requestId,
          ));
          return;
        case 'image_upload_begin':
        case 'image_upload_chunk':
        case 'image_upload_finish': {
          if (options.authorize && !await options.authorize('image_upload')) {
            sendMessage(protocolError('forbidden', 'Image uploads are not permitted for this session.', true, requestId));
            return;
          }
          const snapshot = boundAgent.snapshot();
          if (!snapshot.payload.capabilities.sendMessage || !snapshot.payload.capabilities.imageInput) throw new UnsupportedSessionCommandError('image_upload');
          const scope = options.imageScope?.();
          assertControl();
          let receipt: ImageUploadReceipt;
          if (message.type === 'image_upload_begin' && boundAgent.beginImageUpload) receipt = await boundAgent.beginImageUpload(message.payload, scope);
          else if (message.type === 'image_upload_chunk' && boundAgent.chunkImageUpload) receipt = await boundAgent.chunkImageUpload(message.payload, scope);
          else if (message.type === 'image_upload_finish' && boundAgent.finishImageUpload) receipt = await boundAgent.finishImageUpload(message.payload.uploadId, scope);
          else throw new UnsupportedSessionCommandError('image_upload');
          sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'image_upload_result', payload: { requestId: message.payload.requestId, agentId: boundAgent.agentId, ...receipt } });
          return;
        }
        case 'send_message': {
          const payload = message.payload;
          if ('content' in payload && options.authorize && !await options.authorize('send_message')) {
            sendMessage(protocolError('forbidden', 'Image messages are not permitted for this session.', true, requestId));
            return;
          }
          if ('content' in payload && !boundAgent.sendMessageContent) throw new UnsupportedSessionCommandError('send_message_content');
          const delivery = payload.delivery === undefined ? undefined : { delivery: payload.delivery };
          const imageScope = 'content' in payload ? options.imageScope?.() : undefined;
          await executeOperation(boundAgent, {
            operationId: payload.operationId, kind: 'send_message',
            parameters: { ...('content' in payload ? { content: payload.content } : { text: payload.text }), delivery: payload.delivery ?? null }, maximumResultBytes: 1_024,
          }, { validate: async () => {
            if ('content' in payload) {
              try { await boundAgent.validateMessageContent?.(payload.content, delivery, imageScope); }
              catch (error) {
                if (error instanceof InputImageError) throw Object.assign(new Error(error.message), { code: 'invalid_image_input' });
                throw error;
              }
            }
          }, dispatch: async () => {
            if ('content' in payload) await boundAgent.sendMessageContent!(payload.content, delivery, imageScope);
            else if (delivery === undefined) await boundAgent.sendMessage(payload.text);
            else await boundAgent.sendMessage(payload.text, delivery);
            return { accepted: true };
          } });
          sendMessage(commandAcknowledgement(payload.requestId, boundAgent.agentId, 'send_message'));
          return;
        }
        case 'steer':
          if (!boundAgent.steer) throw new UnsupportedSessionCommandError('steer');
          await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'steer', parameters: { text: message.payload.text }, maximumResultBytes: 1_024,
          }, { dispatch: async () => { await boundAgent.steer!(message.payload.text); return { accepted: true }; } });
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'steer'));
          return;
        case 'cancel':
          if (!boundAgent.cancel) throw new UnsupportedSessionCommandError('cancel');
          await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'cancel', parameters: {}, maximumResultBytes: 1_024,
          }, { dispatch: async () => { await boundAgent.cancel!(); return { accepted: true }; } });
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'cancel'));
          return;
        case 'set_session_setting':
          if (!boundAgent.setSessionSetting) throw new UnsupportedSessionCommandError('set_session_setting');
          await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'set_session_setting',
            parameters: { settingId: message.payload.settingId, value: message.payload.value }, maximumResultBytes: 1_024,
          }, { dispatch: async () => { await boundAgent.setSessionSetting!(message.payload.settingId, message.payload.value); return { accepted: true }; } });
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'set_session_setting'));
          return;
        case 'set_planning':
          if (!boundAgent.setPlanning) throw new UnsupportedSessionCommandError('set_planning');
          await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'set_planning', parameters: { active: message.payload.active }, maximumResultBytes: 1_024,
          }, { dispatch: async () => { await boundAgent.setPlanning!(message.payload.active); return { accepted: true }; } });
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'set_planning'));
          return;
        case 'timeline_subscription': {
          acknowledgingTimelineSubscription = true;
          const subscribedAgentIds = message.payload.agentIds.includes(boundAgent.agentId) ? [boundAgent.agentId] : [];
          try {
            sendMessage({
              protocolVersion: PROTOCOL_VERSION,
              type: 'timeline_subscribed',
              payload: { requestId: message.payload.requestId, agentIds: subscribedAgentIds },
            });
          } finally {
            acknowledgingTimelineSubscription = false;
          }
          if (closed) return;
          timelineSubscribed = subscribedAgentIds.length === 1;
          drainManagerEvents(queuedDuringSubscriptionAck);
          return;
        }
        case 'timeline_request':
          sendMessage(await (boundAgent.loadTimeline?.bind(boundAgent) ?? boundAgent.fetchTimeline.bind(boundAgent))({
            requestId: message.payload.requestId,
            agentId: message.payload.agentId,
            direction: message.payload.direction,
            ...(message.payload.cursor === undefined ? {} : { cursor: message.payload.cursor }),
            limit: message.payload.limit ?? 100,
          }));
          return;
        case 'interaction_response':
          await executeOperation(boundAgent, {
            operationId: message.payload.operationId, kind: 'interaction_response',
            parameters: { requestId: message.payload.requestId, response: message.payload.response }, maximumResultBytes: 1_024,
          }, {
            validate: boundAgent.validateInteractionResponse
              ? () => boundAgent.validateInteractionResponse!(message.payload.requestId, message.payload.response)
              : undefined,
            dispatch: async () => {
              await boundAgent.respondToInteraction(message.payload.requestId, message.payload.response);
              return { accepted: true };
            },
          });
          sendMessage(commandAcknowledgement(message.payload.submissionId, boundAgent.agentId, 'interaction_response'));
          return;
        case 'resource_request':
          if (options.authorize && !await options.authorize('read_resource')) {
            sendMessage(protocolError(
              'forbidden',
              'The authenticated principal is not authorized to read this resource.',
              true,
              message.payload.requestId,
            ));
            return;
          }
          if (!boundAgent.readResource) throw new UnsupportedSessionCommandError('resource_request');
          sendMessage(await boundAgent.readResource(message.payload.requestId, message.payload.resourceId, ...(options.imageScope ? [options.imageScope()] : [])));
          return;
        case 'resource_resolve_request':
          if (options.authorize && !await options.authorize('resolve_resource')) {
            sendMessage(protocolError(
              'forbidden',
              'The authenticated principal is not authorized to resolve local resources.',
              true,
              message.payload.requestId,
            ));
            return;
          }
          if (!boundAgent.resolveResource) throw new UnsupportedSessionCommandError('resource_resolve_request');
          sendMessage(await boundAgent.resolveResource(
            message.payload.requestId,
            message.payload.locator,
            message.payload.sourceLocator,
            ...(options.imageScope ? [options.imageScope()] : []),
          ));
          return;
      }
    } catch (error) {
      if (error instanceof SessionControlError) {
        sendMessage(protocolError(error.code, error.message, true, requestId));
        return;
      }
      if (error instanceof AgentBusyError) {
        sendMessage(protocolError('agent_busy', error.message, true, requestId));
        return;
      }
      if (error instanceof UnsupportedSessionCommandError || error instanceof UnsupportedAgentCapabilityError) {
        const command = error instanceof UnsupportedAgentCapabilityError ? error.capability : error.command;
        sendMessage(protocolError('unsupported_command', `${command} is not supported by this Agent.`, true, requestId));
        return;
      }
      if (isInteractionResponseError(error)) {
        sendMessage(protocolError(error.code, error.message, true, requestId));
        return;
      }
      if (error instanceof OperationCacheError || error instanceof AgentOperationRejectedError || isOperationExecutionError(error)) {
        sendMessage(protocolError(error.code, error.message, ['operation_capacity_exceeded', 'unsupported_command', 'agent_busy'].includes(error.code), requestId));
        return;
      }
      const imageOperation = message.type.startsWith('image_upload_') || (message.type === 'send_message' && 'content' in message.payload);
      sendMessage(protocolError('command_failed', imageOperation && error instanceof InputImageError ? error.message : 'Agent command failed.', true, requestId));
    }
  }

  function sendActivity(snapshot: AgentSnapshot, cursor?: TimelineCursor): void {
    const agent = snapshot.payload;
    const status = agent.status === 'closed' || agent.status === 'failed' ? agent.status
      : agent.pendingInteractions.length || agent.status === 'waiting' ? 'waiting'
      : agent.activeTurn || agent.status === 'running' ? 'running' : agent.status;
    if (lastActivity === status) return;
    lastActivity = status;
    sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId: agent.id, status, ...(cursor ? { cursor } : {}) } });
  }

  function bindAgent(): void {
    if (agent) return;
    const resolved = typeof agentOrResolver === 'function' ? agentOrResolver() : agentOrResolver;
    agent = resolved;
    bufferingSnapshotHandoff = true;
    const release = resolved.subscribe(receiveManagerEvent);
    if (closed) {
      release();
      return;
    }
    unsubscribe = release;
  }

  function requireBoundAgent(): SessionWireAgent {
    if (!agent) throw new Error('Agent session is not bound.');
    return agent;
  }

  function enqueueManagerEvent(queue: AgentManagerEvent[], event: AgentManagerEvent): void {
    if (queue.length >= maxBufferedManagerEvents) {
      failSession({
        kind: 'manager_event_buffer_overflow',
        error: new Error('Agent manager event buffer overflowed.'),
      });
      return;
    }
    queue.push(event);
  }

  function drainManagerEvents(queue: AgentManagerEvent[]): void {
    while (!closed && queue.length > 0) {
      sendManagerEvent(queue.shift() as AgentManagerEvent);
    }
  }

  function failSession(failure: SessionWireFailure): void {
    if (closed) return;
    closeSession();
    try {
      options.onFailure?.(failure);
    } catch {
      // A failure observer cannot restore the closed session.
    }
  }

  function closeSession(): void {
    control?.close();
    if (closed) return;
    closed = true;
    const release = unsubscribe;
    unsubscribe = undefined;
    release?.();
    queuedDuringSnapshotHandoff.length = 0;
    queuedDuringSubscriptionAck.length = 0;
  }
}

function commandAcknowledgement(
  requestId: string,
  agentId: string,
  command: 'send_message' | 'steer' | 'cancel' | 'set_planning' | 'set_session_setting' | 'interaction_response',
): Extract<ServerMessage, { type: 'command_acknowledged' }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'command_acknowledged',
    payload: { requestId, agentId, command },
  };
}

function managerEventToServerMessage(
  managerEvent: AgentManagerEvent,
  timelineSubscribed: boolean,
): ServerMessage | undefined {
  switch (managerEvent.type) {
    case 'agent_state':
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'agent_update',
        payload: structuredClone(managerEvent.snapshot.payload),
      };
    case 'timeline_replacement':
      return timelineSubscribed ? {
        protocolVersion: PROTOCOL_VERSION,
        type: 'timeline_replacement',
        payload: { agentId: managerEvent.agentId, epoch: managerEvent.epoch },
      } : undefined;
    case 'timeline_resource_binding_replaced':
      return timelineSubscribed ? {
        protocolVersion: PROTOCOL_VERSION,
        type: 'timeline_resource_binding_replaced',
        payload: {
          agentId: managerEvent.agentId,
          epoch: managerEvent.epoch,
          seq: managerEvent.seq,
          previous: structuredClone(managerEvent.previous),
          replacement: structuredClone(managerEvent.replacement),
        },
      } : undefined;
    case 'resource_update':
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'resource_update',
        payload: {
          agentId: managerEvent.agentId,
          resourceId: managerEvent.resourceId,
          state: structuredClone(managerEvent.state),
        },
      };
    case 'interaction_requested':
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'interaction_requested',
        payload: { agentId: managerEvent.agentId, request: structuredClone(managerEvent.request) },
      };
    case 'interaction_resolved':
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'interaction_resolved',
        payload: {
          agentId: managerEvent.agentId,
          requestId: managerEvent.requestId,
          response: structuredClone(managerEvent.response),
        },
      };
    case 'interaction_invalidated':
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'interaction_invalidated',
        payload: {
          agentId: managerEvent.agentId,
          requestId: managerEvent.requestId,
          reason: managerEvent.reason,
          ...(managerEvent.turnId === undefined ? {} : { turnId: managerEvent.turnId }),
        },
      };
    case 'agent_stream':
      if (
        managerEvent.event.type === 'interaction_requested'
        || managerEvent.event.type === 'interaction_resolved'
        || managerEvent.event.type === 'interaction_invalidated'
      ) {
        return undefined;
      }
      if (managerEvent.event.type === 'timeline') {
        if (!timelineSubscribed || !managerEvent.row) return undefined;
        return {
          protocolVersion: PROTOCOL_VERSION,
          type: 'agent_stream',
          payload: {
            agentId: managerEvent.agentId,
            epoch: managerEvent.row.epoch,
            seq: managerEvent.row.seq,
            timestamp: managerEvent.row.timestamp,
            event: publicTimelineEvent(managerEvent.event, managerEvent.row.resources),
          },
        };
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'agent_stream',
        payload: {
          agentId: managerEvent.agentId,
          timestamp: managerEvent.timestamp,
          event: publicStateEvent(managerEvent.event),
        },
      };
  }
}

function publicTimelineEvent(
  event: Extract<AgentStreamEvent, { type: 'timeline' }>,
  resources: NonNullable<Extract<AgentManagerEvent, { type: 'agent_stream' }>['row']>['resources'],
) {
  return {
    type: 'timeline' as const,
    providerId: event.provider,
    item: structuredClone(event.item),
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    resources: structuredClone(resources),
  };
}

function publicStateEvent(event: Exclude<AgentStreamEvent, {
  type: 'timeline' | 'interaction_requested' | 'interaction_resolved' | 'interaction_invalidated';
}>) {
  const { provider, ...payload } = event;
  return { ...structuredClone(payload), providerId: provider };
}

function protocolError(
  code: string,
  message: string,
  recoverable: boolean,
  requestId?: string,
): Extract<ServerMessage, { type: 'protocol_error' }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'protocol_error',
    payload: {
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message,
      recoverable,
    },
  };
}

function isTimelineDelivery(event: AgentManagerEvent): boolean {
  return event.type === 'timeline_replacement'
    || event.type === 'timeline_resource_binding_replaced'
    || (event.type === 'agent_stream' && event.event.type === 'timeline');
}

function isInteractionResponseError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'stale_interaction' || error.code === 'invalid_interaction_response');
}

function isOperationExecutionError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && ['invalid_operation_id', 'invalid_operation_intent', 'operation_cache_closed', 'operation_capacity_exceeded',
      'session_read_only', 'operation_conflict', 'operation_outcome_unknown', 'operation_rejected', 'operation_result_too_large', 'invalid_image_input'].includes(error.code);
}

class UnsupportedSessionCommandError extends Error {
  constructor(readonly command: string) {
    super(`${command} is not supported.`);
  }
}
