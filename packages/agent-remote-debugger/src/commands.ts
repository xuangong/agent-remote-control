import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { PROTOCOL_VERSION, encodeClientMessage, type AgentInteractionResponse, type AgentPersistenceHandle, type AgentSessionConfig, type ResourceResponse } from '@borgee/agent-remote-protocol';
import { HttpWebSocketTransport, RemoteOperationError } from '@borgee/agent-remote-web/headless';

import { DebuggerError } from './errors.js';
import { parseExactJson, readTextInput, resolveOrigin, resolveRelayUrl } from './input.js';
import type { DebuggerIo } from './output.js';
import { writeBinary, writeFileAtomically, writeJson, writeJsonToStderr, writeText } from './output.js';
import { observeReplica } from './records.js';
import { createDebuggerRuntime, createProtocolTraceRecord, type DebuggerRuntime, type DebuggerRuntimeOptions, type WaitCondition } from './runtime.js';

export type OutputFormat = 'text' | 'json' | 'jsonl';

export interface ParsedInvocation {
  readonly path: readonly string[];
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
  readonly format: OutputFormat;
}

type SessionTransport = Pick<HttpWebSocketTransport, 'listProviders' | 'createAgent' | 'resumeAgent' | 'onDiagnostic'>;

export interface CliEnvironment {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly createRuntime?: (agentId: string, options: DebuggerRuntimeOptions) => Promise<DebuggerRuntime>;
  readonly createHttpTransport?: (relayUrl: string) => SessionTransport;
  readonly writeFile?: (path: string, bytes: Uint8Array, options: { signal: AbortSignal }) => Promise<void>;
  readonly subscribeSigint?: (listener: () => void) => () => void;
}

export async function executeCommand(
  invocation: ParsedInvocation,
  io: DebuggerIo,
  environment: CliEnvironment,
  signal: AbortSignal,
): Promise<void> {
  const context = new CommandContext(invocation, io, environment, signal);
  try {
    const path = invocation.path.join(' ');
    switch (path) {
      case 'provider list': return await context.listProviders();
      case 'session create': return await context.createSession();
      case 'session resume': return await context.resumeSession();
      case 'inspect': return await context.inspect();
      case 'timeline': return await context.timeline();
      case 'send': return await context.command('send');
      case 'steer': return await context.command('steer');
      case 'cancel': return await context.command('cancel');
      case 'planning': return await context.setPlanning();
      case 'wait': return await context.wait();
      case 'interaction list': return await context.listInteractions();
      case 'interaction respond': return await context.respondInteraction();
      case 'resource get': return await context.getResource();
      case 'observe': return await context.observe();
      case 'protocol trace': return await context.trace();
      default: throw new DebuggerError(2, 'unknown_command', 'Command is not supported. Use --help to list commands.', false);
    }
  } finally {
    context.close();
  }
}

class CommandContext {
  private readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly deadline: number;
  private readonly timeoutWasExplicit: boolean;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal = this.controller.signal;
  private readonly forwardInterruption: () => void;
  private readonly deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly invocation: ParsedInvocation,
    private readonly io: DebuggerIo,
    private readonly environment: CliEnvironment,
    private readonly parentSignal: AbortSignal,
  ) {
    this.environmentVariables = environment.environment ?? process.env;
    this.timeoutMs = parseTimeout(option(invocation, 'timeout'));
    this.deadline = Date.now() + this.timeoutMs;
    this.timeoutWasExplicit = hasOption(invocation, 'timeout');
    this.forwardInterruption = () => this.abort(new DebuggerError(130, 'interrupted', 'Command was interrupted.', true));
    parentSignal.addEventListener('abort', this.forwardInterruption, { once: true });
    if (parentSignal.aborted) this.forwardInterruption();
    this.deadlineTimer = this.timeoutWasExplicit
      ? setTimeout(() => this.abort(new DebuggerError(5, 'command_timeout', 'Command timed out.', true)), this.timeoutMs)
      : undefined;
  }

  close(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.parentSignal.removeEventListener('abort', this.forwardInterruption);
  }

  async listProviders(): Promise<void> {
    this.validateOptions('relay', 'timeout', 'format', 'json');
    this.requireFormat('text', 'json');
    this.requirePositionals(0);
    const providers = await this.withHttp((transport, options) => transport.listProviders(options));
    this.result(providers);
  }

  async createSession(): Promise<void> {
    this.validateOptions('relay', 'timeout', 'format', 'json', 'provider', 'provider-session-id', 'cwd', 'model', 'reasoning-effort', 'system-prompt', 'planning');
    this.requireFormat('text', 'json');
    const agentId = this.agentId();
    const providerId = requiredOption(this.invocation, 'provider');
    const config: AgentSessionConfig = {
      sessionId: stringOption(this.invocation, 'provider-session-id') ?? agentId,
      ...optionalConfig(this.invocation),
    };
    this.requirePositionals(1);
    this.result(await this.withHttp((transport, options) => transport.createAgent(agentId, providerId, config, options)));
  }

  async resumeSession(): Promise<void> {
    this.validateOptions('relay', 'timeout', 'format', 'json', 'persistence-file');
    this.requireFormat('text', 'json');
    const agentId = this.agentId();
    const value = await this.readJson(requiredOption(this.invocation, 'persistence-file'));
    if (!isPersistence(value)) throw new DebuggerError(2, 'invalid_persistence_handle', 'Persistence input must be an exact AgentPersistenceHandle.', false);
    this.requirePositionals(1);
    this.result(await this.withHttp((transport, options) => transport.resumeAgent(agentId, value, options)));
  }

  async inspect(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json');
    this.requireFormat('text', 'json');
    this.requirePositionals(1);
    await this.withRuntime(this.agentId(), undefined, async (runtime) => this.result(runtime.replica.getState()));
  }

  async timeline(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json', 'jsonl', 'tail', 'all', 'follow', 'until');
    const follow = hasOption(this.invocation, 'follow');
    if (!follow && hasOption(this.invocation, 'until')) {
      throw new DebuggerError(2, 'option_not_supported', 'Option --until requires --follow for timeline.', false);
    }
    if (follow) this.requireFormat('text', 'jsonl');
    else this.requireFormat('text', 'json');
    const all = hasOption(this.invocation, 'all');
    const tail = optionNumber(this.invocation, 'tail');
    this.requirePositionals(1);
    if (all && tail !== undefined) throw new DebuggerError(2, 'timeline_limit_ambiguous', 'Provide either --all or --tail, not both.', false);
    await this.withRuntime(this.agentId(), 'history', async (runtime) => {
      if (all) while (runtime.replica.getState().timeline.hasOlder) await this.withinDeadline(() => runtime.client.loadOlder());
      if (!follow) {
        const timeline = runtime.replica.getState().timeline;
        const entries = tail === undefined ? timeline.entries : timeline.entries.slice(-tail);
        this.result({ epoch: timeline.epoch, nextSeq: timeline.nextSeq, hasOlder: timeline.hasOlder, entries });
        return;
      }
      this.emitTimelineBaseline(runtime, tail);
      let baseline = true;
      const dispose = observeReplica(this.agentId(), runtime.replica, runtime.client, (record) => {
        if (baseline) return;
        if (record.kind === 'timeline_reset' || record.kind === 'timeline_upsert' || record.kind === 'checkpoint') this.streamFromObserver(record);
      });
      baseline = false;
      try {
        await this.waitUntilOrInterrupt(runtime, optionalCondition(this.invocation, 'until'));
      } finally {
        dispose();
      }
    });
  }

  async command(kind: 'send' | 'steer' | 'cancel'): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json', ...(kind === 'cancel' ? [] : ['file', 'wait']));
    this.requireFormat('text', 'json');
    const agentId = this.agentId();
    const capability = kind === 'send' ? 'sendMessage' : kind;
    const text = kind === 'cancel' ? undefined : await this.withinDeadline(() => readTextInput(
      this.invocation.positionals[1],
      stringOption(this.invocation, 'file'),
      this.io,
      this.signal,
    ));
    this.requirePositionals(kind === 'cancel' ? 1 : text === undefined ? 1 : Math.min(this.invocation.positionals.length, 2));
    const condition = optionalCondition(this.invocation, 'wait');
    await this.withRuntime(agentId, capability, async (runtime) => {
      const progress = condition ? runtime.captureProgress() : undefined;
      const acknowledgement = kind === 'send'
        ? await this.withinDeadline(() => runtime.client.sendMessage(text ?? ''))
        : kind === 'steer'
          ? await this.withinDeadline(() => runtime.client.steer(text ?? ''))
          : await this.withinDeadline(() => runtime.client.cancel());
      if (condition) await this.withinDeadline(() => runtime.waitFor(condition, this.remainingTimeout(), progress));
      this.result(acknowledgement);
    });
  }

  async setPlanning(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json');
    this.requireFormat('text', 'json');
    this.requirePositionals(2);
    const active = parsePlanning(this.invocation.positionals[1]);
    await this.withRuntime(this.agentId(), 'planning', async (runtime) => {
      this.result(await this.withinDeadline(() => runtime.client.setPlanning(active)));
    });
  }

  async wait(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json', 'for');
    this.requireFormat('text', 'json');
    const condition = requiredCondition(this.invocation, 'for');
    await this.withRuntime(this.agentId(), undefined, async (runtime) => {
      await this.withinDeadline(() => runtime.waitFor(condition, this.remainingTimeout()));
      this.result({ agentId: this.agentId(), condition });
    });
  }

  async listInteractions(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json');
    this.requireFormat('text', 'json');
    this.requirePositionals(1);
    await this.withRuntime(this.agentId(), undefined, async (runtime) => this.result(runtime.replica.getState().pendingInteractions));
  }

  async respondInteraction(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json', 'response-file');
    this.requireFormat('text', 'json');
    const agentId = this.agentId();
    const requestId = this.invocation.positionals[1];
    if (!requestId) throw new DebuggerError(2, 'interaction_request_required', 'An interaction request ID is required.', false);
    this.requirePositionals(2);
    const value = await this.readJson(requiredOption(this.invocation, 'response-file'));
    if (!isInteractionResponse(value)) throw new DebuggerError(2, 'invalid_interaction_response', 'Response input must be an exact AgentInteractionResponse.', false);
    await this.withRuntime(agentId, undefined, async (runtime) => {
      const request = runtime.replica.getState().pendingInteractions.find((pending) => pending.requestId === requestId);
      if (!request) throw new DebuggerError(4, 'interaction_stale', 'Interaction request is no longer pending.', true);
      if (request.kind !== value.kind) throw new DebuggerError(4, 'interaction_response_kind_mismatch', 'Response kind does not match the pending interaction.', false);
      runtime.requireCapability(`interactions.${interactionCapability(request.kind)}`);
      this.result(await this.withinDeadline(() => runtime.client.respondToInteraction(requestId, value)));
    });
  }

  async getResource(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'json', 'output');
    this.requireFormat('text', 'json');
    const agentId = this.agentId();
    const resourceId = this.invocation.positionals[1];
    if (!resourceId) throw new DebuggerError(2, 'resource_id_required', 'A resource ID is required.', false);
    this.requirePositionals(2);
    const output = requiredOption(this.invocation, 'output');
    if (output === '-' && this.invocation.format === 'json') {
      throw new DebuggerError(2, 'binary_json_incompatible', 'Resource output to stdout cannot be combined with --json.', false);
    }
    await this.withRuntime(agentId, 'readResource', async (runtime) => {
      const response = await this.readResource(runtime, resourceId);
      const state = response.payload.state;
      if (state.status === 'failed' || state.status === 'unavailable') throw resourceError(state);
      if (state.status !== 'available') throw new DebuggerError(4, 'resource_response_pending', 'Resource response remained pending.', true);
      const bytes = new Uint8Array(Buffer.from(state.contentBase64, 'base64'));
      if (bytes.byteLength !== state.byteLength) throw new DebuggerError(4, 'resource_length_mismatch', 'Resource content length did not match the Relay response.', false);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== state.sha256.toLowerCase()) throw new DebuggerError(4, 'resource_sha256_mismatch', 'Resource content SHA-256 did not match the Relay response.', false);
      const metadata = { resourceId, mediaType: state.mediaType, byteLength: state.byteLength, sha256: state.sha256, output };
      if (output === '-') {
        writeBinary(this.io, bytes, true);
      } else {
        await this.writeFile(output, bytes);
      }
      if (this.invocation.format === 'json') writeJson(this.io, metadata);
      else writeJsonToStderr(this.io, metadata);
    });
  }

  async observe(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'jsonl', 'until');
    this.requireFormat('text', 'jsonl');
    this.requirePositionals(1);
    const condition = optionalCondition(this.invocation, 'until');
    await this.withRuntime(this.agentId(), undefined, async (runtime) => {
      const dispose = observeReplica(this.agentId(), runtime.replica, runtime.client, (record) => this.streamFromObserver(record));
      try {
        await this.waitUntilOrInterrupt(runtime, condition);
      } finally {
        dispose();
      }
    });
  }

  async trace(): Promise<void> {
    this.validateOptions('relay', 'origin', 'timeout', 'format', 'jsonl', 'until');
    this.requireFormat('text', 'jsonl');
    this.requirePositionals(1);
    const agentId = this.agentId();
    const condition = optionalCondition(this.invocation, 'until');
    await this.withRuntime(
      agentId,
      undefined,
      async (runtime) => {
        const dispose = observeReplica(agentId, runtime.replica, runtime.client, (record) => {
          if (record.kind === 'diagnostic') this.streamFromObserver(record);
        });
        try {
          await this.waitUntilOrInterrupt(runtime, condition);
        } finally {
          dispose();
        }
      },
      (observation) => this.streamFromObserver(createProtocolTraceRecord(agentId, observation)),
      (diagnostic) => this.streamFromObserver({
        schemaVersion: '1.1.0',
        timestamp: new Date().toISOString(),
        agentId,
        kind: 'diagnostic',
        diagnostic: { code: diagnostic.code, message: diagnostic.message, recoverable: diagnostic.recoverable },
      }),
    );
  }

  private async readResource(runtime: DebuggerRuntime, resourceId: string): Promise<ResourceResponse> {
    while (true) {
      this.throwIfInterrupted();
      const response = await this.withinDeadline(() => runtime.client.requestResource(resourceId));
      const state = response.payload.state;
      if (state.status !== 'pending') return response;
      await this.withinDeadline(() => delay(Math.min(state.retryAfterMs, this.remainingTimeout()), this.signal));
    }
  }

  private emitTimelineBaseline(runtime: DebuggerRuntime, tail: number | undefined): void {
    const timeline = runtime.replica.getState().timeline;
    const timestamp = new Date().toISOString();
    const recordBase = { schemaVersion: '1.1.0' as const, timestamp, agentId: this.agentId() };
    this.stream({ ...recordBase, kind: 'timeline_reset', previousEpoch: null, epoch: timeline.epoch });
    if (timeline.epoch) {
      const entries = tail === undefined ? timeline.entries : timeline.entries.slice(-tail);
      for (const entry of entries) this.stream({ ...recordBase, kind: 'timeline_upsert', epoch: timeline.epoch, entry });
    }
    this.stream({ ...recordBase, kind: 'checkpoint', epoch: timeline.epoch, nextSeq: timeline.nextSeq, hasOlder: timeline.hasOlder, bufferedLive: timeline.pendingLive.length });
  }

  private async withRuntime(
    agentId: string,
    capability: Parameters<DebuggerRuntime['requireCapability']>[0] | undefined,
    action: (runtime: DebuggerRuntime) => Promise<void>,
    protocolObserver?: DebuggerRuntimeOptions['protocolObserver'],
    preflightDiagnosticObserver?: DebuggerRuntimeOptions['preflightDiagnosticObserver'],
  ): Promise<void> {
    this.throwIfInterrupted();
    const runtime = await this.withinDeadline(() => (this.environment.createRuntime ?? createDebuggerRuntime)(agentId, {
      relayUrl: resolveRelayUrl(stringOption(this.invocation, 'relay'), this.environmentVariables),
      origin: resolveOrigin(stringOption(this.invocation, 'origin'), this.environmentVariables),
      environment: this.environmentVariables,
      operationTimeoutMs: this.remainingTimeout(),
      signal: this.signal,
      protocolObserver,
      preflightDiagnosticObserver,
    }), true, (lateRuntime) => lateRuntime.close());
    try {
      await this.withinDeadline(() => runtime.ready(this.remainingTimeout()));
      this.throwIfInterrupted();
      if (capability) runtime.requireCapability(capability);
      await action(runtime);
    } finally {
      runtime.close();
    }
  }

  private httpTransport(): SessionTransport {
    const relayUrl = resolveRelayUrl(stringOption(this.invocation, 'relay'), this.environmentVariables);
    return this.environment.createHttpTransport?.(relayUrl) ?? new HttpWebSocketTransport(relayUrl);
  }

  private async withHttp<T>(operation: (transport: SessionTransport, options: { signal: AbortSignal }) => Promise<T>): Promise<T> {
    const transport = this.httpTransport();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.remainingTimeout());
    let diagnostic: { code: string; message: string; recoverable: boolean } | undefined;
    const unsubscribe = transport.onDiagnostic((value) => { diagnostic = value; });
    this.signal.addEventListener('abort', onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    try {
      const result = await operation(transport, { signal: controller.signal });
      if (this.signal.aborted) throw this.abortError();
      if (timedOut || Date.now() >= this.deadline) throw new DebuggerError(5, 'command_timeout', 'Command timed out.', true);
      return result;
    } catch (error) {
      if (error instanceof DebuggerError) throw error;
      if (this.signal.aborted) throw this.abortError();
      if (timedOut) throw new DebuggerError(5, 'command_timeout', 'Command timed out.', true);
      if (error instanceof RemoteOperationError) {
        throw new DebuggerError(4, error.code, error.message, error.recoverable);
      }
      if (diagnostic?.code === 'invalid_wire_body') {
        throw new DebuggerError(4, diagnostic.code, diagnostic.message, diagnostic.recoverable);
      }
      if (diagnostic) throw new DebuggerError(3, diagnostic.code, diagnostic.message, diagnostic.recoverable);
      throw new DebuggerError(4, 'invalid_public_response', 'Relay response did not match the requested public protocol response.', true);
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  private agentId(): string {
    const agentId = this.invocation.positionals[0];
    if (!agentId) throw new DebuggerError(2, 'agent_id_required', 'An agent ID is required.', false);
    return agentId;
  }

  private requirePositionals(count: number): void {
    if (this.invocation.positionals.length !== count) throw new DebuggerError(2, 'invalid_arguments', 'Unexpected positional arguments.', false);
  }

  private validateOptions(...allowed: string[]): void {
    for (const optionName of this.invocation.options.keys()) {
      if (!allowed.includes(optionName)) {
        throw new DebuggerError(2, 'option_not_supported', `Option --${optionName} is not supported by this command.`, false);
      }
    }
  }

  private requireFormat(...allowed: OutputFormat[]): void {
    if (!allowed.includes(this.invocation.format)) {
      throw new DebuggerError(2, 'invalid_output_format', `This command supports ${allowed.join(' or ')} output.`, false);
    }
  }

  private result(value: unknown): void {
    if (this.invocation.format === 'json') return writeJson(this.io, value);
    writeText(this.io, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  }

  private stream(value: unknown): void {
    if (this.invocation.format === 'jsonl') return writeJson(this.io, value);
    writeText(this.io, `${JSON.stringify(value)}\n`);
  }

  private streamFromObserver(value: unknown): void {
    try {
      this.stream(value);
    } catch (error) {
      this.abort(error instanceof DebuggerError
        ? error
        : new DebuggerError(2, 'output_write_failed', 'Local output could not be written.', false));
    }
  }

  private async readJson(path: string): Promise<unknown> {
    const input = await this.withinDeadline(async () => {
      try {
        return path === '-' ? await this.io.stdin(this.signal) : await this.io.readFile(path, { signal: this.signal });
      } catch (error) {
        if (this.signal.aborted) throw this.signal.reason ?? error;
        throw new DebuggerError(2, 'input_file_unreadable', 'Input file could not be read.', false);
      }
    });
    return parseExactJson(input);
  }

  private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.remainingTimeout());
    const onAbort = () => controller.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    try {
      const operation = this.environment.writeFile
        ? this.environment.writeFile(path, bytes, { signal: controller.signal })
        : writeFileAtomically(path, bytes, controller.signal);
      await operation;
      if (this.signal.aborted) throw this.abortError();
      if (controller.signal.aborted) throw new DebuggerError(5, 'command_timeout', 'Command timed out.', true);
    } catch (error) {
      if (this.signal.aborted) throw this.abortError();
      if (controller.signal.aborted) throw new DebuggerError(5, 'command_timeout', 'Command timed out.', true);
      if (error instanceof DebuggerError) throw error;
      throw new DebuggerError(2, 'output_file_write_failed', 'Resource destination could not be written.', false);
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  private async waitUntilOrInterrupt(runtime: DebuggerRuntime, condition: WaitCondition | undefined): Promise<void> {
    if (condition) return this.withinDeadline(() => runtime.waitFor(condition, this.remainingTimeout()));
    await this.withinDeadline(() => new Promise<void>(() => undefined), this.timeoutWasExplicit);
  }

  private withinDeadline<T>(operation: () => Promise<T>, bounded = true, retireLateValue?: (value: T) => void | Promise<void>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.abortError());
    const timeoutMs = bounded ? this.remainingTimeout() : undefined;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: DebuggerError, value?: T) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value as T);
      };
      const onAbort = () => finish(this.abortError());
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.abort(new DebuggerError(5, 'command_timeout', 'Command timed out.', true));
      }, timeoutMs);
      const rejectWith = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
      let pending: Promise<T>;
      try {
        pending = operation();
      } catch (error) {
        rejectWith(error);
        return;
      }
      pending.then((value) => {
        if (settled) {
          if (retireLateValue) void Promise.resolve(retireLateValue(value)).catch(() => undefined);
          return;
        }
        finish(undefined, value);
      }, rejectWith);
      if (this.signal.aborted) onAbort();
    });
  }

  private remainingTimeout(): number {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new DebuggerError(5, 'command_timeout', 'Command timed out.', true);
    return remaining;
  }

  private throwIfInterrupted(): void {
    if (this.signal.aborted) throw this.abortError();
  }

  private abort(error: DebuggerError): void {
    if (!this.signal.aborted) this.controller.abort(error);
  }

  private abortError(): DebuggerError {
    return this.signal.reason instanceof DebuggerError
      ? this.signal.reason
      : new DebuggerError(130, 'interrupted', 'Command was interrupted.', true);
  }
}

function optionalConfig(invocation: ParsedInvocation): Omit<AgentSessionConfig, 'sessionId'> {
  return {
    ...(stringOption(invocation, 'cwd') ? { cwd: stringOption(invocation, 'cwd') } : {}),
    ...(stringOption(invocation, 'model') ? { model: stringOption(invocation, 'model') } : {}),
    ...(stringOption(invocation, 'reasoning-effort') ? { reasoningEffort: stringOption(invocation, 'reasoning-effort') } : {}),
    ...(stringOption(invocation, 'system-prompt') !== undefined ? { systemPrompt: stringOption(invocation, 'system-prompt') } : {}),
    ...(hasOption(invocation, 'planning') ? { planning: parsePlanning(stringOption(invocation, 'planning')) } : {}),
  };
}

function parsePlanning(value: string | undefined): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new DebuggerError(2, 'invalid_planning', 'Planning must be on or off.', false);
}

function isPersistence(value: unknown): value is AgentPersistenceHandle {
  return typeof value === 'object' && value !== null
    && typeof (value as { providerId?: unknown }).providerId === 'string'
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && typeof (value as { opaque?: unknown }).opaque === 'string'
    && (value as { providerId: string }).providerId.length > 0
    && (value as { sessionId: string }).sessionId.length > 0
    && (value as { opaque: string }).opaque.length > 0
    && Object.keys(value).length === 3;
}

function isInteractionResponse(value: unknown): value is AgentInteractionResponse {
  return encodeClientMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'interaction_response',
    payload: { agentId: 'validation-agent', requestId: 'validation-request', response: value as AgentInteractionResponse },
  }).status === 'ok';
}

function interactionCapability(kind: 'question' | 'plan_approval' | 'tool_approval'): 'question' | 'planApproval' | 'toolApproval' {
  return kind === 'plan_approval' ? 'planApproval' : kind === 'tool_approval' ? 'toolApproval' : 'question';
}

function resourceError(state: Exclude<ResourceResponse['payload']['state'], { status: 'pending' } | { status: 'available' }>): DebuggerError {
  if (state.status === 'failed') return new DebuggerError(4, 'resource_failed', state.message, state.retryable);
  return new DebuggerError(4, 'resource_unavailable', state.reason, false);
}

function option(invocation: ParsedInvocation, name: string): string | undefined {
  const value = invocation.options.get(name);
  return value === true ? undefined : value;
}

function stringOption(invocation: ParsedInvocation, name: string): string | undefined {
  return option(invocation, name);
}

function hasOption(invocation: ParsedInvocation, name: string): boolean {
  return invocation.options.has(name);
}

function requiredOption(invocation: ParsedInvocation, name: string): string {
  const value = option(invocation, name);
  if (!value) throw new DebuggerError(2, `${name.replaceAll('-', '_')}_required`, `Option --${name} is required.`, false);
  return value;
}

function optionalCondition(invocation: ParsedInvocation, name: string): WaitCondition | undefined {
  const value = option(invocation, name);
  if (value === undefined) return undefined;
  if (value === 'idle' || value === 'interaction' || value === 'failed') return value;
  throw new DebuggerError(2, 'invalid_wait_condition', 'Wait condition must be idle, interaction, or failed.', false);
}

function requiredCondition(invocation: ParsedInvocation, name: string): WaitCondition {
  const value = optionalCondition(invocation, name);
  if (!value) throw new DebuggerError(2, 'wait_condition_required', `Option --${name} is required.`, false);
  return value;
}

function optionNumber(invocation: ParsedInvocation, name: string): number | undefined {
  const value = option(invocation, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new DebuggerError(2, 'invalid_number', `Option --${name} must be a positive integer.`, false);
  return number;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 10_000;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new DebuggerError(2, 'invalid_timeout', 'Option --timeout must be a positive integer in milliseconds.', false);
  return milliseconds;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(signal.reason instanceof DebuggerError
      ? signal.reason
      : new DebuggerError(130, 'interrupted', 'Command was interrupted.', true));
    const finish = (error?: DebuggerError) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
