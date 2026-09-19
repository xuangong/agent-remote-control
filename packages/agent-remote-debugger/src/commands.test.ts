import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentSnapshot, ClientMessage, HistoryPage, ServerMessage, TimelineDirection } from '@agent-remote-controller/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteOperationError, type RemoteAgentTransport, type RemoteConnection, type RemoteProtocolObservation, type RemoteTransportDiagnostic, type RemoteTransportListener } from '@agent-remote-controller/agent-remote-web/headless';

import type { DebuggerRuntime } from './runtime.js';

import { runCli, type CliEnvironment } from './cli.js';

const protocolVersion = '1.5.0' as const;

function agentSnapshot(capabilities = fullCapabilities): AgentSnapshot {
  return {
    protocolVersion, type: 'agent_snapshot',
    payload: {
      id: 'agent-one', providerId: 'provider-one', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:01.000Z',
      status: 'idle', activeTurn: null, capabilities, pendingInteractions: [],
      runtimeInfo: { providerId: 'provider-one', sessionId: 'provider-session-one', status: 'idle' },
    },
  };
}

const fullCapabilities = {
  history: true, sendMessage: true, steer: true, cancel: true, readResource: true,
  planning: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

function historyPage(entries: HistoryPage['payload']['entries'] = []): HistoryPage {
  return {
    protocolVersion, type: 'timeline_page',
    payload: {
      requestId: 'history-one', agentId: 'agent-one', direction: 'tail', epoch: 'epoch-one', reset: false, staleCursor: false, gap: false,
      window: { minSeq: entries.length ? 1 : 0, maxSeq: entries.length, nextSeq: entries.length + 1 },
      startCursor: entries.length ? { epoch: 'epoch-one', seq: 1 } : null,
      endCursor: entries.length ? { epoch: 'epoch-one', seq: entries.length } : null,
      hasOlder: false, hasNewer: false, entries, error: null,
    },
  };
}

const timelineEntry: HistoryPage['payload']['entries'][number] = {
  providerId: 'provider-one', item: { type: 'assistant_message', messageId: 'message-one', text: 'hello from agent' },
  timestamp: '2026-09-03T00:00:02.000Z', seqStart: 1, seqEnd: 1,
  sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
};
const laterTimelineEntry: HistoryPage['payload']['entries'][number] = {
  ...timelineEntry,
  item: { type: 'assistant_message', messageId: 'message-two', text: 'later agent message' },
  seqStart: 2, seqEnd: 2, sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }],
};

class FakeTransport implements RemoteAgentTransport {
  readonly diagnostics = new Set<(diagnostic: RemoteTransportDiagnostic) => void>();
  readonly observations = new Set<(observation: RemoteProtocolObservation) => void>();
  readonly sent: ClientMessage[] = [];
  snapshot = agentSnapshot();
  responseKindMismatch = false;
  resourceRemainsPending = false;
  resourceStopsRespondingAfterFirst = false;
  resourceTerminal: 'available' | 'failed' | 'unavailable' = 'available';
  resourceSha256 = createHash('sha256').update('hello').digest('hex');
  historyHasOlder = false;
  olderLoads = 0;
  timelineEntries: HistoryPage['payload']['entries'] = [timelineEntry];
  diagnosticOnConnect = false;
  traceResource = false;
  resourceAttempts = 0;
  withholdCommandAcknowledgement = false;
  closedConnections = 0;
  listener: RemoteTransportListener | undefined;

  fetchSnapshot(): Promise<AgentSnapshot> {
    this.observe({ direction: 'inbound', channel: 'http', message: this.snapshot });
    return Promise.resolve(this.snapshot);
  }

  fetchTimeline(_agentId: string, direction: TimelineDirection): Promise<HistoryPage> {
    if (direction === 'before') this.olderLoads += 1;
    const page = historyPage(this.timelineEntries);
    const response = direction === 'before'
      ? { ...page, payload: { ...page.payload, direction: 'before', hasOlder: false } }
      : this.historyHasOlder
        ? { ...page, payload: { ...page.payload, hasOlder: true } }
        : page;
    this.observe({ direction: 'inbound', channel: 'http', message: response });
    return Promise.resolve(response);
  }

  connect(_agentId: string, listener: RemoteTransportListener): RemoteConnection {
    this.listener = listener;
    queueMicrotask(() => {
      listener.onOpen();
      if (this.diagnosticOnConnect) {
        for (const report of this.diagnostics) report({ source: 'websocket', code: 'invalid_wire_body', message: 'Wire body was invalid.', recoverable: true });
      }
      this.emit({ protocolVersion, type: 'negotiated' });
      this.emit(this.snapshot);
      if (this.traceResource) {
        this.emit({ protocolVersion, type: 'resource_response', payload: {
          requestId: 'trace-resource', agentId: 'agent-one', resourceId: 'resource-one',
          state: { status: 'available', mediaType: 'text/plain', byteLength: 5, sha256: 'digest', contentBase64: 'aGVsbG8=' },
        } });
      }
    });
    return {
      send: (message) => this.handleSend(message),
      close: () => { this.closedConnections += 1; },
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

  private handleSend(message: ClientMessage): void {
    this.sent.push(message);
    this.observe({ direction: 'outbound', channel: 'websocket', message });
    if (message.type === 'timeline_subscription') {
      this.emit({ protocolVersion, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: ['agent-one'] } });
    }
    if (!this.withholdCommandAcknowledgement && (message.type === 'send_message' || message.type === 'steer' || message.type === 'cancel' || message.type === 'set_planning')) {
      this.emit({
        protocolVersion, type: 'command_acknowledged',
        payload: { requestId: message.payload.requestId, agentId: 'agent-one', command: this.responseKindMismatch ? 'cancel' : message.type },
      });
    }
    if (message.type === 'interaction_response') {
      this.emit({ protocolVersion, type: 'command_acknowledged', payload: {
        agentId: 'agent-one', requestId: message.payload.submissionId, command: 'interaction_response',
      } });
      this.emit({ protocolVersion, type: 'interaction_resolved', payload: { agentId: 'agent-one', requestId: message.payload.requestId, response: message.payload.response } });
    }
    if (message.type === 'resource_request') {
      this.resourceAttempts += 1;
      if (this.resourceStopsRespondingAfterFirst && this.resourceAttempts > 1) return;
      const state = this.resourceAttempts === 1 || this.resourceRemainsPending
        ? { status: 'pending' as const, retryAfterMs: 1 }
        : this.resourceTerminal === 'failed'
          ? { status: 'failed' as const, message: 'Resource failed.', retryable: false }
          : this.resourceTerminal === 'unavailable'
            ? { status: 'unavailable' as const, reason: 'Resource unavailable.' }
            : { status: 'available' as const, mediaType: 'text/plain', byteLength: 5, sha256: this.resourceSha256, contentBase64: 'aGVsbG8=' };
      this.emit({ protocolVersion, type: 'resource_response', payload: { requestId: message.payload.requestId, agentId: 'agent-one', resourceId: message.payload.resourceId, state } });
    }
  }

  emit(message: ServerMessage): void {
    this.observe({ direction: 'inbound', channel: 'websocket', message });
    this.listener?.onMessage(message);
  }

  private observe(observation: RemoteProtocolObservation): void {
    for (const listener of this.observations) listener(observation);
  }
}

function harness(transport = new FakeTransport()) {
  let stdout = '';
  let stderr = '';
  let stdinValue = '{"providerId":"provider-one","sessionId":"provider-session-one","opaque":"opaque"}';
  const environmentVariables: Record<string, string | undefined> = { BORGEE_REMOTE_URL: 'http://relay.example' };
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  let sigint: (() => void) | undefined;
  const runtimeOptions: Array<Record<string, unknown>> = [];
  const httpRelayUrls: string[] = [];
  const environment: CliEnvironment = {
    environment: environmentVariables,
    createRuntime: async (agentId, options) => {
      runtimeOptions.push(options as Record<string, unknown>);
      const { createDebuggerRuntime } = await import('./runtime.js');
      return createDebuggerRuntime(agentId, { ...options, transport, operationTimeoutMs: 30 });
    },
    createHttpTransport: (relayUrl) => {
      httpRelayUrls.push(relayUrl);
      return ({
      listProviders: async () => [{ providerId: 'provider-one', displayName: 'Provider One' }],
      createAgent: async (agentId, providerId, config) => ({ protocolVersion, type: 'agent_session' as const, payload: { requestId: 'create-one', agentId, providerId, sessionId: config.sessionId } }),
      resumeAgent: async (agentId, persistence) => ({ protocolVersion, type: 'agent_session' as const, payload: { requestId: 'resume-one', agentId, providerId: persistence.providerId, sessionId: persistence.sessionId, persistence } }),
      onDiagnostic: () => () => undefined,
    });
    },
    writeFile: async (path, bytes) => { writes.push({ path, bytes }); },
    subscribeSigint: (listener) => { sigint = listener; return () => { sigint = undefined; }; },
  };
  const io = {
    stdin: async () => stdinValue,
    readFile: async () => '{"kind":"question","answers":[]}',
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    stdoutBytes: (value: Uint8Array) => { writes.push({ path: '-', bytes: value }); },
  };
  return {
    transport, environment, io, writes,
    stdout: () => stdout, stderr: () => stderr,
    setStdin: (value: string) => { stdinValue = value; },
    setEnvironment: (value: Record<string, string | undefined>) => {
      for (const key of Object.keys(environmentVariables)) delete environmentVariables[key];
      Object.assign(environmentVariables, value);
    },
    interrupt: () => sigint?.(),
    runtimeOptions: () => runtimeOptions, httpRelayUrls: () => httpRelayUrls,
  };
}

function json(output: string): unknown {
  return JSON.parse(output.trim().split('\n').at(-1) ?? '');
}

describe('bdb command surface', () => {
  it('submits typed forms using their capability without printing private answers', async () => {
    const h = harness();
    h.transport.snapshot.payload.capabilities = { ...h.transport.snapshot.payload.capabilities, interactions: { ...h.transport.snapshot.payload.capabilities.interactions, form: true, question: false } };
    h.transport.snapshot.payload.pendingInteractions = [{ kind: 'form', requestId: 'form-one', title: 'Login', message: '', fields: [{ type: 'text', fieldId: 'token', label: 'Token', required: true, sensitive: true }] }];
    h.setStdin('{"kind":"form","action":"submit","values":{"token":"cli-private-token"}}');
    expect(await runCli(['interaction', 'respond', 'agent-one', 'form-one', '--response-file', '-', '--json'], h.io, h.environment)).toBe(0);
    expect(h.transport.sent).toContainEqual(expect.objectContaining({ type: 'interaction_response', payload: expect.objectContaining({ response: { kind: 'form', action: 'submit', values: { token: 'cli-private-token' } } }) }));
    expect(h.stdout()).not.toContain('cli-private-token');
  });

  it('submits planning controls through the shared client and rejects missing capability', async () => {
    const h = harness();
    expect(await runCli(['planning', 'agent-one', 'on', '--json'], h.io, h.environment)).toBe(0);
    expect(h.transport.sent).toContainEqual(expect.objectContaining({ type: 'set_planning', payload: expect.objectContaining({ agentId: 'agent-one', active: true }) }));
    expect(json(h.stdout())).toMatchObject({ type: 'command_acknowledged', payload: { command: 'set_planning' } });
    h.transport.snapshot.payload.capabilities.planning = false;
    const sent = h.transport.sent.length;
    expect(await runCli(['planning', 'agent-one', 'off', '--json'], h.io, h.environment)).toBe(4);
    expect(h.transport.sent.slice(sent).some((message) => message.type === 'set_planning')).toBe(false);
  });

  it('passes an explicit planning preference when creating a session', async () => {
    const h = harness();
    const configs: unknown[] = [];
    const createTransport = h.environment.createHttpTransport!;
    const environment: CliEnvironment = { ...h.environment, createHttpTransport: (url) => {
      const transport = createTransport(url);
      return { ...transport, async createAgent(agentId, providerId, config, options) {
        configs.push(config);
        return transport.createAgent(agentId, providerId, config, options);
      } };
    } };
    expect(await runCli(['session', 'create', 'agent-one', '--provider', 'provider-one', '--planning', 'on'], h.io, environment)).toBe(0);
    expect(configs).toEqual([{ sessionId: 'agent-one', planning: true }]);
    expect(await runCli(['session', 'create', 'agent-one', '--provider', 'provider-one', '--planning', 'maybe'], h.io, environment)).toBe(2);
    expect(configs).toHaveLength(1);
  });

  it('uses the default Relay and runs provider and session HTTP commands', async () => {
    const h = harness();

    expect(await runCli(['provider', 'list', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout())).toEqual([{ providerId: 'provider-one', displayName: 'Provider One' }]);

    expect(await runCli(['session', 'create', 'agent-one', '--provider', 'provider-one', '--cwd', '/work', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout()).payload).toMatchObject({ agentId: 'agent-one', sessionId: 'agent-one' });

    expect(await runCli(['session', 'resume', 'agent-one', '--persistence-file', '-', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout()).payload).toMatchObject({ providerId: 'provider-one', sessionId: 'provider-session-one' });
  });

  it('reconstructs inspect and timeline state and uses replica subscriptions for follow output', async () => {
    const h = harness();

    expect(await runCli(['inspect', 'agent-one', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout())).toMatchObject({ agent: { id: 'agent-one' }, timeline: { epoch: 'epoch-one' } });

    expect(await runCli(['timeline', 'agent-one', '--tail', '1', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout())).toMatchObject({ epoch: 'epoch-one', entries: [expect.objectContaining({ seqStart: 1 })] });

    expect(await runCli(['timeline', 'agent-one', '--tail', '0', '--json'], h.io, h.environment)).toBe(2);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'invalid_number' } });

    expect(await runCli(['timeline', 'agent-one', '--until', 'idle', '--json'], h.io, h.environment)).toBe(2);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'option_not_supported' } });

    expect(await runCli(['timeline', 'agent-one', '--follow', '--until', 'idle', '--jsonl'], h.io, h.environment)).toBe(0);
    expect(h.stdout().trim().split('\n').map(json)).toContainEqual(expect.objectContaining({ kind: 'timeline_upsert' }));

    h.transport.historyHasOlder = true;
    expect(await runCli(['timeline', 'agent-one', '--all', '--json'], h.io, h.environment)).toBe(0);
    expect(h.transport.olderLoads).toBe(1);

    const tailed = harness();
    tailed.transport.timelineEntries = [timelineEntry, laterTimelineEntry];
    expect(await runCli(['timeline', 'agent-one', '--tail', '1', '--follow', '--until', 'idle', '--jsonl'], tailed.io, tailed.environment)).toBe(0);
    const initialEntries = tailed.stdout().trim().split('\n').map(json).filter((record) => record.kind === 'timeline_upsert');
    expect(initialEntries).toEqual([expect.objectContaining({ entry: expect.objectContaining({ seqStart: 2 }) })]);
  });

  it('acknowledges agent commands, waits on later progress, and checks capabilities after ready', async () => {
    const h = harness();

    expect(await runCli(['send', 'agent-one', 'hello', '--wait', 'idle', '--timeout', '5', '--json'], h.io, h.environment)).toBe(5);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'command_timeout' } });

    expect(await runCli(['steer', 'agent-one', 'redirect', '--json'], h.io, h.environment)).toBe(0);
    expect(await runCli(['cancel', 'agent-one', '--json'], h.io, h.environment)).toBe(0);
    expect(await runCli(['wait', 'agent-one', '--for', 'idle', '--json'], h.io, h.environment)).toBe(0);

    h.transport.snapshot = agentSnapshot({ ...fullCapabilities, steer: false });
    expect(await runCli(['steer', 'agent-one', 'blocked', '--json'], h.io, h.environment)).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'capability_unsupported' } });
    expect(h.transport.sent.filter((message) => message.type === 'steer').map((message) => message.payload.text)).not.toContain('blocked');
  });

  it.each(['send', 'steer'] as const)('waits for the acknowledged %s turn to start and finish before reporting idle', async (command) => {
    const h = harness();
    const running = runCli([command, 'agent-one', 'hello', '--wait', 'idle', '--timeout', '100', '--json'], h.io, h.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const report of h.transport.diagnostics) {
      report({ source: 'websocket', code: 'unrelated', message: 'Unrelated diagnostic.', recoverable: true });
    }
    h.transport.emit({
      protocolVersion, type: 'resource_response',
      payload: {
        requestId: 'unrelated-resource', agentId: 'agent-one', resourceId: 'resource-one',
        state: { status: 'available', mediaType: 'text/plain', byteLength: 5, sha256: h.transport.resourceSha256, contentBase64: 'aGVsbG8=' },
      },
    });
    let settled = false;
    void running.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    h.transport.emit({
      protocolVersion, type: 'agent_stream',
      payload: {
        agentId: 'agent-one', timestamp: '2026-09-03T00:00:02.000Z',
        event: { type: 'turn_started', providerId: 'provider-one', turnId: 'turn-one' },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.transport.emit({
      protocolVersion, type: 'agent_stream',
      payload: {
        agentId: 'agent-one', timestamp: '2026-09-03T00:00:03.000Z',
        event: { type: 'turn_completed', providerId: 'provider-one', turnId: 'turn-one' },
      },
    });

    expect(await running).toBe(0);
    expect(json(h.stdout())).toMatchObject({
      type: 'command_acknowledged',
      payload: { command: command === 'send' ? 'send_message' : 'steer' },
    });
  });

  it('lists and validates interactions before a matching resolution', async () => {
    const h = harness();
    h.transport.snapshot = {
      ...agentSnapshot(),
      payload: { ...agentSnapshot().payload, pendingInteractions: [{ kind: 'question', requestId: 'question-one', questions: [{ questionId: 'q', header: 'Q', prompt: 'Choose', required: true, selection: 'single', options: [], allowCustomText: true, allowDismiss: true }] }] },
    };

    expect(await runCli(['interaction', 'list', 'agent-one', '--json'], h.io, h.environment)).toBe(0);
    expect(json(h.stdout())).toEqual([expect.objectContaining({ requestId: 'question-one' })]);

    h.setStdin('{"kind":"question","answers":[]}');
    expect(await runCli(['interaction', 'respond', 'agent-one', 'question-one', '--response-file', '-', '--json'], h.io, h.environment)).toBe(0);
    h.setStdin('{"kind":"question","answers":[{"questionId":"","selectedValues":[]}]}');
    expect(await runCli(['interaction', 'respond', 'agent-one', 'question-one', '--response-file', '-', '--json'], h.io, h.environment)).toBe(2);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'invalid_interaction_response' } });
    h.setStdin('{"kind":"question","answers":[]}');
    expect(await runCli(['interaction', 'respond', 'agent-one', 'missing', '--response-file', '-', '--json'], h.io, h.environment)).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'interaction_stale' } });

    h.setStdin('{"kind":"plan_approval","action":"approve"}');
    expect(await runCli(['interaction', 'respond', 'agent-one', 'question-one', '--response-file', '-', '--json'], h.io, h.environment)).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'interaction_response_kind_mismatch' } });
  });

  it('retries pending resources on one runtime and writes bytes only after availability', async () => {
    const h = harness();

    expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/result.bin', '--json'], h.io, h.environment)).toBe(0);
    expect(h.transport.resourceAttempts).toBe(2);
    expect(h.writes).toEqual([{ path: '/tmp/result.bin', bytes: new TextEncoder().encode('hello') }]);
    expect(json(h.stdout())).toMatchObject({ resourceId: 'resource-one', byteLength: 5, output: '/tmp/result.bin' });
    expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', '-', '--json'], h.io, h.environment)).toBe(2);

    const binary = harness();
    expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', '-'], binary.io, binary.environment)).toBe(0);
    expect(binary.writes).toEqual([{ path: '-', bytes: new TextEncoder().encode('hello') }]);
    expect(binary.stdout()).toBe('');
    expect(json(binary.stderr())).toMatchObject({ resourceId: 'resource-one', byteLength: 5, output: '-' });

    const textFile = harness();
    expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/result.txt'], textFile.io, textFile.environment)).toBe(0);
    expect(textFile.stdout()).toBe('');
    expect(json(textFile.stderr())).toMatchObject({ resourceId: 'resource-one', byteLength: 5, output: '/tmp/result.txt' });

    for (const terminal of ['failed', 'unavailable'] as const) {
      const failed = harness();
      failed.transport.resourceTerminal = terminal;
      expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', `/tmp/${terminal}.bin`, '--json'], failed.io, failed.environment)).toBe(4);
      expect(failed.writes).toEqual([]);
    }
  });

  it('rejects resource bytes whose SHA-256 does not match before writing output', async () => {
    const h = harness();
    h.transport.resourceSha256 = '0'.repeat(64);

    expect(await runCli([
      'resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/corrupt.bin', '--json',
    ], h.io, h.environment)).toBe(4);
    expect(h.writes).toEqual([]);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'resource_sha256_mismatch', recoverable: false } });
  });

  it('bounds every resource retry by the total command timeout without writing a partial file', async () => {
    const h = harness();
    h.transport.resourceRemainsPending = true;
    h.transport.resourceStopsRespondingAfterFirst = true;

    expect(await runCli(['resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/never.bin', '--timeout', '5', '--json'], h.io, h.environment)).toBe(5);
    expect(h.writes).toEqual([]);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'command_timeout' } });
  });

  it('emits observe and protocol records as clean JSONL and maps mismatches, interruption, and help', async () => {
    const h = harness();

    expect(await runCli(['observe', 'agent-one', '--jsonl', '--until', 'idle'], h.io, h.environment)).toBe(0);
    expect(h.stdout().trim().split('\n').map(json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'connection' }), expect.objectContaining({ kind: 'checkpoint' }),
    ]));

    expect(await runCli(['protocol', 'trace', 'agent-one', '--jsonl', '--until', 'idle'], h.io, h.environment)).toBe(0);
    const protocolRecords = h.stdout().trim().split('\n').map(json).filter((record) => record.kind === 'protocol');
    expect(protocolRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'protocol', channel: 'http' }), expect.objectContaining({ kind: 'protocol', channel: 'websocket' }),
    ]));
    expect(protocolRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'inbound', channel: 'websocket', messageType: 'negotiated' }),
      expect.objectContaining({ direction: 'outbound', channel: 'websocket', messageType: 'timeline_subscription', requestId: expect.any(String) }),
    ]));

    const diagnosticTrace = harness();
    diagnosticTrace.transport.diagnosticOnConnect = true;
    diagnosticTrace.transport.traceResource = true;
    expect(await runCli(['protocol', 'trace', 'agent-one', '--jsonl', '--until', 'idle'], diagnosticTrace.io, diagnosticTrace.environment)).toBe(0);
    const diagnosticRecords = diagnosticTrace.stdout().trim().split('\n').map(json);
    expect(diagnosticRecords).toContainEqual(expect.objectContaining({ kind: 'diagnostic', diagnostic: expect.objectContaining({ code: 'invalid_wire_body' }) }));
    expect(diagnosticRecords).toContainEqual(expect.objectContaining({ kind: 'protocol', messageType: 'resource_response', message: expect.objectContaining({ payload: expect.objectContaining({ state: expect.objectContaining({ contentBase64: expect.objectContaining({ omitted: 'resource_content' }) }) }) }) }));

    h.transport.responseKindMismatch = true;
    expect(await runCli(['send', 'agent-one', 'mismatch', '--timeout', '5', '--json'], h.io, h.environment)).toBe(5);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'command_timeout' } });

    const running = runCli(['observe', 'agent-one', '--jsonl'], h.io, h.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.interrupt();
    expect(await running).toBe(130);
    expect(await runCli(['--help'], h.io, h.environment)).toBe(0);
    expect(h.stdout()).toContain('protocol trace');
  });

  it('applies an explicit timeout to a stream without an until condition', async () => {
    const h = harness();
    const running = runCli(['observe', 'agent-one', '--jsonl', '--timeout', '5'], h.io, h.environment);
    const result = await Promise.race([
      running,
      new Promise<-1>((resolve) => setTimeout(() => resolve(-1), 50)),
    ]);
    if (result === -1) {
      h.interrupt();
      await running;
    }

    expect(result).toBe(5);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'command_timeout' } });
  });

  it('rejects options outside their command and propagates Relay and Origin precedence', async () => {
    const h = harness();
    h.setEnvironment({ BORGEE_REMOTE_URL: 'http://relay-env', BORGEE_REMOTE_ORIGIN: 'http://origin-env' });

    expect(await runCli(['provider', 'list', '--output', '/tmp/nope', '--json'], h.io, h.environment)).toBe(2);
    expect(await runCli(['cancel', 'agent-one', '--file', '/tmp/nope', '--json'], h.io, h.environment)).toBe(2);
    expect(await runCli(['provider', 'list', '--json'], h.io, h.environment)).toBe(0);
    expect(h.httpRelayUrls()).toContain('http://relay-env');
    expect(await runCli(['inspect', 'agent-one', '--json'], h.io, h.environment)).toBe(0);
    expect(h.runtimeOptions().at(-1)).toMatchObject({ relayUrl: 'http://relay-env', origin: 'http://origin-env' });
    expect(await runCli(['inspect', 'agent-one', '--relay', 'http://relay-cli', '--origin', 'http://origin-cli', '--json'], h.io, h.environment)).toBe(0);
    expect(h.runtimeOptions().at(-1)).toMatchObject({ relayUrl: 'http://relay-cli', origin: 'http://origin-cli' });
    h.setEnvironment({});
    expect(await runCli(['provider', 'list', '--json'], h.io, h.environment)).toBe(0);
    expect(h.httpRelayUrls().at(-1)).toBe('http://127.0.0.1:5910');
    expect(await runCli(['inspect', 'agent-one', '--json'], h.io, h.environment)).toBe(0);
    expect(h.runtimeOptions().at(-1)).toMatchObject({ relayUrl: 'http://127.0.0.1:5910', origin: 'http://127.0.0.1:6175' });
  });

  it('classifies malformed direct HTTP protocol bodies separately from Relay connection failures', async () => {
    const h = harness();
    const failingEnvironment = (code: 'invalid_wire_body' | 'request_failed') => ({
      ...h.environment,
      createHttpTransport: () => ({
        listProviders: async () => {
          throw new Error('Relay request failed.');
        },
        createAgent: async () => { throw new Error('unused'); },
        resumeAgent: async () => { throw new Error('unused'); },
        onDiagnostic: (listener: (diagnostic: RemoteTransportDiagnostic) => void) => {
          listener({ source: 'http', code, message: 'Relay failed.', recoverable: true });
          return () => undefined;
        },
      }),
    });

    expect(await runCli(['provider', 'list', '--json'], h.io, failingEnvironment('invalid_wire_body'))).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'invalid_wire_body' } });
    expect(await runCli(['provider', 'list', '--json'], h.io, failingEnvironment('request_failed'))).toBe(3);
  });

  it('classifies a decoded but wrong-kind direct HTTP response as a public protocol failure', async () => {
    const h = harness();
    const transport = new HttpWebSocketTransport('http://relay.example', {
      fetch: async () => new Response(JSON.stringify(agentSnapshot())),
    });
    const environment = { ...h.environment, createHttpTransport: () => transport };

    expect(await runCli(['provider', 'list', '--json'], h.io, environment)).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'invalid_public_response' } });
  });

  it('classifies response-body transport failures as connection errors', async () => {
    const h = harness();
    const transport = new HttpWebSocketTransport('http://relay.example', {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => { throw new Error('body stream failed'); },
      }) as Response,
    });
    const environment = { ...h.environment, createHttpTransport: () => transport };

    expect(await runCli(['provider', 'list', '--json'], h.io, environment)).toBe(3);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'response_body_failed' } });
  });

  it('classifies shared-client disconnect and operation timeout errors by stable exit category', async () => {
    const disconnected = harness();
    disconnected.transport.withholdCommandAcknowledgement = true;
    const pendingDisconnect = runCli(['send', 'agent-one', 'hello', '--json'], disconnected.io, disconnected.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    disconnected.transport.listener?.onDisconnect();
    expect(await pendingDisconnect).toBe(3);
    expect(json(disconnected.stderr())).toMatchObject({ error: { code: 'connection_disconnected' } });

    const timedOut = harness();
    timedOut.transport.withholdCommandAcknowledgement = true;
    expect(await runCli(['cancel', 'agent-one', '--json'], timedOut.io, timedOut.environment)).toBe(5);
    expect(json(timedOut.stderr())).toMatchObject({ error: { code: 'operation_timeout' } });

    const sendDeadline = harness();
    sendDeadline.transport.withholdCommandAcknowledgement = true;
    expect(await runCli(['send', 'agent-one', 'hello', '--timeout', '100', '--json'], sendDeadline.io, sendDeadline.environment)).toBe(5);
    expect(json(sendDeadline.stderr())).toMatchObject({ error: { code: 'command_timeout' } });
  });

  it('classifies local stdout and resource destination failures as invalid local output', async () => {
    const stdoutFailure = harness();
    const io = {
      ...stdoutFailure.io,
      stdout: () => { throw new Error('stdout closed'); },
    };
    expect(await runCli(['provider', 'list', '--json'], io, stdoutFailure.environment)).toBe(2);
    expect(json(stdoutFailure.stderr())).toMatchObject({ error: { code: 'output_write_failed' } });

    const textStdoutFailure = harness();
    const textIo = {
      ...textStdoutFailure.io,
      stdout: () => { throw new Error('stdout closed'); },
    };
    expect(await runCli(['provider', 'list'], textIo, textStdoutFailure.environment)).toBe(2);
    expect(json(textStdoutFailure.stderr())).toMatchObject({ error: { code: 'output_write_failed' } });

    const fileFailure = harness();
    const environment = {
      ...fileFailure.environment,
      writeFile: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
    };
    expect(await runCli([
      'resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/full.bin', '--json',
    ], fileFailure.io, environment)).toBe(2);
    expect(json(fileFailure.stderr())).toMatchObject({ error: { code: 'output_file_write_failed' } });
  });

  it('fails protocol trace when an isolated observer cannot write stdout', async () => {
    const h = harness();
    let writes = 0;
    const io = {
      ...h.io,
      stdout: () => {
        writes += 1;
        throw new Error('stdout closed');
      },
    };

    expect(await runCli(['protocol', 'trace', 'agent-one', '--jsonl', '--until', 'idle'], io, h.environment)).toBe(2);
    expect(writes).toBeGreaterThan(0);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'output_write_failed' } });
  });

  it('maps text streaming stdout failures to the stable output error', async () => {
    const h = harness();
    const io = {
      ...h.io,
      stdout: () => { throw new Error('stdout closed'); },
    };

    expect(await runCli(['observe', 'agent-one', '--until', 'idle'], io, h.environment)).toBe(2);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'output_write_failed' } });
  });

  it('rejects empty persistence fields and documents public options and environment fallbacks', async () => {
    const h = harness();
    h.setStdin('{"providerId":"","sessionId":"session","opaque":"opaque"}');
    expect(await runCli(['session', 'resume', 'agent-one', '--persistence-file', '-', '--json'], h.io, h.environment)).toBe(2);
    expect(await runCli(['--help'], h.io, h.environment)).toBe(0);
    expect(h.stdout()).toContain('--reasoning-effort');
    expect(h.stdout()).toContain('BORGEE_REMOTE_URL');
    expect(h.stdout()).toContain('--until <idle|interaction|failed>');
    expect(h.stdout()).not.toContain('--no-color');
    expect(await runCli(['provider', 'list', '--no-color'], h.io, h.environment)).toBe(2);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'unknown_option' } });
  });

  it('interrupts stalled direct HTTP and runtime construction without waiting for their timeout', async () => {
    const http = harness();
    const stalledHttp = {
      ...http.environment,
      createHttpTransport: () => ({
        listProviders: async (options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        }),
        createAgent: async () => { throw new Error('unused'); },
        resumeAgent: async () => { throw new Error('unused'); },
        onDiagnostic: () => () => undefined,
      }),
    };
    const pendingHttp = runCli(['provider', 'list', '--json'], http.io, stalledHttp);
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.interrupt();
    expect(await pendingHttp).toBe(130);

    const runtime = harness();
    const stalledRuntime = { ...runtime.environment, createRuntime: async () => new Promise<never>(() => undefined) };
    const pendingRuntime = runCli(['inspect', 'agent-one', '--json'], runtime.io, stalledRuntime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.interrupt();
    expect(await pendingRuntime).toBe(130);
  });

  it('passes cancellation to stdin and stops waiting when SIGINT arrives', async () => {
    const h = harness();
    let stdinSignal: AbortSignal | undefined;
    const io = {
      ...h.io,
      stdin: (signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
        stdinSignal = signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    };

    const running = runCli(['send', 'agent-one', '--file', '-', '--json'], io, h.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.interrupt();

    expect(await running).toBe(130);
    expect(stdinSignal?.aborted).toBe(true);
  });

  it('emits a preflight transport diagnostic in protocol trace before the structured failure', async () => {
    const h = harness();
    h.transport.fetchSnapshot = async () => {
      for (const listener of h.transport.diagnostics) listener({
        source: 'http', code: 'invalid_wire_body',
        message: 'Relay response was rejected by the public protocol.', recoverable: true,
      });
      throw new Error('invalid body');
    };
    const environment = {
      ...h.environment,
      createRuntime: async (agentId: string, options: Parameters<NonNullable<CliEnvironment['createRuntime']>>[1]) => {
        const { createDebuggerRuntime } = await import('./runtime.js');
        return createDebuggerRuntime(agentId, { ...options, transport: h.transport });
      },
    };

    expect(await runCli(['protocol', 'trace', 'agent-one', '--jsonl'], h.io, environment)).toBe(4);
    expect(h.stdout().trim().split('\n').map(json)).toContainEqual(expect.objectContaining({
      kind: 'diagnostic', diagnostic: expect.objectContaining({ code: 'invalid_wire_body' }),
    }));
    expect(json(h.stderr())).toMatchObject({ error: { code: 'invalid_wire_body' } });
  });

  it('aborts direct provider HTTP requests when SIGINT interrupts the command', async () => {
    const h = harness();
    let requestSignal: AbortSignal | undefined;
    const environment = {
      ...h.environment,
      createHttpTransport: () => ({
        listProviders: async (options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
          requestSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        }),
        createAgent: async () => { throw new Error('unused'); },
        resumeAgent: async () => { throw new Error('unused'); },
        onDiagnostic: () => () => undefined,
      }),
    };

    const running = runCli(['provider', 'list', '--json'], h.io, environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.interrupt();
    expect(await running).toBe(130);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts the direct HTTP request and settles it when the command deadline expires', async () => {
    const h = harness();
    let requestActive = false;
    let observedAbort = false;
    const environment = {
      ...h.environment,
      createHttpTransport: () => ({
        listProviders: async (options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
          requestActive = true;
          options?.signal?.addEventListener('abort', () => {
            observedAbort = true;
            requestActive = false;
            reject(new Error('request aborted'));
          }, { once: true });
        }),
        createAgent: async () => { throw new Error('unused'); },
        resumeAgent: async () => { throw new Error('unused'); },
        onDiagnostic: () => () => undefined,
      }),
    };

    expect(await runCli(['provider', 'list', '--timeout', '5', '--json'], h.io, environment)).toBe(5);
    expect(observedAbort).toBe(true);
    expect(requestActive).toBe(false);
  });

  it('preserves decoded HTTP protocol errors before classifying transport diagnostics', async () => {
    const h = harness();
    const transport = new HttpWebSocketTransport('http://relay.example', {
      fetch: async () => new Response(JSON.stringify({
        protocolVersion,
        type: 'protocol_error',
        payload: { requestId: 'provider-list', code: 'agent_not_found', message: 'Agent was not found.', recoverable: false },
      }), { status: 404 }),
    });
    const environment = { ...h.environment, createHttpTransport: () => transport };

    expect(await runCli(['provider', 'list', '--json'], h.io, environment)).toBe(4);
    expect(json(h.stderr())).toMatchObject({ error: { code: 'agent_not_found', message: 'Agent was not found.', recoverable: false } });
  });

  it('closes a runtime that resolves after SIGINT has retired its command', async () => {
    const h = harness();
    let resolveRuntime: (runtime: DebuggerRuntime) => void = () => undefined;
    let closeCalls = 0;
    const delayedRuntime = new Promise<DebuggerRuntime>((resolve) => { resolveRuntime = resolve; });
    const environment = { ...h.environment, createRuntime: async () => delayedRuntime };

    const running = runCli(['inspect', 'agent-one', '--json'], h.io, environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.interrupt();
    expect(await running).toBe(130);
    resolveRuntime({ close: () => { closeCalls += 1; } } as DebuggerRuntime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
  });

  it('closes the shared client while an interrupted command acknowledgement is pending', async () => {
    const h = harness();
    h.transport.withholdCommandAcknowledgement = true;

    const running = runCli(['send', 'agent-one', 'hello', '--json'], h.io, h.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.sent.some((message) => message.type === 'send_message')).toBe(true);
    h.interrupt();
    expect(await running).toBe(130);
    expect(h.transport.closedConnections).toBe(1);
  });

  it('settles interrupted and timed-out file writes before returning without writing files', async () => {
    for (const testCase of [
      { arguments: ['resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/interrupted.bin', '--json'], exitCode: 130, interrupt: true },
      { arguments: ['resource', 'get', 'agent-one', 'resource-one', '--output', '/tmp/timed-out.bin', '--timeout', '100', '--json'], exitCode: 5, interrupt: false },
    ]) {
      const h = harness();
      let requestSignal: AbortSignal | undefined;
      let writeStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { writeStarted = resolve; });
      const environment = {
        ...h.environment,
        writeFile: async (path: string, bytes: Uint8Array, options?: { signal?: AbortSignal }) => new Promise<void>((resolve, reject) => {
          requestSignal = options?.signal;
          writeStarted();
          const timer = setTimeout(() => {
            h.writes.push({ path, bytes });
            resolve();
          }, 150);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('write aborted'));
          }, { once: true });
        }),
      };

      const running = runCli(testCase.arguments, h.io, environment);
      await started;
      if (testCase.interrupt) h.interrupt();
      expect(await running).toBe(testCase.exitCode);
      await new Promise((resolve) => setTimeout(resolve, 175));
      expect(requestSignal?.aborted).toBe(true);
      expect(h.writes).toEqual([]);
    }
  });
});

it.each(['inspect', 'timeline'] as const)('does not print sensitive request defaults in %s output from a custom transport', async (command) => {
  const h = harness();
  const request = { kind: 'form' as const, requestId: 'form', title: 'Login', message: '', fields: [
    { type: 'text' as const, fieldId: 'token', label: 'Token', required: true, sensitive: true, defaultValue: 'PRIVATE_CLI_DEFAULT' },
    { type: 'text' as const, fieldId: 'region', label: 'Region', required: false, defaultValue: 'west' },
  ] };
  h.transport.snapshot.payload.pendingInteractions = [request];
  h.transport.timelineEntries = [{ ...timelineEntry, item: { type: 'interaction', request, response: { kind: 'form', action: 'cancel' } } }];
  expect(await runCli([command, 'agent-one', '--json'], h.io, h.environment)).toBe(0);
  expect(h.stdout()).not.toContain('PRIVATE_CLI_DEFAULT');
  expect(h.stdout()).toContain('west');
  expect(request.fields[0]!.defaultValue).toBe('PRIVATE_CLI_DEFAULT');
});
