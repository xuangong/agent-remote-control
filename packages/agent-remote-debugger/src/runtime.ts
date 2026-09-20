import WebSocket from 'ws';
import type { AgentCapabilities, ClientMessage, ServerMessage } from '@agent-remote-controller/agent-remote-protocol';
import {
  AgentReplica,
  HttpWebSocketTransport,
  RemoteOperationError,
  RemoteSessionClient,
  type RemoteAgentTransport,
  type RemoteProtocolObservation,
  type RemoteSessionStatus,
  type RemoteTransportDiagnostic,
  type WebSocketLike,
} from '@agent-remote-controller/agent-remote-web/headless';

import { DebuggerError, remoteOperationFailure } from './errors.js';
import { resolveOrigin, resolveRelayUrl } from './input.js';
import { stableJsonValue } from './structural.js';
import { redactDebuggerValue } from './redaction.js';

export type WaitCondition = 'idle' | 'interaction' | 'failed';
export type CapabilityName = Exclude<keyof AgentCapabilities, 'interactions'> | `interactions.${keyof AgentCapabilities['interactions']}`;

export interface ProgressCheckpoint {
  readonly value: string;
  readonly turnStarts: number;
  readonly turnCompletions: number;
  readonly turnActive: boolean;
}

export interface DebuggerRuntimeOptions {
  readonly relayUrl?: string;
  readonly origin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly webSocketFactory?: (url: string) => WebSocketLike;
  readonly transport?: RemoteAgentTransport;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly protocolObserver?: (observation: RemoteProtocolObservation) => void;
  readonly preflightDiagnosticObserver?: (diagnostic: RemoteTransportDiagnostic) => void;
}

export interface DebuggerRuntime {
  readonly relayUrl: string;
  readonly origin: string;
  readonly transport: RemoteAgentTransport;
  readonly replica: AgentReplica;
  readonly client: RemoteSessionClient;
  ready(timeoutMs: number): Promise<void>;
  waitFor(condition: WaitCondition, timeoutMs: number, after?: ProgressCheckpoint): Promise<void>;
  captureProgress(): ProgressCheckpoint;
  requireCapability(capability: CapabilityName): void;
  close(): void;
}

export type ProtocolTraceRecord = {
  schemaVersion: '1.1.0';
  timestamp: string;
  agentId: string;
  kind: 'protocol';
  direction: 'inbound' | 'outbound';
  channel: 'http' | 'websocket';
  messageType: ClientMessage['type'] | ServerMessage['type'];
  requestId?: string;
  message: unknown;
};

export async function createDebuggerRuntime(agentId: string, options: DebuggerRuntimeOptions = {}): Promise<DebuggerRuntime> {
  const environment = options.environment ?? process.env;
  const relayUrl = resolveRelayUrl(options.relayUrl, environment);
  const origin = resolveOrigin(options.origin, environment);
  const readinessFailures = new Set<(error: DebuggerError) => void>();
  let terminalConnectionError: DebuggerError | undefined;
  const reportTerminalConnectionFailure = (error: DebuggerError) => {
    terminalConnectionError = error;
    for (const fail of readinessFailures) fail(error);
  };
  const transport = options.transport ?? new HttpWebSocketTransport(relayUrl, {
    fetch: options.fetch,
    webSocketFactory: observeWebSocketFactory(
      options.webSocketFactory ?? createNodeWebSocketFactory(origin),
      reportTerminalConnectionFailure,
    ),
  });
  const replica = new AgentReplica();
  const unsubscribeCreationObserver = options.protocolObserver
    ? transport.onProtocolMessage(options.protocolObserver)
    : undefined;
  let preflightProtocolDiagnostic: RemoteTransportDiagnostic | undefined;
  const unsubscribePreflightDiagnostic = transport.onDiagnostic((diagnostic) => {
    if (isPublicProtocolValidationDiagnostic(diagnostic)) preflightProtocolDiagnostic = diagnostic;
    try {
      options.preflightDiagnosticObserver?.(diagnostic);
    } catch {
      // Trace presentation cannot change runtime preflight classification.
    }
  });
  try {
    replica.applySnapshot(await transport.fetchSnapshot(agentId, { signal: options.signal }));
  } catch (error) {
    unsubscribeCreationObserver?.();
    if (options.signal?.aborted && options.signal.reason instanceof DebuggerError) {
      throw options.signal.reason;
    }
    throw debuggerPreflightError(error, preflightProtocolDiagnostic);
  } finally {
    unsubscribePreflightDiagnostic();
  }
  const client = new RemoteSessionClient(agentId, transport, replica, { operationTimeoutMs: options.operationTimeoutMs });
  let status: RemoteSessionStatus = 'idle';
  let closed = false;
  const cancelWaits = new Set<() => void>();
  const unsubscribeTerminalDiagnostic = transport.onDiagnostic((diagnostic) => {
    if (diagnostic.source !== 'websocket' || diagnostic.recoverable) return;
    reportTerminalConnectionFailure(new DebuggerError(3, diagnostic.code, diagnostic.message, false));
  });
  const unsubscribeStatus = client.subscribeStatus((next) => { status = next; });
  let turnActive = isTurnActive(replica);
  let turnStarts = 0;
  let turnCompletions = 0;
  const unsubscribeTurnProgress = replica.subscribe(() => {
    const active = isTurnActive(replica);
    if (!turnActive && active) turnStarts += 1;
    if (turnActive && !active) turnCompletions += 1;
    turnActive = active;
  });
  client.start();

  const wait = (condition: WaitCondition, timeoutMs: number, after?: ProgressCheckpoint): Promise<void> => new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: DebuggerError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      cancelWaits.delete(cancel);
      if (error) reject(error); else resolve();
    };
    let observedRequiredTurn = after?.turnActive ?? false;
    const check = () => {
      if (condition === 'idle' && after) {
        if (turnStarts > after.turnStarts) observedRequiredTurn = true;
        if (!observedRequiredTurn || turnCompletions <= after.turnCompletions) return;
        if (conditionSatisfied(replica, condition)) finish();
        return;
      }
      if (after && after.value === progressValue(replica)) return;
      if (conditionSatisfied(replica, condition)) finish();
    };
    const timer = setTimeout(() => finish(new DebuggerError(5, 'wait_timeout', 'Timed out waiting for the requested condition.', true)), timeoutMs);
    const cancel = () => finish(new DebuggerError(3, 'runtime_closed', 'Debugger runtime was closed.', true));
    unsubscribe = replica.subscribe(check);
    cancelWaits.add(cancel);
    check();
  });

  const closeRuntime = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', closeRuntime);
    for (const cancel of [...cancelWaits]) cancel();
    unsubscribeCreationObserver?.();
    unsubscribeTerminalDiagnostic();
    unsubscribeStatus();
    unsubscribeTurnProgress();
    client.stop();
  };
  options.signal?.addEventListener('abort', closeRuntime, { once: true });
  if (options.signal?.aborted) closeRuntime();

  return {
    relayUrl,
    origin,
    transport,
    replica,
    client,
    ready: (timeoutMs) => waitForReady(client, () => status, () => terminalConnectionError, timeoutMs, cancelWaits, readinessFailures),
    waitFor: wait,
    captureProgress: () => ({ value: progressValue(replica), turnStarts, turnCompletions, turnActive }),
    requireCapability: (capability) => requireCapability(replica, capability),
    close: closeRuntime,
  };
}

export function createProtocolTraceRecord(agentId: string, observation: RemoteProtocolObservation): ProtocolTraceRecord {
  const requestId = requestIdOf(observation.message);
  return {
    schemaVersion: '1.1.0',
    timestamp: new Date().toISOString(),
    agentId,
    kind: 'protocol',
    direction: observation.direction,
    channel: observation.channel,
    messageType: observation.message.type,
    ...(requestId ? { requestId } : {}),
    message: redactDebuggerValue(traceSafeMessage(observation.message)),
  };
}

function createNodeWebSocketFactory(origin: string): (url: string) => WebSocketLike {
  return (url) => new WebSocket(url, { origin }) as unknown as WebSocketLike;
}

function observeWebSocketFactory(
  factory: (url: string) => WebSocketLike,
  reportTerminalConnectionFailure: (error: DebuggerError) => void,
): (url: string) => WebSocketLike {
  return (url) => {
    const socket = factory(url);
    let opened = false;
    let reported = false;
    const report = () => {
      if (reported || opened) return;
      reported = true;
      reportTerminalConnectionFailure(new DebuggerError(
        3,
        'websocket_connection_failed',
        'Remote WebSocket connection could not be established.',
        true,
      ));
    };
    return new Proxy(socket, {
      set(target, property, value) {
        if (property === 'onopen') {
          target.onopen = (event) => {
            opened = true;
            if (typeof value === 'function') value(event);
          };
          return true;
        }
        if (property === 'onclose') {
          target.onclose = (event) => {
            report();
            if (typeof value === 'function') value(event);
          };
          return true;
        }
        return Reflect.set(target, property, value);
      },
    });
  };
}

function debuggerPreflightError(error: unknown, protocolDiagnostic?: RemoteTransportDiagnostic): DebuggerError {
  if (error instanceof RemoteOperationError) {
    return remoteOperationFailure(error);
  }
  if (protocolDiagnostic) {
    return new DebuggerError(4, protocolDiagnostic.code, protocolDiagnostic.message, protocolDiagnostic.recoverable);
  }
  return new DebuggerError(3, 'relay_connection_failed', 'Relay Snapshot preflight failed.', true);
}

function isPublicProtocolValidationDiagnostic(diagnostic: RemoteTransportDiagnostic): boolean {
  return diagnostic.source === 'http' && diagnostic.code === 'invalid_wire_body';
}

function waitForReady(
  client: RemoteSessionClient,
  currentStatus: () => RemoteSessionStatus,
  terminalFailure: () => DebuggerError | undefined,
  timeoutMs: number,
  cancelWaits: Set<() => void>,
  readinessFailures: Set<(error: DebuggerError) => void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: DebuggerError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      cancelWaits.delete(cancel);
      readinessFailures.delete(failTerminal);
      if (error) reject(error); else resolve();
    };
    const check = (status: RemoteSessionStatus) => {
      const failure = terminalFailure();
      if (failure) return finish(failure);
      if (status === 'ready') finish();
    };
    const timer = setTimeout(() => finish(new DebuggerError(5, 'ready_timeout', 'Timed out waiting for remote readiness.', true)), timeoutMs);
    const cancel = () => finish(new DebuggerError(3, 'runtime_closed', 'Debugger runtime was closed.', true));
    const failTerminal = (error: DebuggerError) => finish(error);
    cancelWaits.add(cancel);
    readinessFailures.add(failTerminal);
    const subscription = client.subscribeStatus(check);
    unsubscribe = subscription;
    if (settled) unsubscribe();
    check(currentStatus());
  });
}

function requireCapability(replica: AgentReplica, capability: CapabilityName): void {
  const agent = replica.getState().agent;
  if (!agent) throw new DebuggerError(4, 'agent_snapshot_missing', 'Agent Snapshot is unavailable.', true);
  const supported = capability.startsWith('interactions.')
    ? agent.capabilities.interactions[capability.slice('interactions.'.length) as keyof AgentCapabilities['interactions']]
    : agent.capabilities[capability as Exclude<keyof AgentCapabilities, 'interactions'>];
  if (!supported) {
    throw new DebuggerError(4, 'capability_unsupported', `Agent does not support capability ${capability}.`, false);
  }
}

function conditionSatisfied(replica: AgentReplica, condition: WaitCondition): boolean {
  const state = replica.getState();
  if (condition === 'interaction') return state.pendingInteractions.length > 0;
  return state.agent?.status === condition;
}

function isTurnActive(replica: AgentReplica): boolean {
  const agent = replica.getState().agent;
  return agent !== null && (agent.activeTurn !== null || agent.status === 'running' || agent.status === 'waiting');
}

function progressValue(replica: AgentReplica): string {
  const state = replica.getState();
  return stableJsonValue({
    agentUpdatedAt: state.agent?.updatedAt,
    agentStatus: state.agent?.status,
    epoch: state.timeline.epoch,
    nextSeq: state.timeline.nextSeq,
    timelineEntries: state.timeline.entries,
    pendingInteractions: state.pendingInteractions,
    resources: state.resources,
    diagnostics: state.diagnostics,
  });
}

function requestIdOf(message: RemoteProtocolObservation['message']): string | undefined {
  if (!('payload' in message) || !message.payload || typeof message.payload !== 'object') return undefined;
  const requestId = (message.payload as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}

function traceSafeMessage(message: RemoteProtocolObservation['message']): unknown {
  if (message.type !== 'resource_response' || message.payload.state.status !== 'available') return message;
  const { contentBase64: _contentBase64, byteLength, sha256, ...state } = message.payload.state;
  return {
    ...message,
    payload: {
      ...message.payload,
      state: { ...state, byteLength, sha256, contentBase64: { omitted: 'resource_content', byteLength, sha256 } },
    },
  };
}
