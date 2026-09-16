import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, ClientMessage, HistoryPage, ServerMessage, TimelineDirection } from '@agent-remote-controller/agent-remote-protocol';
import { HttpWebSocketTransport, RemoteOperationError, type RemoteAgentTransport, type RemoteConnection, type RemoteProtocolObservation, type RemoteTransportDiagnostic, type RemoteTransportListener } from '@agent-remote-controller/agent-remote-web/headless';

import { DebuggerError } from './errors.js';
import { createDebuggerRuntime, createProtocolTraceRecord } from './runtime.js';

const capabilities = {
  history: true, sendMessage: true, steer: false, cancel: true, readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

function snapshot(status: 'idle' | 'failed' = 'idle'): AgentSnapshot {
  return {
    protocolVersion: '1.4.0', type: 'agent_snapshot',
    payload: {
      id: 'agent-one', providerId: 'provider-one', createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z', status, activeTurn: null, capabilities,
      pendingInteractions: [], runtimeInfo: { providerId: 'provider-one', sessionId: 'session-one', status },
    },
  };
}

function page(): HistoryPage {
  return {
    protocolVersion: '1.4.0', type: 'timeline_page',
    payload: {
      requestId: 'page-one', agentId: 'agent-one', direction: 'tail', epoch: 'epoch-one', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null,
      hasOlder: false, hasNewer: false, entries: [], error: null,
    },
  };
}

function pageWithEntry(text: string): HistoryPage {
  return {
    ...page(),
    payload: {
      ...page().payload,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      startCursor: { epoch: 'epoch-one', seq: 1 }, endCursor: { epoch: 'epoch-one', seq: 1 },
      entries: [{
        providerId: 'provider-one', item: { type: 'assistant_message', text, messageId: 'message-one' },
        timestamp: '2026-09-03T00:00:00.000Z', seqStart: 1, seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
      }],
    },
  };
}

class FakeTransport implements RemoteAgentTransport {
  readonly diagnostics = new Set<(diagnostic: RemoteTransportDiagnostic) => void>();
  readonly observations = new Set<(observation: RemoteProtocolObservation) => void>();
  readonly sent: ClientMessage[] = [];
  snapshot: AgentSnapshot = snapshot();
  listener: RemoteTransportListener | undefined;
  connections = 0;
  closed = 0;
  fast = false;

  fetchSnapshot(_agentId?: string, _options?: { signal?: AbortSignal }): Promise<AgentSnapshot> {
    for (const listener of this.observations) listener({ direction: 'inbound', channel: 'http', message: this.snapshot });
    return Promise.resolve(this.snapshot);
  }

  fetchTimeline(_agentId: string, _direction: TimelineDirection): Promise<HistoryPage> {
    return Promise.resolve(page());
  }

  connect(_agentId: string, listener: RemoteTransportListener): RemoteConnection {
    this.connections += 1;
    this.listener = listener;
    if (this.fast) {
      queueMicrotask(() => {
        this.open();
        this.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
        this.emit(this.snapshot);
        this.emit({
          protocolVersion: '1.4.0', type: 'timeline_subscribed',
          payload: { requestId: this.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
        });
      });
    }
    return {
      send: (message) => {
        this.sent.push(message);
        this.observe({ direction: 'outbound', channel: 'websocket', message });
      },
      close: () => { this.closed += 1; },
    };
  }

  onDiagnostic(listener: (diagnostic: RemoteTransportDiagnostic) => void): () => void {
    this.diagnostics.add(listener);
    return () => this.diagnostics.delete(listener);
  }

  onProtocolMessage(listener: (observation: RemoteProtocolObservation) => void): () => void {
    this.observations.add(listener);
    return () => this.observations.delete(listener);
  }

  open(): void {
    this.listener?.onOpen();
  }

  emit(message: ServerMessage): void {
    this.observe({ direction: 'inbound', channel: 'websocket', message });
    this.listener?.onMessage(message);
  }

  reportDiagnostic(diagnostic: RemoteTransportDiagnostic): void {
    for (const listener of this.diagnostics) listener(diagnostic);
  }

  private observe(observation: RemoteProtocolObservation): void {
    for (const listener of this.observations) listener(observation);
  }
}

async function makeReady(transport: FakeTransport) {
  const runtime = await createDebuggerRuntime('agent-one', { transport });
  const ready = runtime.ready(100);
  transport.open();
  transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
  transport.emit(snapshot());
  transport.emit({
    protocolVersion: '1.4.0', type: 'timeline_subscribed',
    payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
  });
  await ready;
  return runtime;
}

describe('createDebuggerRuntime', () => {
  it('delivers preflight and fast WebSocket observations to the creation-time observer exactly once', async () => {
    const transport = new FakeTransport();
    transport.fast = true;
    const observed: RemoteProtocolObservation[] = [];
    const runtime = await createDebuggerRuntime('agent-one', { transport, protocolObserver: (observation) => observed.push(observation) });
    await Promise.resolve();

    expect(observed.map((observation) => `${observation.channel}:${observation.direction}:${observation.message.type}`)).toEqual([
      'http:inbound:agent_snapshot',
      'websocket:outbound:negotiate',
      'websocket:inbound:negotiated',
      'websocket:inbound:agent_snapshot',
      'websocket:outbound:timeline_subscription',
      'websocket:inbound:timeline_subscribed',
    ]);
    runtime.close();
    for (const listener of transport.observations) listener({ direction: 'inbound', channel: 'http', message: snapshot() });
    expect(observed).toHaveLength(6);
  });

  it('applies the HTTP Snapshot provisionally before negotiating WebSocket readiness', async () => {
    const transport = new FakeTransport();
    const runtime = await createDebuggerRuntime('agent-one', { transport });

    expect(runtime.replica.getState().agent).toEqual(snapshot().payload);
    expect(transport.connections).toBe(1);
    runtime.close();
  });

  it('rejects a typed missing Agent before starting reconnection', async () => {
    const transport = new FakeTransport();
    transport.fetchSnapshot = () => Promise.reject(new RemoteOperationError('agent_not_found', 'Agent was not found.', true));

    await expect(createDebuggerRuntime('agent-one', { transport })).rejects.toMatchObject({ code: 'agent_not_found', exitCode: 4, recoverable: true });
    expect(transport.connections).toBe(0);
  });

  it('cancels a hanging Snapshot preflight through the caller signal', async () => {
    const transport = new FakeTransport();
    const controller = new AbortController();
    let observedAbort = false;
    transport.fetchSnapshot = (_agentId, options) => new Promise<AgentSnapshot>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        observedAbort = true;
        reject(options.signal?.reason);
      }, { once: true });
    });

    const pending = createDebuggerRuntime('agent-one', { transport, signal: controller.signal });
    controller.abort(new DebuggerError(130, 'interrupted', 'Command was interrupted.', true));

    await expect(pending).rejects.toMatchObject({ code: 'interrupted', exitCode: 130 });
    expect(observedAbort).toBe(true);
    expect(transport.connections).toBe(0);
  });

  it('forwards preflight diagnostics before rejecting runtime creation', async () => {
    const transport = new FakeTransport();
    const diagnostics: RemoteTransportDiagnostic[] = [];
    transport.fetchSnapshot = async () => {
      transport.reportDiagnostic({
        source: 'http', code: 'invalid_wire_body',
        message: 'Relay response was rejected by the public protocol.', recoverable: true,
      });
      throw new Error('invalid response');
    };

    await expect(createDebuggerRuntime('agent-one', {
      transport,
      preflightDiagnosticObserver: (diagnostic) => diagnostics.push(diagnostic),
    })).rejects.toMatchObject({ code: 'invalid_wire_body', exitCode: 4 });
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'invalid_wire_body' })]);
  });

  it('classifies a malformed HTTP Snapshot as public protocol validation', async () => {
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('{not-json', { status: 200 }),
    });

    await expect(createDebuggerRuntime('agent-one', { transport })).rejects.toMatchObject({
      code: 'invalid_wire_body',
      exitCode: 4,
      message: 'Relay response was rejected by the public protocol.',
      recoverable: true,
    });
  });

  it('classifies a failed HTTP Snapshot request as a relay connection error', async () => {
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => { throw new Error('connection refused'); },
    });

    await expect(createDebuggerRuntime('agent-one', { transport })).rejects.toMatchObject({
      code: 'relay_connection_failed',
      exitCode: 3,
      message: 'Relay Snapshot preflight failed.',
      recoverable: true,
    });
  });

  it('requires negotiated subscription and Timeline catch-up for ready', async () => {
    const transport = new FakeTransport();
    const runtimePromise = makeReady(transport);

    const runtime = await runtimePromise;
    expect(runtime.replica.getState().timeline).toMatchObject({ initialized: true, epoch: 'epoch-one' });
    runtime.close();
  });

  it('waits for current conditions and gates command waits on later progress', async () => {
    const transport = new FakeTransport();
    const runtime = await makeReady(transport);

    await expect(runtime.waitFor('idle', 50)).resolves.toBeUndefined();
    const checkpoint = runtime.captureProgress();
    const waiting = runtime.waitFor('idle', 100, checkpoint);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    runtime.replica.reportDiagnostic('progress', 'Progress happened.', true);
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.emit({
      protocolVersion: '1.4.0', type: 'agent_stream',
      payload: {
        agentId: 'agent-one', timestamp: '2026-09-03T00:00:02.000Z',
        event: { type: 'turn_started', providerId: 'provider-one', turnId: 'turn-one' },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.emit({
      protocolVersion: '1.4.0', type: 'agent_stream',
      payload: {
        agentId: 'agent-one', timestamp: '2026-09-03T00:00:03.000Z',
        event: { type: 'turn_completed', providerId: 'provider-one', turnId: 'turn-one' },
      },
    });
    await expect(waiting).resolves.toBeUndefined();
    runtime.close();
  });

  it('does not treat Timeline or resource changes as completion of a post-command idle wait', async () => {
    const transport = new FakeTransport();
    const runtime = await makeReady(transport);
    runtime.replica.applyHistory(pageWithEntry('before'));
    const checkpoint = runtime.captureProgress();
    const waiting = runtime.waitFor('idle', 20, checkpoint);

    runtime.replica.applyHistory(pageWithEntry('after'));
    transport.emit({
      protocolVersion: '1.4.0', type: 'resource_response',
      payload: {
        requestId: 'resource-request', agentId: 'agent-one', resourceId: 'resource-one',
        state: { status: 'available', mediaType: 'text/plain', byteLength: 3, sha256: 'digest', contentBase64: 'YWJj' },
      },
    });

    await expect(waiting).rejects.toMatchObject({ code: 'wait_timeout', exitCode: 5 });
    runtime.close();
  });

  it('uses structural progress equality for differently ordered decoded values', async () => {
    const transport = new FakeTransport();
    const runtime = await makeReady(transport);
    const before = runtime.captureProgress();
    const original = snapshot();
    runtime.replica.applySnapshot({
      type: 'agent_snapshot',
      protocolVersion: '1.4.0',
      payload: {
        runtimeInfo: {
          status: original.payload.runtimeInfo.status,
          sessionId: original.payload.runtimeInfo.sessionId,
          providerId: original.payload.runtimeInfo.providerId,
        },
        pendingInteractions: [],
        capabilities: {
          interactions: { toolApproval: true, planApproval: true, question: true },
          readResource: true, cancel: true, steer: false, sendMessage: true, history: true,
        },
        activeTurn: null,
        status: original.payload.status,
        updatedAt: original.payload.updatedAt,
        createdAt: original.payload.createdAt,
        providerId: original.payload.providerId,
        id: original.payload.id,
      },
    });

    expect(runtime.captureProgress()).toEqual(before);
    runtime.replica.reportDiagnostic('nested_change', 'Nested state changed.', true);
    expect(runtime.captureProgress()).not.toEqual(before);
    runtime.close();
  });

  it('checks capabilities after the provisional Snapshot and times out bounded waits', async () => {
    const transport = new FakeTransport();
    const runtime = await createDebuggerRuntime('agent-one', { transport });

    expect(() => runtime.requireCapability('steer')).toThrowError(DebuggerError);
    await expect(runtime.waitFor('interaction', 20)).rejects.toMatchObject({ code: 'wait_timeout', exitCode: 5 });
    runtime.close();
  });

  it('maps an unrecoverable WebSocket transport diagnostic during readiness to a connection error', async () => {
    const transport = new FakeTransport();
    const runtime = await createDebuggerRuntime('agent-one', { transport });
    const readiness = runtime.ready(100);

    transport.reportDiagnostic({ source: 'websocket', code: 'authorization_failed', message: 'Origin was rejected.', recoverable: false });

    await expect(readiness).rejects.toMatchObject({ code: 'authorization_failed', exitCode: 3, recoverable: false });
    runtime.close();
    runtime.close();
    expect(transport.closed).toBe(1);
  });

  it('projects protocol resource bytes into a trace-safe omission marker', () => {
    const record = createProtocolTraceRecord('agent-one', {
      direction: 'inbound', channel: 'websocket', message: {
        protocolVersion: '1.4.0', type: 'resource_response',
        payload: { requestId: 'resource-one', agentId: 'agent-one', resourceId: 'resource-one', state: {
          status: 'available', mediaType: 'text/plain', byteLength: 3, sha256: 'digest', contentBase64: 'YWJj',
        } },
      },
    });

    expect(record).toMatchObject({
      kind: 'protocol', messageType: 'resource_response', requestId: 'resource-one',
      message: { payload: { state: {
        byteLength: 3, sha256: 'digest',
        contentBase64: { omitted: 'resource_content', byteLength: 3, sha256: 'digest' },
      } } },
    });
    expect(JSON.stringify(record)).not.toContain('YWJj');
  });

  it('omits answer values in protocol traces with no request sensitivity metadata', () => {
    const record = createProtocolTraceRecord('agent-one', {
      direction: 'outbound', channel: 'websocket', message: {
        protocolVersion: '1.4.0', type: 'interaction_response',
        payload: { agentId: 'agent-one', requestId: 'secret', response: { kind: 'question', answers: [{ questionId: 'token', selectedValues: [], customText: 'trace-private-token' }] } },
      },
    });
    expect(JSON.stringify(record)).not.toContain('trace-private-token');
    expect(record).toMatchObject({ message: { payload: { response: { answers: [{ questionId: 'token', selectedValues: [], redacted: true }] } } } });
  });
});

it('strips sensitive field defaults from incoming request traces without mutating the transport message', () => {
  const message = {
    protocolVersion: '1.4.0' as const, type: 'interaction_requested' as const,
    payload: { agentId: 'agent-one', request: { kind: 'form' as const, requestId: 'form', title: 'Login', message: '', fields: [
      { type: 'text' as const, fieldId: 'token', label: 'Token', required: true, sensitive: true, defaultValue: 'PRIVATE_TRACE_DEFAULT' },
      { type: 'text' as const, fieldId: 'region', label: 'Region', required: false, defaultValue: 'west' },
    ] } },
  };
  const record = createProtocolTraceRecord('agent-one', { direction: 'inbound', channel: 'websocket', message });
  expect(JSON.stringify(record)).not.toContain('PRIVATE_TRACE_DEFAULT');
  expect(JSON.stringify(record)).toContain('west');
  expect(message.payload.request.fields[0]!.defaultValue).toBe('PRIVATE_TRACE_DEFAULT');
});
