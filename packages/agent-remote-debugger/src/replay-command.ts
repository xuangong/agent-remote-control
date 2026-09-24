import { readRecordingFile } from './recording-files.js';
import { basename, dirname, resolve } from 'node:path';
import type { ParsedInvocation } from './commands.js';
import type { DebuggerIo } from './output.js';
import { DebuggerError } from './errors.js';
import { openBrowser } from './local-web.js';
import { createDebuggerRuntime, type DebuggerRuntime } from './runtime.js';
import { observeReplica } from './records.js';
import { createReplayServer } from './replay-server.js';

export async function runReplayCommand(invocation: ParsedInvocation, io: DebuggerIo, signal: AbortSignal) {
  const fail = (message: string): never => { throw new DebuggerError(2, 'invalid_recording', message, false); };
  const workspace = invocation.path[0] === 'server';
  for (const option of invocation.options.keys()) if (!['port', 'open', 'json', 'jsonl', 'format', ...(workspace ? ['cwd', 'executable', 'timeout'] : [])].includes(option)) fail(`Option --${option} is not supported by replay.`);
  if (invocation.positionals.length !== (workspace ? 0 : 1)) fail('Usage: ardb replay session.jsonl [--open] [--port 0]');
  const port = String(invocation.options.get('port') ?? '0');
  if (!/^\d+$/.test(port) || Number(port) > 65535) fail('--port must be between 0 and 65535.');
  const path = workspace ? undefined : resolve(invocation.positionals[0]!);
  const recording = path ? await readRecordingFile(path).catch(error => fail(`Cannot replay ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`)) : undefined;
  const directory = path ? dirname(path) : resolve(String(invocation.options.get('cwd') ?? process.cwd()));
  const executable = invocation.options.get('executable') as string | undefined;
  const timeout = Number(invocation.options.get('timeout') ?? 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) fail('--timeout must be a positive startup deadline in milliseconds.');
  let stop = () => {};
  const stopped = new Promise<void>(done => { stop = done; });
  process.once('SIGTERM', stop); signal.addEventListener('abort', stop, { once: true });
  let observer: DebuggerRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  let liveAgentId: string | undefined;
  const emit = (record: Record<string, unknown>) => { if (invocation.format === 'jsonl') io.stdout(`${JSON.stringify(record)}\n`); };
  let server: Awaited<ReturnType<typeof createReplayServer>> | undefined;
  try {
    if (signal.aborted) return;
    server = await createReplayServer({ recording, name: path ? basename(path) : undefined, directory, port: Number(port), executable, startupTimeout: timeout,
      onBrowserEvent: emit,
      async onLiveReady(live) {
        if (invocation.format !== 'jsonl') return;
        observer = await createDebuggerRuntime(live.agentId, { relayUrl: live.url, origin: live.url, signal });
        try { await observer.ready(timeout); } catch (error) { observer.close(); observer = undefined; throw error; }
        liveAgentId = live.agentId;
        emit({ kind: 'recording_start', schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId: liveAgentId });
        unsubscribe = observeReplica(live.agentId, observer.replica, observer.client, record => emit({ ...record, source: 'relay' }));
        emit({ kind: 'server_ready', mode: 'live', url: live.url, ...live.session });
      },
    });
    const ready = { kind: workspace || invocation.format === 'jsonl' ? 'server_ready' : 'replay_ready', mode: workspace ? 'workspace' : 'replay', url: server.url, file: path, durationMs: recording?.duration, warnings: recording?.warnings };
    io.stdout(invocation.format === 'text' ? `ARDB${path ? ` replay ${basename(path)}` : ''}: ${server.url}\n${recording?.warnings.map(w => `Note: ${w}\n`).join('') ?? ''}` : `${JSON.stringify(ready)}\n`);
    if (invocation.options.has('open')) {
      try { await openBrowser(server.url); } catch { io.stderr(`Browser could not be opened; visit ${server.url} manually.\n`); }
    }
    await stopped;
  } finally {
    process.removeListener('SIGTERM', stop); signal.removeEventListener('abort', stop);
    unsubscribe?.(); observer?.close();
    await server?.close();
    if (liveAgentId) emit({ kind: 'recording_end', schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId: liveAgentId });
  }
}
