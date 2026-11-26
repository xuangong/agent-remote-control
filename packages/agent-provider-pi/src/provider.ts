import { appendFile, realpath, stat } from 'node:fs/promises';
import { AgentRuntimeError, type AgentHistoryPage, type AgentHistoryQuery, type AgentPersistenceHandle, type AgentProviderAdapter, type AgentSession,
  type AgentSessionConfig, type AgentSessionExtensions, type AgentSessionResumeOptions } from '@orchardworks/agent-provider-sdk';
import { piBehaviour } from './behaviour.js';
import { provider, record } from './native.js';
import type { PiPermissionModeStore } from './permission-mode.js';
import { spawnPi, type PiLauncher } from './process.js';
import { readPiHistoryPage } from './reference-history.js';
import { PiAgentSession, type PiSessionRuntime } from './session.js';
import { findPiSessionFile, listPiSessionFiles, piSessionDirectory, readPiSession, sessionTitle, validPiSessionId } from './session-file.js';

export interface PiAgentProviderOptions {
  /** Path of the pi executable; resolve it with `resolvePiExecutable`. */
  executable: string;
  /** The environment pi runs in: PI_CODING_AGENT_DIR selects another profile, and the provider's credentials stay in it. */
  env?: Record<string, string | undefined>;
  /** The deadline of one command, in milliseconds. */
  requestTimeoutMs?: number;
  /** How long opening a session may take; the declared resume deadline by default. */
  startTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  /** Remembers each session's confirmed permission mode, so a reopened session keeps it. */
  permissionModes?: PiPermissionModeStore;
  /** The native port: how a pi process is started. A test plays the CLI through it. */
  launch?: PiLauncher;
  /** Where each session's private work directory is made; the process temporary directory by default. */
  workRoot?: string;
}
export interface PiSessionSummary { nativeSessionId: string; providerId: string; title: string; workspace?: string; createdAt: string; updatedAt: string; state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable' }

const TITLE_LIMIT = 512;

export class PiAgentProvider implements AgentProviderAdapter {
  /** Every timeline observation carries an item identity equal live and in a reread. */
  readonly journal = { itemIdentity: 1 as const };
  /** A session's id is the UUID pi generates. */
  readonly createdSessionIdMaxLength: number = 36;
  readonly descriptor = { providerId: provider, displayName: 'pi', sessionExtensions: { instructions: true, tools: true, toolNamespaces: 'attachment' as const },
    sessionAccess: { readOnly: true as const }, sessionHostAccess: true as const, behaviour: piBehaviour };
  private readonly sessions = new Map<string, PiAgentSession>();
  private readonly loading = new Set<string>();
  private readonly env: Record<string, string | undefined>;
  private closed = false;
  constructor(private readonly options: PiAgentProviderOptions) {
    this.env = { ...process.env, ...options.env };
  }

  private get sessionDirectory(): string { return piSessionDirectory(this.env); }
  private runtime(onDispose: () => void): PiSessionRuntime {
    return { launch: this.options.launch ?? spawnPi(this.options.executable), env: this.env, requestTimeoutMs: this.options.requestTimeoutMs ?? 15_000, startTimeoutMs: this.options.startTimeoutMs ?? piBehaviour.resume.deadlineMs,
      onDiagnostic: this.options.onDiagnostic, permissionModes: this.options.permissionModes, workRoot: this.options.workRoot, onDispose };
  }
  private assertOpen(): void { if (this.closed) throw new Error('pi provider is closed.'); }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.assertOpen();
    const cwd = await workspace(config.cwd);
    let id: string | undefined;
    const session = await PiAgentSession.open({ config: { ...config, cwd } }, this.runtime(() => { if (id && this.sessions.get(id) === session) this.sessions.delete(id); }));
    id = (await session.runtimeInfo()).sessionId ?? undefined;
    if (id) this.sessions.set(id, session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}, options: AgentSessionResumeOptions = {}): Promise<AgentSession> {
    this.assertOpen();
    if (handle.providerId !== provider || !validPiSessionId(handle.sessionId)) throw new Error('Invalid pi persistence handle.');
    const id = handle.sessionId;
    if (this.sessions.has(id) || this.loading.has(id)) throw new Error('pi session is already loaded.');
    this.loading.add(id);
    try {
      const file = await findPiSessionFile(this.sessionDirectory, id);
      const content = file ? await readPiSession(file) : undefined;
      // pi writes a session file with the first answer and cannot open a new session under an old id, so an empty session cannot be reopened.
      if (!file || !content) throw new AgentRuntimeError('native_session_unavailable', 'This pi session has no saved history: pi saves a session with its first answer.');
      if (options.initializeEmpty === true && content.entries.length === 0) throw new AgentRuntimeError('native_session_unavailable', 'This pi session has no saved history: pi saves a session with its first answer.');
      const cwd = await workspace(content.header.cwd);
      const saved = persisted(handle.opaque);
      const access = extensions.access ?? saved.access;
      const session = await PiAgentSession.open({ config: { ...extensions, ...(access ? { access } : {}), ...(options.hostAccess ? { hostAccess: options.hostAccess } : {}), sessionId: id, cwd }, resume: { sessionId: id, file } },
        this.runtime(() => { if (this.sessions.get(id) === session) this.sessions.delete(id); }));
      this.sessions.set(id, session);
      return session;
    } finally { this.loading.delete(id); }
  }

  async listSessions(): Promise<PiSessionSummary[]> {
    this.assertOpen();
    return (await listPiSessionFiles(this.sessionDirectory)).map(file => ({ nativeSessionId: file.id, providerId: provider, title: file.title ?? 'pi session', workspace: file.cwd,
      createdAt: new Date(file.createdAt).toISOString(), updatedAt: new Date(file.updatedAt).toISOString(), state: 'unknown' as const }));
  }

  async readSessionTitle(id: string): Promise<string | undefined> {
    if (!validPiSessionId(id)) throw new Error('Invalid pi session identity.');
    const file = await findPiSessionFile(this.sessionDirectory, id);
    const content = file ? await readPiSession(file) : undefined;
    return content ? sessionTitle(content.entries) : undefined;
  }

  validateSessionTitle(title: string): void {
    const name = title.trim();
    if (!name || name.length > TITLE_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`Enter a session name of up to ${TITLE_LIMIT} characters.`);
  }

  /** `/name` appends a `session_info` entry to the session file; so does this, with the leaf as its parent. */
  async renameSession(id: string, title: string): Promise<string> {
    this.validateSessionTitle(title);
    const name = title.trim();
    if (!validPiSessionId(id)) throw new Error('Invalid pi session identity.');
    const loaded = this.sessions.get(id);
    if (loaded) { await loaded.rename(name); return name; }
    const file = await findPiSessionFile(this.sessionDirectory, id);
    const content = file ? await readPiSession(file) : undefined;
    if (!file || !content) throw new Error('The pi session was not found.');
    if (sessionTitle(content.entries) === name) return name;
    const leaf = content.entries.at(-1);
    const entry = { type: 'session_info', id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'), parentId: typeof leaf?.id === 'string' ? leaf.id : null, timestamp: new Date().toISOString(), name };
    await appendFile(file, `${JSON.stringify(entry)}\n`);
    if (await this.readSessionTitle(id) !== name) throw new Error('The native session name could not be confirmed. Refresh before retrying.');
    return name;
  }

  async sessionWorkspace(id: string, handle?: AgentPersistenceHandle): Promise<string | undefined> {
    if (handle && (handle.providerId !== provider || handle.sessionId !== id)) throw new Error('Invalid pi persistence handle.');
    const loaded = this.sessions.get(id);
    if (loaded) return (await loaded.runtimeInfo()).cwd;
    const file = validPiSessionId(id) ? await findPiSessionFile(this.sessionDirectory, id) : undefined;
    return (file ? (await readPiSession(file))?.header.cwd : undefined);
  }

  async readSessionHistory(id: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
    if (!validPiSessionId(id)) throw new Error('Invalid pi session identity.');
    const file = await findPiSessionFile(this.sessionDirectory, id);
    const content = file ? await readPiSession(file) : undefined;
    if (!content) throw new Error('The pi source session was not found.');
    return readPiHistoryPage(content, query);
  }

  async releaseSession(id: string): Promise<void> { await this.sessions.get(id)?.dispose(); }
  async cleanupFailedSession(id: string): Promise<void> { await this.releaseSession(id); }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => session.dispose()));
  }
}

async function workspace(cwd?: string): Promise<string> {
  const path = await realpath(cwd ?? process.cwd());
  if (!(await stat(path)).isDirectory()) throw new Error('pi workspace must be a directory.');
  return path;
}
function persisted(opaque: string): { access?: 'read_only' } {
  try { return record(JSON.parse(opaque)).access === 'read_only' ? { access: 'read_only' } : {}; } catch { return {}; }
}
