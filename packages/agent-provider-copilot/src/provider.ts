import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { CopilotClient, RuntimeConnection, type SessionConfig } from '@github/copilot-sdk';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig } from '@borgee/agent-provider-sdk';
import { CopilotAgentSession } from './session.js';
import { deadline } from './channel.js';
export interface CopilotAgentProviderOptions { executable?: string; env?: Record<string, string | undefined>; requestTimeoutMs?: number; onDiagnostic?: (message: string) => void; nativeSessionConfig?: Pick<SessionConfig, 'provider' | 'skillDirectories'>; useLoggedInUser?: boolean; }
export interface CopilotSessionSummary { nativeSessionId: string; providerId: string; title: string; workspace?: string; createdAt: string; updatedAt: string; state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable'; }
export function resolveCopilotExecutable(): string {
  const packagePath = createRequire(import.meta.url).resolve('@github/copilot/package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {bin: {copilot: string}};
  return resolve(dirname(packagePath), manifest.bin.copilot);
}
export class CopilotAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'copilot', displayName: 'GitHub Copilot' };
  private readonly client: CopilotClient;
  private readonly sessions = new Map<string, CopilotAgentSession>();
  private readonly loading = new Set<string>();
  private started?: Promise<void>;
  private disposed = false;
  constructor(private readonly options: CopilotAgentProviderOptions = {}) {
    this.client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: options.executable ?? resolveCopilotExecutable() }), env: { ...process.env, ...options.env }, useLoggedInUser: options.useLoggedInUser });
  }
  private async ready(): Promise<void> {
    if (this.disposed) throw new Error('Copilot provider is disposed.');
    this.started ??= deadline(this.client.start(), this.options.requestTimeoutMs ?? 15000, 'Copilot startup');
    try { await this.started; } catch (error) {
      this.started = undefined; await this.client.forceStop(); throw error;
    }
  }
  async listSessions(): Promise<CopilotSessionSummary[]> {
    await this.ready();
    // Persisted metadata does not establish activity in another CLI server.
    return (await deadline(this.client.listSessions(), this.options.requestTimeoutMs ?? 15000, 'Copilot session discovery')).map(s => ({ nativeSessionId: s.sessionId, providerId: 'copilot', title: s.summary || 'Copilot session', workspace: s.context?.workingDirectory, createdAt: s.startTime.toISOString(), updatedAt: s.modifiedTime.toISOString(), state: 'unknown' }));
  }
  async createSession(config: AgentSessionConfig): Promise<CopilotAgentSession> {
    if (config.planning) throw new Error('Copilot planning controls are not supported.');
    const cwd = await realpath(config.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error('Copilot workspace must be a directory.');
    return this.open({ ...config, cwd, sessionId: randomUUID() }, false);
  }
  async resumeSession(handle: AgentPersistenceHandle): Promise<CopilotAgentSession> {
    if (handle.providerId !== 'copilot' || !handle.sessionId || /[\x00/\\]/u.test(handle.sessionId)) throw new Error('Invalid Copilot persistence handle.');
    let stored: unknown;
    try { stored = JSON.parse(handle.opaque); } catch { throw new Error('Invalid Copilot persistence configuration.'); }
    if (!stored || typeof stored !== 'object') throw new Error('Invalid Copilot persistence configuration.');
    const cwd = (stored as {cwd?: unknown}).cwd;
    return this.open({ sessionId: handle.sessionId, ...(typeof cwd === 'string' ? { cwd } : {}) }, true);
  }
  private async open(config: AgentSessionConfig, resume: boolean): Promise<CopilotAgentSession> {
    await this.ready();
    if (this.sessions.has(config.sessionId) || this.loading.has(config.sessionId)) throw new Error('Copilot session is already loaded.');
    this.loading.add(config.sessionId);
    try {
      let skillDirectories = this.options.nativeSessionConfig?.skillDirectories;
      if (!skillDirectories && config.cwd) {
        try {
          const discovery = await deadline(this.client.rpc.skills.getDiscoveryPaths({projectPaths: [config.cwd]}), this.options.requestTimeoutMs ?? 15000, 'Copilot skill discovery paths');
          skillDirectories = discovery.paths.map(entry => entry.path);
        } catch (error) { this.options.onDiagnostic?.(`Copilot skill discovery unavailable: ${String(error)}`); }
      }
      const options = {...this.options, nativeSessionConfig: {...this.options.nativeSessionConfig, skillDirectories}};
      const session = await CopilotAgentSession.open(this.client, config, resume, options, () => this.sessions.delete(config.sessionId));
      if (this.disposed) { await session.dispose(); throw new Error('Copilot provider is disposed.'); }
      this.sessions.set(config.sessionId, session); return session;
    } finally { this.loading.delete(config.sessionId); }
  }
  async openChildSession(parentNativeSessionId: string, nativeSessionId: string) {
    const parent = this.sessions.get(parentNativeSessionId);
    if (!parent) throw new Error('Copilot parent session is not loaded.');
    return parent.openChildSession(nativeSessionId);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    await Promise.allSettled([...this.sessions.values()].map(s => s.dispose()));
    try {
      const errors = await deadline(this.client.stop(), this.options.requestTimeoutMs ?? 15000, 'Copilot shutdown');
      if (errors.length) { await this.client.forceStop(); this.options.onDiagnostic?.('Copilot graceful shutdown reported errors; forced shutdown completed.'); }
    } catch (error) { await this.client.forceStop(); throw error; }
  }
}
