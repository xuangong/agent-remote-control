import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AgentReplica as AgentReplicaInstance, WebSocketLike } from '@orchardworks/agent-remote-web/headless';

const debuggerDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const typescriptCliPath = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const labOrigin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
const childTimeoutMs = 10_000;
const setupTimeoutMs = 60_000;
const stdinReadinessImport = `data:text/javascript,${encodeURIComponent(`
  process.stdin.once('resume', () => {
    process.send('stdin-ready');
    process.disconnect();
  });
`)}`;

type ChildResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

type ChildClose = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
};

type ManagedChild = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<ChildClose>;
};

type JsonRecord = Record<string, unknown>;

type ReplicaJson = {
  timeline: {
    entries: Array<{
      resources: Array<{ locator: string; resourceId: string }>;
    }>;
  };
};

const children = new Map<ChildProcessWithoutNullStreams, Promise<ChildClose>>();
let createRecordedValidationServer: typeof import('../../agent-remote-lab/src/server/recorded.js')['createRecordedValidationServer'];
let AgentReplica: typeof import('@orchardworks/agent-remote-web/headless')['AgentReplica'];
let HttpWebSocketTransport: typeof import('@orchardworks/agent-remote-web/headless')['HttpWebSocketTransport'];
let RemoteSessionClient: typeof import('@orchardworks/agent-remote-web/headless')['RemoteSessionClient'];
let server: ReturnType<typeof createRecordedValidationServer>;
let relayUrl = '';
let temporaryDirectory = '';

beforeAll(async () => {
  for (const packageDirectory of [
    'packages/agent-remote-protocol',
    'packages/agent-provider-sdk',
    'packages/agent-remote-relay',
    'packages/agent-remote-web',
    'packages/agent-remote-debugger',
  ]) {
    const build = spawnSync(process.execPath, [typescriptCliPath], {
      cwd: join(repositoryDirectory, packageDirectory),
      encoding: 'utf8',
      timeout: childTimeoutMs,
    });
    expect(build.error, `${packageDirectory}: ${build.stderr}`).toBeUndefined();
    expect(build.status, `${packageDirectory}: ${build.stderr}`).toBe(0);
  }
  ({ createRecordedValidationServer } = await import('../../agent-remote-lab/src/server/recorded.js'));
  ({ AgentReplica, HttpWebSocketTransport, RemoteSessionClient } = await import('@orchardworks/agent-remote-web/headless'));
  server = createRecordedValidationServer();
  relayUrl = (await server.http.listen(0, '127.0.0.1')).url;
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'ardb-process-'));
}, setupTimeoutMs);

afterAll(async () => {
  await Promise.all([...children.keys()].map((child) => terminateAndWait(child)));
  if (server) await server.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true });
  expect(children.size).toBe(0);
});

describe('built ardb against the recorded Relay', () => {
  it.skipIf(process.platform === 'win32')('runs the installed ardb entry through a package binary symlink', async () => {
    const manifest = JSON.parse(await readFile(join(repositoryDirectory, 'packages/agent-remote-debugger/package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(manifest.bin).toEqual({ ardb: './dist/cli.js' });
    const entry = join(temporaryDirectory, 'ardb');
    await symlink(join(repositoryDirectory, 'packages/agent-remote-debugger', manifest.bin.ardb!), entry);
    const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: childTimeoutMs });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: ardb <command>');
    expect(result.stdout).toContain('Session View protocol and state');
  });

  it('lists the recorded Provider, creates a Session, and emits a ready baseline', async () => {
    const help = await runArdb(['--help']);
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout.toString('utf8')).toContain('Usage: ardb <command>');
    expect(help.stdout.toString('utf8')).toContain('protocol trace');

    const providers = await runArdb(['provider', 'list', '--json']);
    expect(providers.exitCode).toBe(0);
    expect(parseJson(providers.stdout)).toContainEqual({
      providerId: 'recorded',
      displayName: 'Recorded semantic Provider',
    });

    const created = await runArdb([
      'session', 'create', 'process-baseline', '--provider', 'recorded',
      '--provider-session-id', 'process-provider-baseline', '--json',
    ]);
    expect(created.exitCode).toBe(0);
    expect(parseJson(created.stdout)).toMatchObject({
      type: 'agent_session',
      payload: {
        agentId: 'process-baseline',
        providerId: 'recorded',
        sessionId: 'process-provider-baseline',
      },
    });

    const observed = await runArdb(['observe', 'process-baseline', '--jsonl', '--until', 'idle']);
    expect(observed.exitCode, observed.stderr).toBe(0);
    const records = parseJsonLines(observed.stdout);
    expectBaselineGroupOrder(records);
    expect(records[0]).toMatchObject({ kind: 'connection', status: 'ready', agentId: 'process-baseline' });
    expect(records[1]).toMatchObject({
      kind: 'agent',
      agent: expect.objectContaining({ id: 'process-baseline' }),
    });
  });

  it('acknowledges send and reconstructs its user and assistant Timeline from a fresh process', async () => {
    const agentId = 'process-send';
    await createAgent(agentId);
    const observer = startJsonlBdb(['observe', agentId, '--jsonl']);
    try {
      await observer.waitFor((record) => record.kind === 'checkpoint');
      const running = startBdb(['send', agentId, 'hello from process', '--wait', 'idle', '--json']);
      await observer.waitFor((record) => {
        const item = record.entry as { item?: { type?: string; text?: string } } | undefined;
        return record.kind === 'timeline_upsert'
          && item?.item?.type === 'assistant_message'
          && item.item.text === 'Recorded reply: hello from process';
      });
      expect(running.isClosed()).toBe(false);
      await fixtureAction(agentId, 'advance');
      const sent = await running.result;
      expect(sent.exitCode, sent.stderr).toBe(0);
      expect(parseJson(sent.stdout)).toMatchObject({
        type: 'command_acknowledged',
        payload: { agentId, command: 'send_message' },
      });
    } finally {
      await observer.stop();
    }

    const fresh = await runArdb(['observe', agentId, '--jsonl', '--until', 'interaction']);
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    const messages = parseJsonLines(fresh.stdout)
      .filter(isTimelineRecord)
      .map((record) => record.entry.item)
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user_message', text: 'hello from process' }),
      expect.objectContaining({ type: 'assistant_message', text: 'Recorded reply: hello from process' }),
    ]));
  });

  it('drives steer, cancel, and idle, interaction, and failed waits through Replica state', async () => {
    const agentId = 'process-control';
    await createAgent(agentId);
    const observer = startJsonlBdb(['observe', agentId, '--jsonl']);
    try {
      await observer.waitFor((record) => record.kind === 'checkpoint');
      const steering = startBdb(['steer', agentId, 'change direction', '--wait', 'idle', '--json']);
      await observer.waitFor((record) => {
        const item = record.entry as { item?: { type?: string; text?: string } } | undefined;
        return record.kind === 'timeline_upsert'
          && item?.item?.type === 'reasoning'
          && item.item.text === 'Steered: change direction';
      });
      expect(steering.isClosed()).toBe(false);
      await fixtureAction(agentId, 'advance');
      const steered = await steering.result;
      expect(steered.exitCode, steered.stderr).toBe(0);
      expect(parseJson(steered.stdout)).toMatchObject({ payload: { command: 'steer' } });
    } finally {
      await observer.stop();
    }
    const canceled = await runArdb(['cancel', agentId, '--json']);
    expect(canceled.exitCode, canceled.stderr).toBe(0);
    expect(parseJson(canceled.stdout)).toMatchObject({ payload: { command: 'cancel' } });
    expect((await runArdb(['wait', agentId, '--for', 'idle', '--json'])).exitCode).toBe(0);

    await fixtureAction(agentId, 'advance');
    const interaction = await runArdb(['wait', agentId, '--for', 'interaction', '--json']);
    expect(interaction.exitCode, interaction.stderr).toBe(0);

    await fixtureAction(agentId, 'fail');
    const failed = await runArdb(['wait', agentId, '--for', 'failed', '--json']);
    expect(failed.exitCode, failed.stderr).toBe(0);
  });

  it('keeps steer --wait idle pending after acknowledgement until post-command Replica progress is released', async () => {
    const gatedServer = createRecordedValidationServer({ deferSteerObservation: true });
    const gatedRelay = (await gatedServer.http.listen(0, '127.0.0.1')).url;
    const agentId = 'process-gated-steer';
    const providerSessionId = `${agentId}-provider`;
    let running: ReturnType<typeof startBdb> | undefined;
    let observer: ReturnType<typeof startJsonlBdb> | undefined;
    try {
      await createAgent(agentId, gatedRelay);
      observer = startJsonlBdb(['observe', agentId, '--jsonl'], gatedRelay);
      await observer.waitFor((record) => record.kind === 'checkpoint');
      running = startBdb([
        'steer', agentId, 'release after acknowledgement', '--wait', 'idle', '--json',
      ], undefined, gatedRelay);

      await gatedServer.recorded.waitForDeferredSteer(providerSessionId);
      expect(running.isClosed()).toBe(false);

      gatedServer.recorded.releaseDeferredSteer(providerSessionId);
      await observer.waitFor((record) => {
        const item = record.entry as { item?: { type?: string; text?: string } } | undefined;
        return record.kind === 'timeline_upsert'
          && item?.item?.type === 'reasoning'
          && item.item.text === 'Steered: release after acknowledgement';
      });
      expect(running.isClosed()).toBe(false);
      await fixtureAction(agentId, 'advance', gatedRelay);
      const result = await running.result;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({
        type: 'command_acknowledged',
        payload: { agentId, command: 'steer' },
      });
    } finally {
      if (observer) await observer.stop();
      if (running && !running.isClosed()) {
        await running.stop();
        await running.result.catch(() => undefined);
      }
      await gatedServer.close();
    }
  });

  it('resolves Question, Plan Approval, Tool allow, and Tool deny in order', async () => {
    const agentId = 'process-interactions';
    await createAgent(agentId);
    await fixtureAction(agentId, 'advance');

    const responses: Array<[string, unknown, string]> = [
      ['recorded-question', { kind: 'question', answers: [{ questionId: 'release', selectedValues: ['stable'] }] }, 'recorded-plan'],
      ['recorded-plan', { kind: 'plan_approval', action: 'approve' }, 'recorded-tool-once'],
      ['recorded-tool-once', { kind: 'tool_approval', decision: 'allow', scope: 'once' }, 'recorded-tool-deny'],
      ['recorded-tool-deny', { kind: 'tool_approval', decision: 'deny' }, ''],
    ];
    for (const [requestId, response, nextRequestId] of responses) {
      const resolved = await runArdb([
        'interaction', 'respond', agentId, requestId, '--response-file', '-', '--json',
      ], `${JSON.stringify(response)}\n`);
      expect(resolved.exitCode, resolved.stderr).toBe(0);
      expect(parseJson(resolved.stdout)).toMatchObject({
        type: 'command_acknowledged', payload: { agentId, command: 'interaction_response' },
      });
      const listed = await runArdb(['interaction', 'list', agentId, '--json']);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const pending = parseJson(listed.stdout) as Array<{ requestId: string }>;
      if (nextRequestId) expect(pending.map(({ requestId: id }) => id)).toContain(nextRequestId);
      else expect(pending).toEqual([]);
    }
  });

  it('returns exact resource bytes, public trace records, and terminal resource errors', async () => {
    const agentId = 'process-resources';
    await createAgent(agentId);
    const inspected = await runArdb(['inspect', agentId, '--json']);
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const state = parseJson(inspected.stdout) as ReplicaJson;
    const availableId = resourceIdFor(state, 'artifacts/lab-proof.txt');
    const failedId = resourceIdFor(state, 'artifacts/failed.txt');
    const unavailableId = resourceIdFor(state, 'artifacts/missing.txt');
    const output = join(temporaryDirectory, 'lab-proof.txt');

    const available = await runArdb(['resource', 'get', agentId, availableId, '--output', output, '--json']);
    expect(available.exitCode, available.stderr).toBe(0);
    expect(await readFile(output)).toEqual(Buffer.from('BORgee Agent Remote durable resource\n'));
    expect(parseJson(available.stdout)).toMatchObject({ resourceId: availableId, byteLength: 37 });

    const streamed = await runArdb(['resource', 'get', agentId, availableId, '--output', '-']);
    expect(streamed.exitCode, streamed.stderr).toBe(0);
    expect(streamed.stdout).toEqual(Buffer.from('BORgee Agent Remote durable resource\n'));
    expect(JSON.parse(streamed.stderr)).toMatchObject({ resourceId: availableId, byteLength: 37, output: '-' });

    const failedOutput = join(temporaryDirectory, 'failed');
    const unavailableOutput = join(temporaryDirectory, 'missing');
    await expectProcessError(['resource', 'get', agentId, failedId, '--output', failedOutput, '--json'], 4, 'resource_failed');
    await expectProcessError(['resource', 'get', agentId, unavailableId, '--output', unavailableOutput, '--json'], 4, 'resource_unavailable');
    await expect(access(failedOutput)).rejects.toThrow();
    await expect(access(unavailableOutput)).rejects.toThrow();

    const traced = await runArdb(['protocol', 'trace', agentId, '--jsonl', '--until', 'idle']);
    expect(traced.exitCode, traced.stderr).toBe(0);
    const trace = parseJsonLines(traced.stdout) as Array<Record<string, unknown>>;
    const snapshot = trace.find(({ messageType, channel }) => messageType === 'agent_snapshot' && channel === 'http');
    expect(snapshot).toMatchObject({ kind: 'protocol', direction: 'inbound', channel: 'http' });
    const subscription = trace.find(({ messageType, direction }) =>
      messageType === 'timeline_subscription' && direction === 'outbound');
    expect(subscription).toMatchObject({
      kind: 'protocol',
      channel: 'websocket',
      requestId: expect.any(String),
      message: {
        type: 'timeline_subscription',
        payload: { requestId: expect.any(String), agentIds: [agentId] },
      },
    });
    const subscriptionId = subscription?.requestId;
    expect((subscription?.message as { payload?: { requestId?: unknown } } | undefined)?.payload?.requestId)
      .toBe(subscriptionId);
    const subscribed = trace.find(({ messageType, direction }) =>
      messageType === 'timeline_subscribed' && direction === 'inbound');
    expect(subscribed).toMatchObject({
      kind: 'protocol',
      channel: 'websocket',
      requestId: subscriptionId,
      message: {
        type: 'timeline_subscribed',
        payload: { requestId: subscriptionId, agentIds: [agentId] },
      },
    });
    const page = trace.find(({ messageType, channel }) => messageType === 'timeline_page' && channel === 'http');
    expect(page).toMatchObject({
      direction: 'inbound',
      requestId: expect.any(String),
      message: {
        type: 'timeline_page',
        payload: { requestId: expect.any(String), agentId, direction: 'tail' },
      },
    });
    expect((page?.message as { payload?: { requestId?: unknown } } | undefined)?.payload?.requestId)
      .toBe(page?.requestId);
  });

  it('maps malformed JSON, stale requests, unavailable Agents, and timeout to stable categories', async () => {
    const agentId = 'process-negative';
    await createAgent(agentId);

    await expectProcessError([
      'interaction', 'respond', agentId, 'recorded-question', '--response-file', '-', '--json',
    ], 2, 'invalid_json', '{broken');
    await expectProcessError([
      'interaction', 'respond', agentId, 'stale-request', '--response-file', '-', '--json',
    ], 4, 'interaction_stale', '{"kind":"question","answers":[]}');
    await expectProcessError(['inspect', 'agent-does-not-exist', '--json'], 4, 'agent_not_found');
    await expectProcessError(['wait', agentId, '--for', 'failed', '--timeout', '25', '--json'], 5, 'command_timeout');
    await expectProcessError(['observe', agentId, '--jsonl', '--timeout', '25'], 5, 'command_timeout');
    await expectProcessError(['provider', 'list', '--json'], 3, 'network_error', undefined, 'http://127.0.0.1:1');
    await expectProcessError(['inspect', agentId, '--json'], 3, 'network_error', undefined, 'http://127.0.0.1:1');
  });

  it('exits 130 when SIGINT interrupts hanging Snapshot preflight', async () => {
    let acceptSnapshot: () => void = () => undefined;
    const snapshotReceived = new Promise<void>((resolve) => { acceptSnapshot = resolve; });
    const hangingServer = createServer((_request, _response) => { acceptSnapshot(); });
    const hangingRelay = `http://127.0.0.1:${(await new Promise<number>((resolve) => {
      hangingServer.listen(0, '127.0.0.1', () => {
        const address = hangingServer.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    }))}`;
    try {
      const snapshot = startBdb(['inspect', 'hanging-agent', '--json'], undefined, hangingRelay, { keepStdinOpen: true });
      await snapshotReceived;
      snapshot.interrupt();
      const snapshotResult = await snapshot.result;
      expect(snapshotResult.exitCode, snapshotResult.stderr).toBe(130);
      expect(JSON.parse(snapshotResult.stderr)).toMatchObject({ error: { code: 'interrupted' } });
    } finally {
      await new Promise<void>((resolve, reject) => hangingServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exits 130 when SIGINT interrupts stdin after reading starts', async () => {
    const agentId = 'process-stdin-interrupt';
    await createAgent(agentId);
    let notifyStdinReady: () => void;
    const stdinReady = new Promise<void>((resolve) => { notifyStdinReady = resolve; });
    const stdin = startBdb(['send', agentId, '--file', '-', '--json'], undefined, relayUrl, {
      keepStdinOpen: true,
      onStdinReady: () => notifyStdinReady(),
    });
    await Promise.race([
      stdinReady,
      stdin.result.then((result) => {
        throw new Error(`ardb exited before reading stdin: ${result.exitCode} ${result.stderr}`);
      }),
    ]);
    stdin.interrupt();
    const stdinResult = await stdin.result;
    expect(stdinResult.exitCode, stdinResult.stderr).toBe(130);
    expect(stdinResult.stdout).toHaveLength(0);
    expect(JSON.parse(stdinResult.stderr)).toMatchObject({ error: { code: 'interrupted' } });
  });

  it('rejects a command omitted by the recorded Agent capability Snapshot', async () => {
    const restrictedServer = createRecordedValidationServer({ capabilities: { steer: false } });
    const restrictedRelay = (await restrictedServer.http.listen(0, '127.0.0.1')).url;
    try {
      await createAgent('process-restricted', restrictedRelay);
      await expectProcessError([
        'steer', 'process-restricted', 'must not be sent', '--json',
      ], 4, 'capability_unsupported', undefined, restrictedRelay);
    } finally {
      await restrictedServer.close();
    }
  });

  it('lets a concurrent Web headless Replica and CLI observer converge on the same public Timeline', async () => {
    const agentId = 'process-concurrent';
    await createAgent(agentId);
    const transport = new HttpWebSocketTransport(relayUrl, {
      webSocketFactory: (url) => new WebSocket(url, { origin: labOrigin }) as unknown as WebSocketLike,
    });
    const replica = new AgentReplica();
    replica.applySnapshot(await transport.fetchSnapshot(agentId));
    const webClient = new RemoteSessionClient(agentId, transport, replica, { operationTimeoutMs: 1_000 });
    const ready = waitForReady(webClient);
    webClient.start();
    await ready;
    const observer = startJsonlBdb(['observe', agentId, '--jsonl']);
    try {
      await observer.waitFor((record) => record.kind === 'checkpoint');
      const sent = await runArdb(['send', agentId, 'shared convergence', '--json']);
      expect(sent.exitCode, sent.stderr).toBe(0);
      await observer.waitFor((record) => {
        const item = record.entry as { item?: { type?: string; text?: string } } | undefined;
        return record.kind === 'timeline_upsert'
          && item?.item?.type === 'assistant_message'
          && item.item.text === 'Recorded reply: shared convergence';
      });
      await waitForReplica(replica, () => replica.getState().timeline.entries.some(({ item }) =>
        item.type === 'assistant_message' && item.text === 'Recorded reply: shared convergence'));
      const inspected = await runArdb(['inspect', agentId, '--json']);
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      expect(stableReplicaProjection(parseJson(inspected.stdout))).toEqual(
        stableReplicaProjection(replica.getState()),
      );
    } finally {
      webClient.stop();
      await observer.stop();
    }
    expect(children.size).toBe(0);
  });
});

async function runArdb(arguments_: readonly string[], stdin?: string, targetRelay = relayUrl): Promise<ChildResult> {
  return startBdb(arguments_, stdin, targetRelay).result;
}

function startBdb(
  arguments_: readonly string[],
  stdin?: string,
  targetRelay = relayUrl,
  options: { keepStdinOpen?: boolean; onStdinReady?: () => void } = {},
): {
  result: Promise<ChildResult>;
  isClosed: () => boolean;
  stop: () => Promise<void>;
  interrupt: () => void;
} {
  const httpOnly = arguments_[0] === 'provider' || arguments_[0] === 'session';
  const connectionArguments = httpOnly ? ['--relay', targetRelay] : ['--relay', targetRelay, '--origin', labOrigin];
  const { child, closed } = launchBdb([...arguments_, ...connectionArguments], options.onStdinReady);
  const stdout: Buffer[] = [];
  let stderr = '';
  let didClose = false;
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  if (!options.keepStdinOpen) child.stdin.end(stdin);
  else if (stdin !== undefined) child.stdin.write(stdin);

  const result = new Promise<ChildResult>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateAndWait(child);
    }, childTimeoutMs);
    void closed.then((close) => {
      didClose = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ardb exceeded ${childTimeoutMs}ms: ${arguments_.join(' ')}`));
      } else if (close.spawnError) {
        reject(close.spawnError);
      } else if (close.signal) {
        reject(new Error(`ardb closed from signal ${close.signal}`));
      } else {
        resolve({ exitCode: close.exitCode ?? -1, stdout: Buffer.concat(stdout), stderr });
      }
    });
  });
  return {
    result,
    isClosed: () => didClose,
    stop: () => terminateAndWait(child),
    interrupt: () => { child.kill('SIGINT'); },
  };
}

function launchBdb(arguments_: readonly string[], onStdinReady?: () => void): ManagedChild {
  const preload = onStdinReady ? ['--import', stdinReadinessImport] : [];
  const child = spawn(process.execPath, [...preload, cliPath, ...arguments_], {
    cwd: debuggerDirectory,
    stdio: onStdinReady ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  if (onStdinReady) child.once('message', onStdinReady);
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise<ChildClose>((resolve) => {
    child.once('close', (exitCode, signal) => resolve({
      exitCode,
      signal,
      ...(spawnError ? { spawnError } : {}),
    }));
  });
  children.set(child, closed);
  void closed.then(() => { children.delete(child); });
  return { child, closed };
}

async function terminateAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = children.get(child);
  if (!closed) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const closedAfterTerm = await closesWithin(closed, 250);
  if (!closedAfterTerm) child.kill('SIGKILL');
  await closed;
}

function closesWithin(closed: Promise<ChildClose>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void closed.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8'));
}

function parseJsonLines(bytes: Buffer): unknown[] {
  return bytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function expectBaselineGroupOrder(records: readonly unknown[]): void {
  const groupOrder = new Map<string, number>([
    ['connection', 0],
    ['agent', 1],
    ['timeline_reset', 2],
    ['timeline_upsert', 3],
    ['interaction_requested', 4],
    ['resource', 5],
    ['diagnostic', 6],
    ['checkpoint', 7],
  ]);
  let previousGroup = -1;
  const counts = new Map<string, number>();
  for (const value of records) {
    const kind = typeof value === 'object' && value !== null
      ? (value as { kind?: unknown }).kind
      : undefined;
    expect(typeof kind).toBe('string');
    const group = typeof kind === 'string' ? groupOrder.get(kind) : undefined;
    expect(group, `Unexpected baseline record kind: ${String(kind)}`).toBeDefined();
    expect(group as number).toBeGreaterThanOrEqual(previousGroup);
    previousGroup = group as number;
    counts.set(kind as string, (counts.get(kind as string) ?? 0) + 1);
  }
  expect(counts.get('connection')).toBe(1);
  expect(counts.get('agent')).toBe(1);
  expect(counts.get('timeline_reset')).toBe(1);
  expect(counts.get('timeline_upsert')).toBeGreaterThan(0);
  expect(counts.get('checkpoint')).toBe(1);
}

async function createAgent(agentId: string, targetRelay = relayUrl): Promise<void> {
  const result = await runArdb([
    'session', 'create', agentId, '--provider', 'recorded',
    '--provider-session-id', `${agentId}-provider`, '--json',
  ], undefined, targetRelay);
  expect(result.exitCode, result.stderr).toBe(0);
}

async function fixtureAction(agentId: string, action: string, targetRelay = relayUrl): Promise<void> {
  const response = await fetch(`${targetRelay}/v1/lab/recorded/${encodeURIComponent(agentId)}/${action}`, {
    method: 'POST',
    headers: { origin: labOrigin },
  });
  expect(response.status).toBe(204);
}

function isTimelineRecord(value: unknown): value is { kind: 'timeline_upsert'; entry: { item: unknown } } {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'timeline_upsert'
    && typeof (value as { entry?: unknown }).entry === 'object';
}

function resourceIdFor(state: ReplicaJson, locator: string): string {
  for (const entry of state.timeline.entries) {
    const binding = entry.resources.find((resource) => resource.locator === locator);
    if (binding) return binding.resourceId;
  }
  throw new Error(`Resource binding is missing for ${locator}.`);
}

async function expectProcessError(
  arguments_: readonly string[],
  exitCode: number,
  code: string,
  stdin?: string,
  targetRelay = relayUrl,
): Promise<void> {
  const result = await runArdb(arguments_, stdin, targetRelay);
  expect(result.exitCode, result.stderr).toBe(exitCode);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code } });
}

function startJsonlBdb(arguments_: readonly string[], targetRelay = relayUrl): {
  waitFor(predicate: (record: JsonRecord) => boolean): Promise<JsonRecord>;
  stop(): Promise<void>;
} {
  const { child, closed } = launchBdb([
    ...arguments_, '--relay', targetRelay, '--origin', labOrigin,
  ]);
  child.stdin.end();
  const records: JsonRecord[] = [];
  const waiters = new Set<{
    predicate: (record: JsonRecord) => boolean;
    resolve: (record: JsonRecord) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let buffer = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch (error) {
        rejectJsonlWaiters(error instanceof Error ? error : new Error(String(error)));
        void terminateAndWait(child);
        return;
      }
      records.push(record);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(record)) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(record);
      }
    }
  });
  const rejectJsonlWaiters = (error: Error): void => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };
  void closed.then(() => {
    rejectJsonlWaiters(new Error(`ardb observer closed before the requested record: ${stderr}`));
  });
  const watchdog = setTimeout(() => { void terminateAndWait(child); }, childTimeoutMs);
  void closed.then(() => clearTimeout(watchdog));
  return {
    waitFor(predicate) {
      const existing = records.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            reject(new Error('Timed out waiting for ardb JSONL record.'));
          }, childTimeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async stop() {
      clearTimeout(watchdog);
      await terminateAndWait(child);
    },
  };
}

function waitForReady(client: RemoteSessionClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Web headless client did not become ready.'));
    }, 3_000);
    const unsubscribe = client.subscribeStatus((status) => {
      if (status !== 'ready') return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

async function waitForReplica(replica: AgentReplicaInstance, predicate: () => boolean): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for converged Replica state.'));
    }, 3_000);
    const unsubscribe = replica.subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function stableReplicaProjection(value: unknown): unknown {
  const state = value as {
    agent: unknown;
    timeline: { epoch: unknown; nextSeq: unknown; hasOlder: unknown; entries: unknown };
    pendingInteractions: unknown;
    resources: unknown;
    diagnostics: unknown;
  };
  return {
    agent: state.agent,
    timeline: {
      epoch: state.timeline.epoch,
      nextSeq: state.timeline.nextSeq,
      hasOlder: state.timeline.hasOlder,
      entries: state.timeline.entries,
    },
    pendingInteractions: state.pendingInteractions,
    resources: state.resources,
    diagnostics: state.diagnostics,
  };
}
