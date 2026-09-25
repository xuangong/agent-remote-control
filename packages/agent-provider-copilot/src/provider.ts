import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { CopilotClient, RuntimeConnection, type SessionConfig } from '@github/copilot-sdk';
import { AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { CopilotAgentSession } from './session.js';
import { deadline } from './channel.js';
export interface CopilotAgentProviderOptions { executable?: string; env?: Record<string, string | undefined>; requestTimeoutMs?: number; onDiagnostic?: (message: string) => void; nativeSessionConfig?: Pick<SessionConfig, 'provider' | 'skillDirectories' | 'mcpServers'>; useLoggedInUser?: boolean; }
export interface CopilotSessionSummary { nativeSessionId: string; providerId: string; title: string; workspace?: string; createdAt: string; updatedAt: string; state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable'; }
export function resolveCopilotExecutable(): string {
  const packagePath = createRequire(import.meta.url).resolve('@github/copilot/package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {bin: {copilot: string}};
  return resolve(dirname(packagePath), manifest.bin.copilot);
}
export class CopilotAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'copilot', displayName: 'GitHub Copilot' };
  readonly sessionRenameRequiresOpen = true;
  private readonly client: CopilotClient;
  private readonly sessions = new Map<string, CopilotAgentSession>();
  private readonly loading = new Set<string>();
  private started?: Promise<void>;
  private disposed = false;
  constructor(private readonly options: CopilotAgentProviderOptions = {}) {
    const executable = options.executable ?? resolveCopilotExecutable();
    const invocation = /\.(?:mjs|cjs)$/i.test(executable) ? {path: process.execPath, args: [executable]} : {path: executable};
    this.client = new CopilotClient({ connection: RuntimeConnection.forStdio(invocation), env: { ...process.env, ...options.env }, useLoggedInUser: options.useLoggedInUser });
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
  async readSessionTitle(sessionId: string): Promise<string | undefined> {
    if (!sessionId || /[\x00/\\]/u.test(sessionId)) throw new Error('Invalid Copilot session ID.');
    await this.ready();
    const session = this.sessions.get(sessionId);
    if (session) return (await deadline(session.rpc.name.get(), this.options.requestTimeoutMs ?? 15000, 'Read Copilot session name')).name ?? undefined;
    return (await deadline(this.client.getSessionMetadata(sessionId), this.options.requestTimeoutMs ?? 15000, 'Read Copilot session metadata'))?.summary;
  }
  validateSessionTitle(title: string): void {
    const name = title.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f"]/.test(name)) throw new Error('Enter a Copilot session name of up to 100 characters without control characters or double quotes.');
  }
  async renameSession(sessionId: string, title: string): Promise<string> {
    this.validateSessionTitle(title);
    const name = title.trim();
    const session = this.sessions.get(sessionId);
    if (!session || (await session.runtimeInfo()).status === 'closed') throw new Error('Open the Copilot session under managed ownership before renaming it.');
    if (await this.readSessionTitle(sessionId) === name) return name;
    await deadline(session.rpc.name.set({name}), this.options.requestTimeoutMs ?? 15000, 'Rename Copilot session');
    if (await this.readSessionTitle(sessionId) !== name) throw new Error('The native session name could not be confirmed. Refresh before retrying.');
    return name;
  }
  async sessionWorkspace(sessionId: string): Promise<string | undefined> {
    if (!sessionId || /[\x00/\\]/u.test(sessionId)) throw new Error('Invalid Copilot session ID.');
    await this.ready();
    const opened = this.sessions.get(sessionId);
    if (opened) return (await opened.runtimeInfo()).cwd;
    const metadata = await deadline(this.client.getSessionMetadata(sessionId), this.options.requestTimeoutMs ?? 15000, 'Copilot session metadata');
    return metadata?.context?.workingDirectory || undefined;
  }
  async createSession(config: AgentSessionConfig): Promise<CopilotAgentSession> {
    const cwd = await realpath(config.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error('Copilot workspace must be a directory.');
    return this.open({ ...config, cwd, sessionId: randomUUID() }, false);
  }
  async assertSessionAvailable(sessionId: string): Promise<void> {
    await this.ready();
    const result = await deadline(this.client.rpc.sessions.checkInUse({sessionIds: [sessionId]}), this.options.requestTimeoutMs ?? 15000, 'Copilot ownership check');
    if (result.inUse.includes(sessionId)) throw new AgentSessionInUseError('This Copilot session is open in an unmanaged native client. Close it there before resuming.');
  }
  async releaseSession(sessionId: string): Promise<void> {
    await this.ready();
    await deadline(this.client.rpc.sessions.close({sessionId}), this.options.requestTimeoutMs ?? 15000, 'Copilot immediate handoff');
  }
  async resumeSession(handle: AgentPersistenceHandle): Promise<CopilotAgentSession> {
    if (handle.providerId !== 'copilot' || !handle.sessionId || /[\x00/\\]/u.test(handle.sessionId)) throw new Error('Invalid Copilot persistence handle.');
    let stored: unknown;
    try { stored = JSON.parse(handle.opaque); } catch { throw new Error('Invalid Copilot persistence configuration.'); }
    if (!stored || typeof stored !== 'object') throw new Error('Invalid Copilot persistence configuration.');
    const storedCwd = (stored as {cwd?: unknown}).cwd;
    await this.assertSessionAvailable(handle.sessionId);
    const cwd = typeof storedCwd === 'string' && storedCwd ? storedCwd : await this.sessionWorkspace(handle.sessionId);
    if (!cwd) throw new Error('Copilot session workspace is unavailable.');
    return this.open({ sessionId: handle.sessionId, cwd }, true);
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
