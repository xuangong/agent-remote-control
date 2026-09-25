import { inspectWindowsCodexWriter } from './platform/windows/session-writer.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectUnixCodexWriter, type CodexWriterProcess } from './platform/unix/session-writer.js';

export class CodexSessionTakeoverError extends Error {
  constructor(readonly code: 'native_owner_changed' | 'native_handoff_unknown', message: string) { super(message); }
}
export interface CodexSessionOwner { generation: string }
interface Writer extends CodexWriterProcess, CodexSessionOwner {}
export interface CodexWriterOperations {
  inspect(lockPath: string): Promise<CodexWriterProcess | undefined>;
  signal(pid: number): void;
}
const operations: CodexWriterOperations = {
  inspect: process.platform === 'win32' ? inspectWindowsCodexWriter : inspectUnixCodexWriter,
  signal: pid => { process.kill(pid, 'SIGTERM'); },
};

/** The confirmation is bound to both the native lock inode and the process incarnation. */
export class CodexSessionTakeover {
  constructor(private readonly home: string, private readonly ops = operations,
    private readonly onDiagnostic?: (line: string) => void, private readonly releaseTimeoutMs = 5000) {}

  private async writer(sessionId: string): Promise<Writer | undefined> {
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(sessionId)) return;
    if (this.ops === operations && !['darwin', 'linux', 'win32'].includes(process.platform)) return;
    const writer = await this.ops.inspect(join(this.home, 'thread-writer-locks', `${sessionId}.lock`));
    if (!writer) return;
    const hash = createHash('sha256').update(JSON.stringify([sessionId, writer.identity])).digest('hex');
    const generation = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return {...writer, generation};
  }
  async inspect(sessionId: string): Promise<CodexSessionOwner | undefined> {
    try { const writer = await this.writer(sessionId); return writer ? {generation: writer.generation} : undefined; }
    catch { return undefined; }
  }
  async release(sessionId: string, generation: string): Promise<void> {
    const writer = await this.writer(sessionId).catch(() => undefined);
    if (!writer || writer.generation !== generation) throw new CodexSessionTakeoverError('native_owner_changed', 'The Codex writer changed or cannot be verified. Check the session before taking over again.');
    this.diagnose('codex_takeover_started', sessionId, generation);
    try {
      this.ops.signal(writer.pid);
      const deadline = Date.now() + this.releaseTimeoutMs;
      while (Date.now() < deadline) {
        await delay(50);
        // Only the subsequent native thread/resume can authoritatively confirm release.
        const current = await this.writer(sessionId).catch(() => undefined);
        if (!current) { this.diagnose('codex_takeover_release_requested', sessionId, generation); return; }
        if (current.generation !== generation) throw new CodexSessionTakeoverError('native_owner_changed', 'Another Codex writer acquired this session during takeover.');
      }
      throw new Error('The original process has not released its session.');
    } catch (error) {
      this.diagnose('codex_takeover_failed', sessionId, generation);
      if (error instanceof CodexSessionTakeoverError) throw error;
      throw new CodexSessionTakeoverError('native_handoff_unknown', 'Codex release was not confirmed. Check the session before retrying.');
    }
  }
  private diagnose(event: string, sessionId: string, generation: string): void {
    try { this.onDiagnostic?.(JSON.stringify({event, providerId: 'codex', sessionId, generation, at: new Date().toISOString()})); } catch {}
  }
}
