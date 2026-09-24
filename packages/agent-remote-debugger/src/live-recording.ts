import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDebuggerRuntime, type DebuggerRuntime } from './runtime.js';
import { observeReplica } from './records.js';

export interface CaptureStatus {
  phase: 'idle' | 'starting' | 'recording' | 'stopped' | 'failed';
  id?: string;
  startedAt?: string;
  stoppedAt?: string;
  records: number;
  bytes: number;
  error?: string;
}

/** A process-local recording subscribes through the same public channel as any CLI client. */
export class LiveRecording {
  private state: CaptureStatus = { phase: 'idle', records: 0, bytes: 0 };
  private lines: string[] = [];
  private runtime?: DebuggerRuntime;
  private unsubscribe?: () => void;
  private abort?: AbortController;
  private baseline = false;
  private closed = false;
  constructor(private readonly agentId: string, private readonly url: () => string, private readonly limit = 64 * 1024 * 1024) {}
  status(): CaptureStatus { return { ...this.state }; }
  async start(previousId?: string): Promise<CaptureStatus> {
    if (this.closed || this.state.phase === 'recording' || this.state.phase === 'starting' || this.state.id !== previousId) throw new Error('Recording changed. Refresh its status before starting another recording.');
    this.state = { phase: 'starting', id: randomUUID(), records: 0, bytes: 0 };
    this.lines = []; this.baseline = false;
    const abort = this.abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Recording connection timed out.')), 10000);
    try {
      this.runtime = await createDebuggerRuntime(this.agentId, { observeOnly: true, relayUrl: this.url(), origin: this.url(), signal: abort.signal });
      await this.runtime.ready(10000);
      abort.signal.throwIfAborted();
      this.state.phase = 'recording'; this.state.startedAt = new Date().toISOString();
      this.append(this.marker('recording_start'));
      const unsubscribe = observeReplica(this.agentId, this.runtime.replica, this.runtime.client, record => {
        this.append({ ...record, source: 'relay' });
        if (record.kind === 'checkpoint' && this.state.phase === 'recording') this.baseline = true;
      });
      this.unsubscribe = unsubscribe;
      if (this.state.phase !== 'recording') { unsubscribe(); throw new Error(this.state.error); }
      return this.status();
    } catch (error) {
      this.state.phase = 'failed';
      this.state.error = error instanceof Error ? error.message : 'Unable to start recording.';
      this.release();
      return this.status();
    } finally { clearTimeout(timer); }
  }
  append(record: Record<string, unknown>) {
    if (this.state.phase !== 'recording') return;
    const line = `${JSON.stringify(record)}\n`;
    if (this.state.bytes + Buffer.byteLength(line) > this.limit - 1024) {
      this.state.error = 'Recording reached its size limit. Export it before starting another.';
      this.finish('size_limit'); return;
    }
    this.lines.push(line); this.state.records++; this.state.bytes += Buffer.byteLength(line);
  }
  stop(id: string): CaptureStatus {
    if (id !== this.state.id || !['recording', 'stopped'].includes(this.state.phase)) throw new Error('Recording changed. Refresh its status before stopping.');
    if (this.state.phase === 'recording') this.finish();
    return this.status();
  }
  export(id: string): string {
    if (id !== this.state.id || this.state.phase !== 'stopped' || !this.baseline) throw new Error('Stop this recording before exporting it.');
    return this.lines.join('');
  }
  close() { this.closed = true; if (this.state.phase === 'recording') this.finish(); this.release(); }
  private marker(kind: string) { return { kind, schemaVersion: '1.1.0', timestamp: new Date().toISOString(), agentId: this.agentId }; }
  private finish(reason?: 'size_limit') {
    this.state.phase = this.baseline ? 'stopped' : 'failed';
    this.state.stoppedAt = new Date().toISOString();
    const end = `${JSON.stringify({ ...this.marker('recording_end'), ...(reason ? { reason } : {}) })}\n`;
    this.lines.push(end); this.state.records++; this.state.bytes += Buffer.byteLength(end);
    this.release();
  }
  private release() { this.unsubscribe?.(); this.unsubscribe = undefined; this.abort?.abort(); this.runtime?.close(); this.runtime = undefined; }
}

export async function readLocalJson(request: IncomingMessage, url: string): Promise<Record<string, unknown>> {
  if (request.headers.origin !== url || request.headers['content-type'] !== 'application/json') throw Object.assign(new Error('A same-origin JSON request is required.'), { status: 403 });
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected an object.'), { status: 400 });
  return value as Record<string, unknown>;
}
function recordingError(response: ServerResponse, error: unknown) {
  response.writeHead((error as { status?: number }).status ?? 409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Recording request failed.' }));
}
export async function serveCapture(request: IncomingMessage, response: ServerResponse, url: string, capture: LiveRecording): Promise<boolean> {
  const target = new URL(request.url ?? '/', url);
  if (!['/__ardb/recording', '/__ardb/recording/start', '/__ardb/recording/stop', '/__ardb/recording/export'].includes(target.pathname)) return false;
  try {
    if (request.method === 'GET' && target.pathname.endsWith('/export')) {
      const id = target.searchParams.get('id') ?? '';
      const data = capture.export(id);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="session-${capture.status().id}.jsonl"` }).end(data);
    } else if (request.method === 'GET' && target.pathname === '/__ardb/recording') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(capture.status()));
    } else if (request.method === 'POST' && /\/(start|stop)$/.test(target.pathname)) {
      const body = await readLocalJson(request, url);
      const result = target.pathname.endsWith('/start') ? await capture.start(typeof body.previousId === 'string' ? body.previousId : undefined) : capture.stop(String(body.id ?? ''));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } else response.writeHead(405).end();
  } catch (error) { recordingError(response, error); }
  return true;
}
