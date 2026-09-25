import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentHistoryPage, AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeTransport, OpenCodeRequestError, type OpenCodeAgentProviderOptions } from './transport.js';
import { OpenCodeSession } from './session.js';
export type { OpenCodeAgentProviderOptions } from './transport.js';
export interface OpenCodeSessionSummary { id: string; title: string; cwd: string; updatedAt: string; createdAt?: string; parentId?: string; }
export interface OpenCodePersistence { cwd: string; model?: string; agent?: string; }
export async function canonicalDirectory(cwd: string): Promise<string> { return realpath(resolve(cwd)); }
function summary(session: Session): OpenCodeSessionSummary {
  return { id: session.id, title: session.title, cwd: session.directory, updatedAt: new Date(session.time.updated).toISOString(), createdAt: new Date(session.time.created).toISOString(), ...(session.parentID ? { parentId: session.parentID } : {}) };
}
function validateExtensions(config: AgentSessionExtensions): void {
  if (config.tools?.length) throw new Error('OpenCode does not support Host callback tools. Configure tools on the native server.');
}
export class OpenCodeAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'opencode', displayName: 'OpenCode' };
  private readonly transport: OpenCodeTransport;
  private readonly sessions = new Set<OpenCodeSession>();
  private closed = false;
  constructor(options: OpenCodeAgentProviderOptions = {}) {
    if (options.restrictedNative) throw new Error('OpenCode shared server permissions cannot be restricted by the Host. Explicitly trust the native server permissions to connect.');
    this.transport = new OpenCodeTransport(options);
  }
  private assertOpen(): void { if (this.closed) throw new Error('OpenCode provider is closed.'); }
  async createSession(config: AgentSessionConfig): Promise<OpenCodeSession> {
    this.assertOpen(); validateExtensions(config);
    if (config.reasoningEffort !== undefined) throw new Error('OpenCode reasoning effort selection is not supported.');
    if (this.transport.restricted) throw new Error('OpenCode shared sessions require an unrestricted Host execution policy.');
    const cwd = await canonicalDirectory(config.cwd ?? process.cwd());
    const session = await this.transport.request(() => this.transport.client.session.create({ directory: cwd }));
    if (await canonicalDirectory(session.directory) !== cwd) throw new Error('OpenCode native session directory does not match the requested workspace.');
    return this.open(session, { cwd, model: config.model, agent: config.planning ? 'plan' : undefined }, config);
  }
  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}): Promise<OpenCodeSession> {
    this.assertOpen(); validateExtensions(extensions);
    if (handle.providerId !== 'opencode' || !handle.sessionId) throw new Error('Invalid OpenCode persistence handle.');
    let persisted: OpenCodePersistence;
    try { persisted = JSON.parse(handle.opaque); } catch { throw new Error('Invalid OpenCode persistence handle.'); }
    if (!persisted || typeof persisted.cwd !== 'string' || (persisted.model !== undefined && typeof persisted.model !== 'string') || (persisted.agent !== undefined && typeof persisted.agent !== 'string')) throw new Error('Invalid OpenCode persistence handle.');
    const cwd = await canonicalDirectory(persisted.cwd);
    const session = await this.transport.request(() => this.transport.client.session.get({ sessionID: handle.sessionId, directory: cwd }));
    if (await canonicalDirectory(session.directory) !== cwd) throw new Error('OpenCode native session directory does not match the requested workspace.');
    return this.open(session, { cwd, model: persisted.model, agent: persisted.agent }, extensions);
  }
  private async open(native: Session, config: OpenCodePersistence, extensions: AgentSessionExtensions): Promise<OpenCodeSession> {
    const session = new OpenCodeSession(this.transport, native.id, config, extensions, () => this.sessions.delete(session));
    this.sessions.add(session);
    try { await session.start(); return session; } catch (error) { await session.dispose(); throw error; }
  }
  async listSessions(): Promise<OpenCodeSessionSummary[]> {
    this.assertOpen();
    const sessions = new Map<string, OpenCodeSessionSummary>();
    let cursor: number | undefined;
    while (true) {
      const page = await this.transport.requestWithResponse(() => this.transport.client.experimental.session.list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) }));
      for (const session of page.data) if (!sessions.has(session.id)) sessions.set(session.id, summary(session));
      const next = page.response.headers.get('x-next-cursor');
      if (!next) return [...sessions.values()];
      const value = Number(next);
      if (!Number.isSafeInteger(value) || value < 0 || (cursor !== undefined && value >= cursor)) throw new Error('OpenCode global session pagination did not advance.');
      cursor = value;
    }
  }
  async getSession(id: string): Promise<OpenCodeSessionSummary | undefined> {
    this.assertOpen();
    try { return summary(await this.transport.request(() => this.transport.client.session.get({ sessionID: id }))); }
    catch (error) { if (error instanceof OpenCodeRequestError && error.status === 404) return undefined; throw error; }
  }
  async renameSession(id: string, title: string): Promise<void> {
    if (!title.trim()) throw new Error('OpenCode session title must not be empty.');
    const native = await this.getSession(id);
    if (!native) throw new Error('OpenCode session was not found.');
    if (native.title === title) return;
    await this.transport.request(() => this.transport.client.session.update({ sessionID: id, directory: native.cwd, title }));
  }
  async readSessionHistory(id: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
    const native = await this.getSession(id);
    if (!native) throw new Error('OpenCode session was not found.');
    const messages = await this.transport.request(() => this.transport.client.session.messages({ sessionID: id, directory: native.cwd }));
    const entries = messages.map(({ info, parts }) => ({ id: info.id, turnId: info.role === 'assistant' ? info.parentID : info.id, role: info.role, text: parts.flatMap(part => part.type === 'text' || part.type === 'reasoning' ? [part.text] : []).join('\n') })).filter(entry => (!query.turnId || entry.turnId === query.turnId) && (!query.query || entry.text.toLowerCase().includes(query.query.toLowerCase())));
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid OpenCode history cursor.');
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));
    const textOffset = Math.max(0, query.textOffset ?? 0);
    return { entries: entries.slice(offset, offset + limit).map(entry => ({ ...entry, totalChars: entry.text.length, textOffset, text: entry.text.slice(textOffset, textOffset + 12000) })), ...(offset + limit < entries.length ? { nextCursor: `${offset + limit}` } : {}) };
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await Promise.all([...this.sessions].map(session => session.dispose())); await this.transport.close(); }
  async dispose(): Promise<void> { await this.close(); }
}
