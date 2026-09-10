import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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

  constructor(private readonly options: CodexAppServerProviderOptions = {}) {}

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
      return await CodexAppServerSession.create(transport, config, this.options.collaborationMode, this.options.env?.CODEX_HOME);
    } catch (error) {
      await transport.dispose();
      throw error;
    }
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const cwd = readPersistenceCwd(handle.opaque);
    const transport = await this.createTransport(cwd);
    try {
      return await CodexAppServerSession.resume(transport, handle, this.options.collaborationMode, this.options.env?.CODEX_HOME);
    } catch (error) {
      await transport.dispose();
      throw error;
    }
  }

  private async createTransport(cwd?: string): Promise<CodexAppServerTransport> {
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
