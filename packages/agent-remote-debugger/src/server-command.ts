import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadAdapter } from './load-adapter.js';
import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import type { ParsedInvocation } from './commands.js';
import type { DebuggerIo } from './output.js';
import { DebuggerError } from './errors.js';
import { createDebuggerServer } from './server.js';
import { createDebuggerRuntime, type DebuggerRuntime } from './runtime.js';
import { openBrowser } from './local-web.js';
import { observeReplica } from './records.js';

export async function runServerCommand(invocation: ParsedInvocation, io: DebuggerIo, signal: AbortSignal): Promise<void> {
  const allowed = new Set(['provider', 'adapter', 'cwd', 'model', 'reasoning-effort', 'executable', 'port', 'open', 'jsonl', 'format', 'persistence-file', 'timeout']);
  for (const option of invocation.options.keys()) if (!allowed.has(option)) throw usage(`Option --${option} is not supported by server.`);
  if (invocation.positionals.length || invocation.format === 'json') throw usage('server accepts no positional arguments; use text or jsonl output.');
  const get = (name: string): string | undefined => { const value = invocation.options.get(name); return typeof value === 'string' ? value : undefined; };
  const provider = get('provider'); const module = get('adapter');
  if (!provider && !module) {
    const { runReplayCommand } = await import('./replay-command.js');
    return runReplayCommand(invocation, io, signal);
  }
  if (!!provider === !!module) throw usage('Select exactly one --provider codex|claude|copilot or --adapter FILE.');
  const port = Number(get('port') ?? 0);
  if (!/^\d+$/.test(get('port') ?? '0') || !Number.isInteger(port) || port < 0 || port > 65535) throw usage('--port must be between 0 and 65535.');
  const startupTimeout = Number(get('timeout') ?? 30000);
  if (!Number.isSafeInteger(startupTimeout) || startupTimeout < 1 || startupTimeout > 2147483647) throw usage('--timeout must be a positive startup deadline in milliseconds.');
  if (module && get('executable')) throw usage('--executable is only supported with built-in providers.');
  let persistence: AgentPersistenceHandle | undefined;
  if (get('persistence-file')) {
    if (['cwd', 'model', 'reasoning-effort'].some(key => get(key))) throw usage('Resume uses the persistence handle; do not supply creation settings.');
    let value: unknown;
    try { value = JSON.parse(await readFile(resolve(get('persistence-file')!), 'utf8')); }
    catch { throw usage('Cannot read valid JSON from --persistence-file.'); }
    if (!value || typeof value !== 'object' || !['providerId', 'sessionId', 'opaque'].every(key => typeof (value as Record<string, unknown>)[key] === 'string') || Object.keys(value).length !== 3) throw usage('Expected an AgentPersistenceHandle in --persistence-file.');
    persistence = value as AgentPersistenceHandle;
  }
  const emit = (record: Record<string, unknown>) => {
    if (invocation.format === 'jsonl') io.stdout(`${JSON.stringify(record)}\n`);
    else io.stdout(`${String(record.kind)} ${JSON.stringify(record)}\n`);
  };
  const adapter = await loadAdapter(provider, module, get('executable'));
  let server: Awaited<ReturnType<typeof createDebuggerServer>> | undefined;
  let observer: DebuggerRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  const startup = new AbortController();
  const onTerm = () => { startup.abort(); stop(); };
  let stop = () => {};
  const stopped = new Promise<void>(done => { stop = done; });
  process.once('SIGTERM', onTerm);
  signal.addEventListener('abort', onTerm, { once: true });
  if (signal.aborted) onTerm();
  let transferred = false;
  const deadline = setTimeout(() => startup.abort(new Error(`Provider startup timed out after ${startupTimeout} milliseconds.`)), startupTimeout);
  try {
    if (signal.aborted) return;
    transferred = true;
    server = await createDebuggerServer({ adapter, signal: startup.signal, port, persistence, config: { cwd: resolve(get('cwd') ?? process.cwd()), model: get('model'), reasoningEffort: get('reasoning-effort') }, onBrowserEvent: emit });
    const { url, agentId } = server;
    emit({ kind: 'recording_start', schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId });
    observer = await createDebuggerRuntime(agentId, { relayUrl: url, origin: url, signal: startup.signal });
    unsubscribe = observeReplica(agentId, observer.replica, observer.client, record => emit({ ...record, source: 'relay' }));
    await observer.ready(startupTimeout);
    clearTimeout(deadline);
    emit({ kind: 'server_ready', url, agentId, providerId: adapter.descriptor.providerId, nativeSessionId: server.session.nativeSessionId,
      commands: { observe: `ardb observe ${agentId} --relay ${url} --origin ${url} --jsonl`, inspect: `ardb inspect ${agentId} --relay ${url} --origin ${url}`, send: `ardb send ${agentId} "hello" --relay ${url} --origin ${url}` } });
    if (invocation.options.has('open')) {
      try { await openBrowser(url); } catch { io.stderr(`Browser could not be opened; visit ${url} manually.\n`); }
    }
    await stopped;
  } catch (error) {
    if (startup.signal.aborted && !signal.aborted && startup.signal.reason?.message?.includes('timed out')) throw new DebuggerError(5, 'server_start_timeout', startup.signal.reason.message, true);
    if (!startup.signal.aborted) throw error instanceof DebuggerError ? error : new DebuggerError(3, 'server_start_failed', `ARDB server failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', onTerm); process.removeListener('SIGTERM', onTerm);
    unsubscribe?.(); observer?.close();
    if (server) {
      await server.close();
      emit({ kind: 'recording_end', schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId: server.agentId });
    }
    else if (!transferred) await adapter.dispose?.();
  }
}

function usage(message: string) { return new DebuggerError(2, 'invalid_server_options', message, false); }
