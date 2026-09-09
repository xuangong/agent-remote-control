import type { AgentInteractionResponse, AgentStreamEvent } from '@borgee/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeServerMessage,
  type AgentSnapshot,
  type ClientMessage,
  type HistoryPage,
  type ResourceResponse,
  type ServerMessage,
} from '@borgee/agent-remote-protocol';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { AgentBusyError, UnsupportedAgentCapabilityError, type AgentManagerListener } from './agent-manager.js';
import type { TimelinePageRequest } from './timeline-projector.js';

export interface SessionWireAgent {
  readonly agentId: string;
  snapshot(): AgentSnapshot;
  fetchTimeline(request: TimelinePageRequest): HistoryPage;
  subscribe(listener: AgentManagerListener): () => void;
  sendMessage(text: string): Promise<void>;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  readResource?(requestId: string, resourceId: string): Promise<ResourceResponse>;
}

export interface SessionWire {
  receive(json: string): Promise<void>;
  close(): void;
}

export type SessionWireFailure =
  | { kind: 'manager_event_buffer_overflow'; error: Error }
  | { kind: 'manager_event_delivery'; error: Error };

export interface SessionWireOptions {
  authorize?: (action: 'read_resource') => boolean | Promise<boolean>;
  maxBufferedManagerEvents?: number;
  onFailure?: (failure: SessionWireFailure) => void;
}

export function createSessionWire(
  agentOrResolver: SessionWireAgent | (() => SessionWireAgent),
  send: (json: string) => void,
  options: SessionWireOptions = {},
): SessionWire {
  const maxBufferedManagerEvents = options.maxBufferedManagerEvents ?? 1_024;
  if (!Number.isSafeInteger(maxBufferedManagerEvents) || maxBufferedManagerEvents < 1) {
    throw new RangeError('maxBufferedManagerEvents must be a positive safe integer.');
  }
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
    if (closed) return;
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
        bindAgent();
        if (closed) return;
        const boundAgent = requireBoundAgent();
        const snapshot = boundAgent.snapshot();
        sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated' });
        if (closed) return;
        sendMessage(snapshot);
        if (closed) return;
        negotiated = true;
        drainManagerEvents(queuedDuringSnapshotHandoff);
        bufferingSnapshotHandoff = false;
        return;
      }
      if (message.type === 'negotiate') {
        sendMessage(protocolError('already_negotiated', 'Protocol version has already been negotiated.', true));
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
    const requestId = 'payload' in message && 'requestId' in message.payload ? message.payload.requestId : undefined;
    if ('payload' in message && 'agentId' in message.payload && message.payload.agentId !== boundAgent.agentId) {
      sendMessage(protocolError('agent_identity_mismatch', 'Client message identifies a different Agent.', true, requestId));
      return;
    }
    try {
      switch (message.type) {
        case 'create_agent':
        case 'resume_agent':
          sendMessage(protocolError(
            'invalid_session_command',
            'Agent creation and resume are not valid on an attached Agent session.',
            true,
            message.payload.requestId,
          ));
          return;
        case 'send_message':
          await boundAgent.sendMessage(message.payload.text);
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'send_message'));
          return;
        case 'steer':
          if (!boundAgent.steer) throw new UnsupportedSessionCommandError('steer');
          await boundAgent.steer(message.payload.text);
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'steer'));
          return;
        case 'cancel':
          if (!boundAgent.cancel) throw new UnsupportedSessionCommandError('cancel');
          await boundAgent.cancel();
          sendMessage(commandAcknowledgement(message.payload.requestId, boundAgent.agentId, 'cancel'));
          return;
        case 'set_planning':
          if (!boundAgent.setPlanning) throw new UnsupportedSessionCommandError('set_planning');
          await boundAgent.setPlanning(message.payload.active);
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
          sendMessage(boundAgent.fetchTimeline({
            requestId: message.payload.requestId,
            agentId: message.payload.agentId,
            direction: message.payload.direction,
            ...(message.payload.cursor === undefined ? {} : { cursor: message.payload.cursor }),
            limit: message.payload.limit ?? 100,
          }));
          return;
        case 'interaction_response':
          await boundAgent.respondToInteraction(message.payload.requestId, message.payload.response);
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
          sendMessage(await boundAgent.readResource(message.payload.requestId, message.payload.resourceId));
          return;
      }
    } catch (error) {
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
      sendMessage(protocolError('command_failed', 'Agent command failed.', true, requestId));
    }
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
  command: 'send_message' | 'steer' | 'cancel' | 'set_planning',
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
    case 'agent_stream':
      if (managerEvent.event.type === 'interaction_requested' || managerEvent.event.type === 'interaction_resolved') {
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
  type: 'timeline' | 'interaction_requested' | 'interaction_resolved';
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

class UnsupportedSessionCommandError extends Error {
  constructor(readonly command: string) {
    super(`${command} is not supported.`);
  }
}
