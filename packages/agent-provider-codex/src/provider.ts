import { CodexSessionTakeover } from './session-takeover.js';
import { preparePromptEdit, type CodexPromptEditTarget } from './prompt-edit.js';
import type { AgentSessionExtensions, AgentHistoryQuery, AgentHistoryPage } from '@orchardworks/agent-provider-sdk';
import { readSessionHistoryPage } from './reference-history.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type {
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentProviderDescriptor,
  AgentSession,
  AgentSessionConfig,
} from '@orchardworks/agent-provider-sdk';

import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';

import { CodexAppServerTransport, CodexTransportUnavailableError, CodexRequestTimeoutError, CodexAppServerRpcError } from './app-server-transport.js';
import { isRecord, readString, spawnCodexAppServer } from './native.js';
import { CodexAppServerSession } from './session.js';
import { initializeCodexTransport } from './initialize.js';
import { readCodexSessionPage, type CodexSessionListOptions, type CodexSessionPage } from './catalog.js';
import type { CodexSharedRecoveryPlan, CodexSharedRecoverySettings } from './shared-recovery.js';
import { windowsCodexSharedEndpoint } from './platform/windows/daemon.js';

export interface CodexAppServerProviderOptions {
  executable?: string;
  /** Shared mode attaches to a native local WebSocket; disposing it never stops the daemon. */
  connectionMode?: 'private' | 'shared';
  socketPath?: string;
  restrictedNative?: boolean;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  collaborationMode?: 'plan';
  onDiagnostic?: (line: string) => void;
  sharedRecovery?: CodexSharedRecoverySettings;
  spawn?: (context: { cwd?: string }) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;
}

export class CodexAppServerProvider implements AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor = {
    providerId: 'codex',
    displayName: 'Codex',
  };

  private readonly takeover: CodexSessionTakeover;
  private readonly sessions = new Set<CodexAppServerSession>();

  constructor(private readonly options: CodexAppServerProviderOptions = {}) {
    this.takeover = new CodexSessionTakeover(options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), undefined, options.onDiagnostic);
    if (options.connectionMode !== undefined && !['private', 'shared'].includes(options.connectionMode)) throw new Error('Codex connection mode must be private or shared.');
    if (options.socketPath !== undefined && (options.connectionMode !== 'shared' || !isAbsolute(options.socketPath))) {
      throw new Error('Codex socket path requires shared mode and an absolute local path.');
    }
    if (options.connectionMode === 'shared' && options.restrictedNative) {
      throw new Error('Shared Codex uses the native daemon permissions. Explicit local trusted control is required; per-client sandbox restrictions cannot be enforced.');
    }
    if (options.connectionMode === 'shared' && options.spawn) throw new Error('Shared Codex cannot also spawn a private runtime.');
    if (process.platform === 'win32' && options.connectionMode === 'shared' && options.socketPath) throw new Error('Windows shared Codex selects its daemon through CODEX_HOME; remove the Unix socket override.');
  }

  async inspectSessionOwner(nativeSessionId: string): Promise<{generation: string} | undefined> {
    return this.options.connectionMode === 'shared' ? this.takeover.inspect(nativeSessionId) : undefined;
  }

  async releaseSessionOwner(nativeSessionId: string, generation: string): Promise<void> {
    if (this.options.connectionMode !== 'shared') throw new Error('Codex takeover requires a shared destination.');
    await this.takeover.release(nativeSessionId, generation);
  }

  async listSessions(options: CodexSessionListOptions = {}): Promise<CodexSessionPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Codex catalog limit must be between 1 and 100.');
    const transport = await this.createTransport();
    try {
      await initializeCodexTransport(transport);
      return readCodexSessionPage(await transport.request('thread/list', {
        limit, ...(options.cursor ? { cursor: options.cursor } : {}),
        sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer'], archived: false,
      }));
    } catch (error) { throw runtimeError(error, this.options.connectionMode === 'shared'); } finally { await transport.dispose(); }
  }

  async readSessionTitle(nativeSessionId: string): Promise<string | undefined> {
    const transport = await this.createTransport();
    try {
      await initializeCodexTransport(transport);
      const response = await transport.request('thread/read', { threadId: nativeSessionId, includeTurns: false });
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== nativeSessionId) throw new Error('Native session metadata is unavailable.');
      return readString(response.thread.name);
    } catch (error) { throw runtimeError(error, this.options.connectionMode === 'shared'); }
    finally { await transport.dispose(); }
  }

  async renameSession(nativeSessionId: string, title: string): Promise<string> {
    const name = title.trim();
    if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Enter a session name of up to 512 characters.');
    const transport = await this.createTransport();
    try {
      await initializeCodexTransport(transport);
      await transport.request('thread/name/set', { threadId: nativeSessionId, name });
      const response = await transport.request('thread/read', { threadId: nativeSessionId, includeTurns: false });
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== nativeSessionId || !readString(response.thread.name)) {
        throw new Error('The native session name could not be confirmed. Refresh before retrying.');
      }
      return response.thread.name as string;
    } catch (error) { throw runtimeError(error, this.options.connectionMode === 'shared'); }
    finally { await transport.dispose(); }
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const transport = await this.createTransport(config.cwd);
    try {
      const session = await CodexAppServerSession.create(transport, config, this.options.collaborationMode, this.options.env?.CODEX_HOME, this.options.restrictedNative,
        this.sharedRecoveryPlan(config.cwd));
      this.sessions.add(session);
      session.onRuntimeClosed(() => this.sessions.delete(session));
      return session;
    } catch (error) {
      await transport.dispose();
      throw runtimeError(error, this.options.connectionMode === 'shared');
    }
  }

  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}): Promise<AgentSession> {
    const cwd = readPersistenceCwd(handle.opaque);
    const transport = await this.createTransport(cwd);
    try {
      const session = await CodexAppServerSession.resume(transport, handle, this.options.collaborationMode, this.options.env?.CODEX_HOME, this.options.restrictedNative,
        this.sharedRecoveryPlan(cwd), extensions);
      this.sessions.add(session);
      session.onRuntimeClosed(() => this.sessions.delete(session));
      return session;
    } catch (error) {
      await transport.dispose();
      throw runtimeError(error, this.options.connectionMode === 'shared');
    }
  }

  async validatePromptEdit(target: CodexPromptEditTarget): Promise<void> {
    const transport = await this.createTransport();
    try { await preparePromptEdit(transport, target, await initializeCodexTransport(transport)); }
    catch (error) {
      const mapped = runtimeError(error, this.options.connectionMode === 'shared');
      if (mapped instanceof AgentRuntimeError) throw mapped;
      if (error instanceof CodexAppServerRpcError) throw new Error('Codex could not verify this prompt. Check the Controller log and reload the source conversation.');
      throw error;
    }
    finally { await transport.dispose(); }
  }

  async forkForPromptEdit(target: CodexPromptEditTarget): Promise<AgentSession> {
    const transport = await this.createTransport();
    try {
      const session = await CodexAppServerSession.forkForPromptEdit(transport, target, this.options.env?.CODEX_HOME,
        this.options.restrictedNative, this.sharedRecoveryPlan());
      this.sessions.add(session);
      session.onRuntimeClosed(() => this.sessions.delete(session));
      return session;
    } catch (error) {
      await transport.dispose();
      throw runtimeError(error, this.options.connectionMode === 'shared');
    }
  }

  async readSessionWorkspace(nativeSessionId: string): Promise<string | undefined> {
    const transport = await this.createTransport();
    try {
      await initializeCodexTransport(transport);
      const response = await transport.request('thread/read', { threadId: nativeSessionId, includeTurns: false });
      if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== nativeSessionId) throw new Error('Source session metadata is unavailable.');
      return readString(response.thread.cwd);
    } catch (error) { throw runtimeError(error, this.options.connectionMode === 'shared'); } finally { await transport.dispose(); }
  }

  async readSessionHistory(nativeSessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
    const transport = await this.createTransport();
    try {
      await initializeCodexTransport(transport);
      return await readSessionHistoryPage(transport, nativeSessionId, query);
    } catch (error) { throw runtimeError(error, this.options.connectionMode === 'shared'); } finally { await transport.dispose(); }
  }

  canReleaseSession(nativeSessionId: string): boolean {
    return this.options.connectionMode === 'shared'
      && [...this.sessions].some(session => session.canReleaseIdle(nativeSessionId));
  }

  async reconcileIdleSession(nativeSessionId: string): Promise<boolean> {
    if (this.options.connectionMode !== 'shared') return false;
    for (const session of this.sessions) {
      if (await session.reconcileIdle(nativeSessionId)) return true;
    }
    return false;
  }

  async openChildSession(parentNativeSessionId: string, childNativeSessionId: string): Promise<AgentSession> {
    const owners = [...this.sessions].filter((session) => session.hasNativeChild(parentNativeSessionId, childNativeSessionId));
    if (owners.length > 1) throw new Error('Codex native child ownership is ambiguous across loaded runtimes');
    if (owners[0]) return owners[0].openChildSession(parentNativeSessionId, childNativeSessionId);
    if ([...this.sessions].some((session) => session.hasNativeThread(parentNativeSessionId))) throw new Error('Codex session is not a direct child of the loaded parent');
    throw new Error('Codex parent session is not loaded');
  }

  private async createTransport(cwd?: string): Promise<CodexAppServerTransport> {
    if (this.options.connectionMode === 'shared') {
      const home = this.options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
      if (process.platform === 'win32') {
        return windowsCodexSharedEndpoint(home).then(({ url, token }) => CodexAppServerTransport.connectSharedWebSocket(url, token, {
          requestTimeoutMs: this.options.requestTimeoutMs, onDiagnostic: this.options.onDiagnostic,
        })).catch(error => { throw runtimeError(error, true); });
      }
      return CodexAppServerTransport.connectShared(this.options.socketPath ?? join(home, 'app-server-control', 'app-server-control.sock'), {
        requestTimeoutMs: this.options.requestTimeoutMs, onDiagnostic: this.options.onDiagnostic,
      }).catch(error => { throw runtimeError(error, this.options.connectionMode === 'shared'); });
    }
    const child = this.options.spawn
      ? await this.options.spawn({ cwd })
      : spawnCodexAppServer({
          executable: this.options.executable,
          cwd,
          env: this.options.env,
        });
    return new CodexAppServerTransport(child, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      onDiagnostic: this.options.onDiagnostic,
    });
  }

  private sharedRecoveryPlan(cwd?: string): CodexSharedRecoveryPlan | undefined {
    if (this.options.connectionMode !== 'shared') return undefined;
    return { connect: () => this.createTransport(cwd), settings: this.options.sharedRecovery };
  }
}

function readPersistenceCwd(opaque: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(opaque);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof (parsed as { cwd?: unknown }).cwd === 'string'
      ? (parsed as { cwd: string }).cwd
      : undefined;
  } catch {
    return undefined;
  }
}

function runtimeError(error: unknown, shared: boolean): unknown {
  // Only a native RPC response identifies exhaustion inside the shared daemon.
  // Local socket/Controller errors and private runtimes must not suggest restarting it.
  if (shared && error instanceof CodexAppServerRpcError
    && (error.code === 'EMFILE' || /\btoo many open files\b|\bEMFILE\b|\bos error 24\b/i.test(error.message))) {
    return new AgentRuntimeError('native_file_limit',
      'The shared Codex daemon reached its file descriptor limit. Consider restarting it on the Host computer after checking active work. All sessions connected to that daemon will disconnect, and running work may be interrupted.');
  }
  if (error instanceof CodexTransportUnavailableError) return new AgentRuntimeError('native_runtime_unavailable',
    'The Codex runtime connection is unavailable. Check the native daemon and the configured local socket, then reopen the session.');
  if (error instanceof CodexRequestTimeoutError) {
    if (error.method === 'thread/resume') return new AgentRuntimeError('native_resume_timeout',
      'Codex did not finish resuming the session before the native request deadline. Check the Controller log, then reopen the session.');
    if (['thread/read', 'thread/turns/list', 'thread/items/list'].includes(error.method)) return new AgentRuntimeError('native_history_timeout',
      'Codex did not finish reading session history before the native request deadline. Check the Controller log, then reopen the session.');
    return new AgentRuntimeError('native_request_timeout', 'Codex did not answer a native request before its deadline. Check the Controller log and try again.');
  }
  return error;
}
