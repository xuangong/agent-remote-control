import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { createClaudeCatalog, type ClaudeCatalog } from './catalog.js';
import { ClaudeAgentSession, type ClaudeSessionConfig, type ClaudeSessionOptions } from './session.js';
import { record } from './projector.js';

export interface ClaudeSessionSummary {
  nativeSessionId: string;
  providerId: string;
  title: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable';
}
export interface ClaudeAgentProviderOptions extends ClaudeSessionOptions { catalog?: ClaudeCatalog }

export class ClaudeAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'claude', displayName: 'Claude Code' };
  private readonly catalog: ClaudeCatalog;
  private readonly sessions = new Map<string, ClaudeAgentSession>();
  private readonly loading = new Set<string>();
  constructor(private readonly options: ClaudeAgentProviderOptions = {}) {
    this.catalog = options.catalog ?? createClaudeCatalog(options.env ?? {}, options.requestTimeoutMs ?? 15_000);
  }

  async listSessions(): Promise<ClaudeSessionSummary[]> {
    // Persisted SDK metadata does not describe an external query's current activity.
    return (await this.catalog.list()).map((entry) => ({ nativeSessionId: entry.sessionId, providerId: 'claude',
      title: entry.customTitle || entry.summary || entry.firstPrompt || 'Claude session', ...(entry.cwd ? { workspace: entry.cwd } : {}),
      createdAt: new Date(entry.createdAt ?? entry.lastModified).toISOString(), updatedAt: new Date(entry.lastModified).toISOString(), state: 'unknown' }));
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = randomUUID();
    let session: ClaudeAgentSession | undefined;
    session = await ClaudeAgentSession.open({ ...config, sessionId, cwd: await workspace(config.cwd) },
      { ...this.options, catalog: this.catalog, onDispose: () => {
        if (session && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      } });
    this.sessions.set(sessionId, session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    if (handle.providerId !== 'claude') throw new Error('Claude persistence provider does not match.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle.sessionId)) throw new Error('Invalid Claude session identity.');
    const sessionId = handle.sessionId;
    if (this.sessions.has(sessionId) || this.loading.has(sessionId)) throw new Error('Claude session is already loaded.');
    this.loading.add(sessionId);
    let session: ClaudeAgentSession | undefined;
    try {
      const info = await this.catalog.info(sessionId);
      if (!info) throw new Error('Claude native session is unavailable.');
      const stored = readConfig(handle.opaque);
      const messages = await this.catalog.messages(sessionId);
      session = await ClaudeAgentSession.open({ ...stored, sessionId, cwd: await workspace(info.cwd ?? stored.cwd) },
        { ...this.options, catalog: this.catalog, onDispose: () => {
          if (session && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        } }, messages, true);
      this.sessions.set(sessionId, session);
      return session;
    } finally { this.loading.delete(sessionId); }
  }

  async openChildSession(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession> {
    const parent = this.sessions.get(parentNativeSessionId);
    if (!parent) throw new Error('Claude parent session is not loaded.');
    return parent.openChildSession(nativeSessionId);
  }
}

async function workspace(cwd?: string): Promise<string> {
  const path = await realpath(cwd ?? process.cwd());
  if (!(await stat(path)).isDirectory()) throw new Error('Claude workspace must be a directory.');
  return path;
}
function readConfig(opaque: string): Partial<ClaudeSessionConfig> {
  let value: unknown;
  try { value = JSON.parse(opaque); } catch { throw new Error('Invalid Claude persistence configuration.'); }
  if (!record(value)) throw new Error('Invalid Claude persistence configuration.');
  const config: Partial<ClaudeSessionConfig> = {};
  for (const key of ['cwd', 'model', 'reasoningEffort', 'systemPrompt'] as const) if (typeof value[key] === 'string') config[key] = value[key];
  if (typeof value.planning === 'boolean') config.planning = value.planning;
  if (typeof value.permissionMode === 'string' && ['default', 'acceptEdits', 'dontAsk'].includes(value.permissionMode)) config.permissionMode = value.permissionMode as ClaudeSessionConfig['permissionMode'];
  return config;
}
