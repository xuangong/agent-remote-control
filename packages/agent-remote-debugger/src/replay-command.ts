import { readRecordingFile } from './recording-files.js';
import { basename, dirname, resolve } from 'node:path';
import type { ParsedInvocation } from './commands.js';
import type { DebuggerIo } from './output.js';
import { DebuggerError } from './errors.js';
import { openBrowser } from './local-web.js';
import { createReplayServer } from './replay-server.js';

export async function runReplayCommand(invocation: ParsedInvocation, io: DebuggerIo, signal: AbortSignal) {
  const fail = (message: string): never => { throw new DebuggerError(2, 'invalid_recording', message, false); };
  for (const option of invocation.options.keys()) if (!['port', 'open', 'json', 'jsonl', 'format'].includes(option)) fail(`Option --${option} is not supported by replay.`);
  if (invocation.positionals.length !== 1) fail('Usage: ardb replay session.jsonl [--open] [--port 0]');
  const port = String(invocation.options.get('port') ?? '0');
  if (!/^\d+$/.test(port) || Number(port) > 65535) fail('--port must be between 0 and 65535.');
  const path = resolve(invocation.positionals[0]!);
  const recording = await readRecordingFile(path).catch(error => fail(`Cannot replay ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`));
  let stop = () => {};
  const stopped = new Promise<void>(done => { stop = done; });
  process.once('SIGTERM', stop); signal.addEventListener('abort', stop, { once: true });
  let server: Awaited<ReturnType<typeof createReplayServer>> | undefined;
  try {
    if (signal.aborted) return;
    server = await createReplayServer({ recording, name: basename(path), directory: dirname(path), port: Number(port) });
    const ready = { kind: 'replay_ready', url: server.url, file: path, durationMs: recording.duration, warnings: recording.warnings };
    io.stdout(invocation.format === 'text' ? `Replay ${basename(path)}: ${server.url}\n${recording.warnings.map(w => `Note: ${w}\n`).join('')}` : `${JSON.stringify(ready)}\n`);
    if (invocation.options.has('open')) {
      try { await openBrowser(server.url); } catch { io.stderr(`Browser could not be opened; visit ${server.url} manually.\n`); }
    }
    await stopped;
  } finally {
    process.removeListener('SIGTERM', stop); signal.removeEventListener('abort', stop);
    await server?.close();
  }
}
