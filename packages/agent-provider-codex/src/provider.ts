import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type {
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentProviderDescriptor,
  AgentSession,
  AgentSessionConfig,
} from '@borgee/agent-provider-sdk';

import { CodexAppServerTransport } from './app-server-transport.js';
import { spawnCodexAppServer } from './native.js';
import { CodexAppServerSession } from './session.js';
import { initializeCodexTransport } from './initialize.js';
import { readCodexSessionPage, type CodexSessionListOptions, type CodexSessionPage } from './catalog.js';

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
  spawn?: (context: { cwd?: string }) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;
}

export class CodexAppServerProvider implements AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor = {
    providerId: 'codex',
    displayName: 'Codex',
  };

  private readonly sessions = new Set<CodexAppServerSession>();

  constructor(private readonly options: CodexAppServerProviderOptions = {}) {
    if (options.connectionMode !== undefined && !['private', 'shared'].includes(options.connectionMode)) throw new Error('Codex connection mode must be private or shared.');
    if (options.socketPath !== undefined && (options.connectionMode !== 'shared' || !isAbsolute(options.socketPath))) {
      throw new Error('Codex socket path requires shared mode and an absolute local path.');
    }
    if (options.connectionMode === 'shared' && options.restrictedNative) {
      throw new Error('Shared Codex uses the native daemon permissions. Explicit local trusted control is required; per-client sandbox restrictions cannot be enforced.');
    }
    if (options.connectionMode === 'shared' && options.spawn) throw new Error('Shared Codex cannot also spawn a private runtime.');
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
    } finally { await transport.dispose(); }
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const transport = await this.createTransport(config.cwd);
    try {
      const session = await CodexAppServerSession.create(transport, config, this.options.collaborationMode, this.options.env?.CODEX_HOME, this.options.restrictedNative);
      this.sessions.add(session);
      session.onRuntimeClosed(() => this.sessions.delete(session));
      return session;
    } catch (error) {
      await transport.dispose();
      throw error;
    }
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const cwd = readPersistenceCwd(handle.opaque);
    const transport = await this.createTransport(cwd);
    try {
      const session = await CodexAppServerSession.resume(transport, handle, this.options.collaborationMode, this.options.env?.CODEX_HOME, this.options.restrictedNative);
      this.sessions.add(session);
      session.onRuntimeClosed(() => this.sessions.delete(session));
      return session;
    } catch (error) {
      await transport.dispose();
      throw error;
    }
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
      return CodexAppServerTransport.connectShared(this.options.socketPath ?? join(home, 'app-server-control', 'app-server-control.sock'), {
        requestTimeoutMs: this.options.requestTimeoutMs, onDiagnostic: this.options.onDiagnostic,
      });
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
