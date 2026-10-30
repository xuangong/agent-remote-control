import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { CopilotClient, RuntimeConnection, type SessionConfig } from '@github/copilot-sdk';
import { AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import type { AgentHistoryPage, AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig, AgentSessionExtensions, AgentSessionResumeOptions, AgentProviderNativeEvidence, AgentNativeAuthorityScope, AgentEmptySessionConfig } from '@orchardworks/agent-provider-sdk';
import { CopilotAgentSession } from './session.js';
import { deadline } from './channel.js';
import { nativeCanonical, nativeHash, nativeIdentity, rejectNativeEvidence, copilotEmptyHandle, readCopilotEmptyHandle, type CopilotEmptyDescriptor } from './native-evidence.js';
import { readCopilotHistoryPage } from './reference-history.js';
export interface CopilotAgentProviderOptions { executable?: string; env?: Record<string, string | undefined>; requestTimeoutMs?: number; onDiagnostic?: (message: string) => void; nativeSessionConfig?: Pick<SessionConfig, 'provider' | 'skillDirectories' | 'mcpServers'>; useLoggedInUser?: boolean; }
export interface CopilotSessionSummary { nativeSessionId: string; providerId: string; title: string; workspace?: string; createdAt: string; updatedAt: string; state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable'; }
export function resolveCopilotExecutable(): string {
  const packagePath = createRequire(import.meta.url).resolve('@github/copilot/package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {bin: {copilot: string}};
  return resolve(dirname(packagePath), manifest.bin.copilot);
}
function nativeSessionMissing(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  const missing = `Session not found: ${sessionId}`;
  return [missing, `Failed to load session events: ${missing}`,
    `Request session.resume failed with message: Failed to load session events: ${missing}`].includes(error.message);
}
export class CopilotAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'copilot', displayName: 'GitHub Copilot', sessionExtensions: { instructions: true, tools: true, toolNamespaces: 'attachment' as const } };
  /** Ordinary create supplies a nonempty UUID; this does not bound resume, fork, or history. */
  readonly createdSessionIdMaxLength = 36;
  readonly sessionRenameRequiresOpen = true;
  readonly nativeEvidence: AgentProviderNativeEvidence;
  private readonly authority: AgentNativeAuthorityScope;
  private readonly client: CopilotClient;
  private readonly profile: string;
  private readonly sessions = new Map<string, CopilotAgentSession>();
  private readonly loading = new Set<string>();
  private started?: Promise<void>;
  private disposed = false;
  constructor(private readonly options: CopilotAgentProviderOptions = {}) {
    const executable = options.executable ?? resolveCopilotExecutable();
    const nativeEnv = {...process.env, ...options.env};
    const profile = resolve(nativeEnv.COPILOT_HOME ?? resolve(nativeEnv.HOME ?? nativeEnv.USERPROFILE ?? homedir(), '.copilot'));
    this.profile = profile;
    this.authority=Object.freeze({kind:'owned-runtime',authorityId:'copilot-sdk-stdio',namespaceId:nativeHash(nativeCanonical({profile}))});
    this.nativeEvidence=Object.freeze<AgentProviderNativeEvidence>({availability:()=>this.disposed?{status:'unavailable',code:'native_evidence_unavailable',reason:'Native evidence authority is unavailable.'}:{status:'configured',version:2},createEmpty:config=>this.createEmpty(config)});
    const invocation = /\.(?:mjs|cjs)$/i.test(executable) ? {path: process.execPath, args: [executable]} : {path: executable};
    this.client = new CopilotClient({ connection: RuntimeConnection.forStdio(invocation), env: nativeEnv, useLoggedInUser: options.useLoggedInUser });
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
  async readSessionHistory(sessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
    if (this.disposed) throw new Error('Copilot provider is disposed.');
    const session = this.sessions.get(sessionId);
    const page = await readCopilotHistoryPage(this.profile, sessionId, query, session
      ? request => deadline(session.rpc.eventLog.read(request), this.options.requestTimeoutMs ?? 15000, 'Read Copilot source history') : undefined);
    if (this.disposed || this.sessions.get(sessionId) !== session) throw new Error('Copilot source history attachment changed during observation.');
    return page;
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
  async sessionWorkspace(sessionId: string, handle?: AgentPersistenceHandle): Promise<string | undefined> {
    if (!sessionId || /[\x00/\\]/u.test(sessionId)) throw new Error('Invalid Copilot session ID.');
    let descriptor:CopilotEmptyDescriptor|undefined;
    if(handle) {if(handle.sessionId!==sessionId) rejectNativeEvidence('native_evidence_invalid');descriptor=readCopilotEmptyHandle(handle,this.authority);}
    await this.ready();
    const opened = this.sessions.get(sessionId);
    if (opened) return (await opened.runtimeInfo()).cwd;
    const metadata = await deadline(this.client.getSessionMetadata(sessionId), this.options.requestTimeoutMs ?? 15000, 'Copilot session metadata');
    return metadata?.context?.workingDirectory || descriptor?.cwd || undefined;
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
  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}, resumeOptions: AgentSessionResumeOptions = {}): Promise<CopilotAgentSession> {
    if (handle.providerId !== 'copilot' || !handle.sessionId || /[\x00/\\]/u.test(handle.sessionId)) throw new Error('Invalid Copilot persistence handle.');
    const descriptor=readCopilotEmptyHandle(handle,this.authority);
    if(descriptor) {
      await this.assertSessionAvailable(handle.sessionId);
      const cwd=await realpath(descriptor.cwd);if(cwd!==descriptor.cwd) rejectNativeEvidence('native_evidence_stale');
      const config={...(descriptor.systemPrompt!==undefined?{systemPrompt:descriptor.systemPrompt}:{}),...(descriptor.instructions!==undefined?{instructions:descriptor.instructions}:{}),...extensions,sessionId:handle.sessionId,cwd};
      try {return await this.open(config,true,descriptor);} catch(error) {
        if(!resumeOptions.initializeEmpty||!nativeSessionMissing(error,handle.sessionId)) throw error;
        // Only the caller's never-dispatched state permits materializing this descriptor.
        return this.open({...config,model:descriptor.selections.model,reasoningEffort:descriptor.selections.reasoningEffort},false,descriptor);
      }
    }
    let stored: unknown;
    try { stored = JSON.parse(handle.opaque); } catch { throw new Error('Invalid Copilot persistence configuration.'); }
    if (!stored || typeof stored !== 'object') throw new Error('Invalid Copilot persistence configuration.');
    const storedCwd = (stored as {cwd?: unknown}).cwd;
    await this.assertSessionAvailable(handle.sessionId);
    const cwd = typeof storedCwd === 'string' && storedCwd ? storedCwd : await this.sessionWorkspace(handle.sessionId);
    if (!cwd) throw new Error('Copilot session workspace is unavailable.');
    const saved = stored as { systemPrompt?: unknown; instructions?: unknown };
    return this.open({ ...(typeof saved.systemPrompt === 'string' ? { systemPrompt: saved.systemPrompt } : {}),
      ...(typeof saved.instructions === 'string' ? { instructions: saved.instructions } : {}), ...extensions, sessionId: handle.sessionId, cwd }, true);
  }
  private async createEmpty(config:AgentEmptySessionConfig) {
    if(Object.keys(config).some(key=>!['sessionId','cwd','selectionSourceSessionId','extensions'].includes(key))) rejectNativeEvidence('native_evidence_invalid');
    // Copilot registers tools when a session opens, so a role's extensions apply on attachment.
    nativeIdentity(config.sessionId);if(config.selectionSourceSessionId!==undefined) nativeIdentity(config.selectionSourceSessionId);
    const cwd=await realpath(config.cwd??process.cwd());if(!(await stat(cwd)).isDirectory()) rejectNativeEvidence('native_evidence_invalid');
    await this.ready();await this.assertSessionAvailable(config.sessionId);
    if(this.sessions.has(config.sessionId)||this.loading.has(config.sessionId)||await deadline(this.client.getSessionMetadata(config.sessionId),this.options.requestTimeoutMs??15000,'Copilot empty session metadata')) rejectNativeEvidence('native_evidence_admission');
    const source=config.selectionSourceSessionId?this.sessions.get(config.selectionSourceSessionId):undefined;
    if(config.selectionSourceSessionId&&!source) rejectNativeEvidence('native_evidence_unavailable');
    let temporary:CopilotAgentSession|undefined;
    try {
      const selected=source??(temporary=await this.open({sessionId:config.sessionId,cwd},false));
      const settings=await selected.successionSelections();
      if(selected.cwd!==cwd) rejectNativeEvidence('native_evidence_invalid');
      const descriptor:CopilotEmptyDescriptor={version:1,kind:'copilot.empty',sessionId:config.sessionId,cwd,authority:this.authority,...settings};
      return {status:'created' as const,handle:copilotEmptyHandle(descriptor)};
    } finally {await temporary?.dispose();}
  }
  private async open(config: AgentSessionConfig, resume: boolean, descriptor?:CopilotEmptyDescriptor): Promise<CopilotAgentSession> {
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
      const session = await CopilotAgentSession.open(this.client, config, resume, options, () => this.sessions.delete(config.sessionId), {authority:this.authority,descriptor});
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
