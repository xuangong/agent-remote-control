import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AgentHistoryPage, AgentHistoryQuery, AgentNativePrefixCapability, AgentNativePrefixTarget, AgentPersistenceHandle, AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions, AgentSessionResumeOptions, AgentProviderNativeEvidence } from '@orchardworks/agent-provider-sdk';
import { createClaudeCatalog, type ClaudeCatalog } from './catalog.js';
import { ClaudeShutdownError, ClaudeAgentSession, type ClaudeSessionConfig, type ClaudeSessionOptions } from './session.js';
import { isResumableClaudePermissionMode } from './permission-modes.js';
import { record } from './projector.js';
import { claudeEmptyHandle, readClaudeEmptyDescriptor, claudeEvidenceReject, validClaudeId } from './native-evidence.js';

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
  /** Ordinary create supplies a nonempty UUID; this does not bound resume, fork, or history. */
  readonly createdSessionIdMaxLength: number = 36;
  readonly descriptor = { providerId: 'claude', displayName: 'Claude Code', sessionExtensions: { instructions: true, tools: true } };
  readonly nativeEvidence: AgentProviderNativeEvidence = {
    availability: () => ({ status: 'configured', version: 2 }),
    createEmpty: async config => {
      if (!validClaudeId(config.sessionId)) claudeEvidenceReject('native_evidence_invalid');
      const cwd = await workspace(config.cwd);
      if (this.sessions.has(config.sessionId) || this.loading.has(config.sessionId) || await this.catalog.info(config.sessionId)) claudeEvidenceReject('native_evidence_identity_unusable');
      const source = config.selectionSourceSessionId ? this.sessions.get(config.selectionSourceSessionId) : undefined;
      if (config.selectionSourceSessionId && !source) claudeEvidenceReject('native_evidence_unavailable');
      const selections = source?.selectionConfig() ?? {};
      return { status: 'created', handle: claudeEmptyHandle({ ...selections, sessionId: config.sessionId, cwd }, this.options) };
    },
  };
  /**
   * Codex semantics: a branch holds the conversation before the selected prompt, the original is unchanged,
   * and files are not reverted. Available only with a catalog that can read and fork native transcripts.
   */
  get nativePrefix(): AgentNativePrefixCapability | undefined {
    if (!this.catalog.promptEdit) return undefined;
    return {
      createdSessionIdMaxLength: this.createdSessionIdMaxLength,
      validate: target => this.validatePromptEdit(target),
      create: (target, extensions, checkpoint) => {
        if (typeof checkpoint !== 'function') return Promise.reject(new Error('Native prefix creation requires a checkpoint.'));
        return this.createPromptEditPrefix(target, extensions, checkpoint);
      },
      verify: (target, handle) => this.verifyPromptEditBranch(target, handle),
    };
  }
  private readonly catalog: ClaudeCatalog;
  private readonly sessions = new Map<string, ClaudeAgentSession>();
  private readonly loading = new Set<string>();
  constructor(private readonly options: ClaudeAgentProviderOptions = {}) {
    this.catalog = options.catalog ?? createClaudeCatalog(options.env ?? {}, options.requestTimeoutMs ?? 15_000);
  }

  async readSessionTitle(sessionId: string): Promise<string | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid Claude session identity.');
    const info = await this.catalog.info(sessionId);
    return info?.customTitle || info?.summary || info?.firstPrompt;
  }

  async readSessionHistory(sessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid Claude session identity.');
    if (!this.catalog.history) throw new Error('Claude source history is unsupported by this catalog.');
    return this.catalog.history(sessionId, query);
  }

  async renameSession(sessionId: string, title: string): Promise<string> {
    const name = title.trim();
    if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Enter a session name of up to 512 characters.');
    const current = await this.readSessionTitle(sessionId);
    if (current === name) return name;
    if (!this.catalog.rename) throw new Error('Native Claude session renaming is unavailable.');
    await this.catalog.rename(sessionId, name);
    if (await this.readSessionTitle(sessionId) !== name) throw new Error('The native session name could not be confirmed. Refresh before retrying.');
    return name;
  }

  async listSessions(): Promise<ClaudeSessionSummary[]> {
    // Persisted SDK metadata does not describe an external query's current activity.
    return (await this.catalog.list()).map((entry) => ({ nativeSessionId: entry.sessionId, providerId: 'claude',
      title: entry.customTitle || entry.summary || entry.firstPrompt || 'Claude session', ...(entry.cwd ? { workspace: entry.cwd } : {}),
      createdAt: new Date(entry.createdAt ?? entry.lastModified).toISOString(), updatedAt: new Date(entry.lastModified).toISOString(), state: 'unknown' }));
  }

  async sessionWorkspace(sessionId: string, handle?: AgentPersistenceHandle): Promise<string | undefined> {
    if (handle && (handle.providerId !== 'claude' || handle.sessionId !== sessionId)) claudeEvidenceReject('native_evidence_invalid');
    const descriptor = handle ? readClaudeEmptyDescriptor(handle, this.options) : undefined;
    const session = this.sessions.get(sessionId);
    return session ? (await session.runtimeInfo()).cwd : (await this.catalog.info(sessionId))?.cwd ?? descriptor?.cwd;
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await session.release();
  }

  async cleanupFailedSession(sessionId: string): Promise<void> {
    await this.releaseSession(sessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.dispose()));
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = randomUUID();
    let session: ClaudeAgentSession | undefined;
    try {
      session = await ClaudeAgentSession.open({ ...config, sessionId, cwd: await workspace(config.cwd) },
        { ...this.options, catalog: this.catalog, onDispose: () => {
          if (session && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        } });
    } catch (error) {
      if (error instanceof ClaudeShutdownError) { session = error.session; this.sessions.set(sessionId, session); }
      throw error;
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}, resumeOptions: AgentSessionResumeOptions = {}): Promise<AgentSession> {
    if (handle.providerId !== 'claude') throw new Error('Claude persistence provider does not match.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle.sessionId)) throw new Error('Invalid Claude session identity.');
    const sessionId = handle.sessionId;
    if (this.sessions.has(sessionId) || this.loading.has(sessionId)) throw new Error('Claude session is already loaded.');
    this.loading.add(sessionId);
    let session: ClaudeAgentSession | undefined;
    try {
      const descriptor = readClaudeEmptyDescriptor(handle, this.options);
      const info = await this.catalog.info(sessionId);
      if (!info && !(descriptor && resumeOptions.initializeEmpty === true)) throw new Error('Claude native session is unavailable.');
      const stored = descriptor ? { ...descriptor.config } : readConfig(handle.opaque);
      if (descriptor && info) delete stored.model;
      const cwd = info?.cwd ?? stored.cwd;
      if (descriptor && cwd !== descriptor.cwd) claudeEvidenceReject('native_evidence_stale');
      if (!cwd) throw new Error('Claude session workspace is unavailable.');
      const messages = info ? await (this.catalog.timelineMessages?.(sessionId) ?? this.catalog.messages(sessionId)) : [];
      session = await ClaudeAgentSession.open({ ...stored, ...extensions, sessionId, cwd: await workspace(cwd) },
        { ...this.options, catalog: this.catalog, emptyDescriptor: Boolean(descriptor), restoreNativeModel: Boolean(descriptor && info), onDispose: () => {
          if (session && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        } }, messages, Boolean(info));
      this.sessions.set(sessionId, session);
      return session;
    } catch (error) {
      if (error instanceof ClaudeShutdownError) { session = error.session; this.sessions.set(sessionId, session); }
      throw error;
    } finally { this.loading.delete(sessionId); }
  }

  async validatePromptEdit(target: AgentNativePrefixTarget): Promise<void> {
    await this.promptEditBoundary(target);
  }

  /** Non-durable convenience fork. Host succession uses nativePrefix.create. */
  async forkForPromptEdit(target: AgentNativePrefixTarget, extensions: AgentSessionExtensions = {}): Promise<AgentSession> {
    return this.createPromptEditPrefix(target, extensions);
  }

  async verifyPromptEditBranch(target: AgentNativePrefixTarget, handle: AgentPersistenceHandle): Promise<void> {
    const promptEdit = this.requirePromptEdit();
    if (handle.providerId !== 'claude' || !validClaudeId(handle.sessionId) || handle.sessionId === target.nativeSessionId) throw new Error('Invalid Claude prompt-edit candidate identity.');
    const stored = readClaudeEmptyDescriptor(handle, this.options)?.config ?? readConfig(handle.opaque);
    const boundary = await promptEdit.inspect(target);
    if (!stored.cwd || await realpath(stored.cwd) !== boundary.cwd) throw new Error('Claude candidate workspace does not match.');
    await promptEdit.verify(target, handle.sessionId);
  }

  private requirePromptEdit() {
    if (!this.catalog.promptEdit) throw new Error('Claude prompt editing is unavailable.');
    return this.catalog.promptEdit;
  }

  /** The transcript decides the boundary; a loaded source must also be quiet, because its next turn would extend it. */
  private async promptEditBoundary(target: AgentNativePrefixTarget) {
    const boundary = await this.requirePromptEdit().inspect(target);
    const source = this.sessions.get(target.nativeSessionId);
    if (source) {
      const readiness = await source.nativeEvidence.inspectReadiness();
      if (!readiness.idle) throw new Error('Wait for Claude to finish before editing a prompt.');
      if (readiness.pendingInputs || readiness.pendingInteractions) throw new Error('Resolve pending Claude questions and queued input before editing a prompt.');
      if (readiness.activeChildren) throw new Error('Wait for Claude background tasks to finish before editing a prompt.');
    }
    return { boundary, selections: source?.selectionConfig() ?? {} };
  }

  private async createPromptEditPrefix(target: AgentNativePrefixTarget, extensions: AgentSessionExtensions = {}, candidateKnown?: (handle: AgentPersistenceHandle) => Promise<void>): Promise<AgentSession> {
    // The Host supplies the branch's system prompt and tools as extensions; only native selections carry over.
    const { selections: { systemPrompt: _systemPrompt, ...selections } } = await this.promptEditBoundary(target);
    const branch = await this.requirePromptEdit().fork(target);
    const config = { ...selections, cwd: branch.cwd };
    if (!branch.sessionId) {
      // Editing the first prompt starts an empty conversation; Claude creates its transcript with the first message.
      const handle = claudeEmptyHandle({ ...config, sessionId: randomUUID() }, this.options);
      await candidateKnown?.(handle);
      return this.resumeSession(handle, extensions, { initializeEmpty: true });
    }
    const handle = { providerId: 'claude', sessionId: branch.sessionId, opaque: JSON.stringify(config) };
    await candidateKnown?.(handle);
    await this.verifyPromptEditBranch(target, handle);
    return this.resumeSession(handle, extensions);
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
  for (const key of ['cwd', 'model', 'reasoningEffort', 'systemPrompt', 'instructions'] as const) if (typeof value[key] === 'string') config[key] = value[key];
  if (typeof value.planning === 'boolean') config.planning = value.planning;
  if (isResumableClaudePermissionMode(value.permissionMode)) config.permissionMode = value.permissionMode;
  return config;
}
