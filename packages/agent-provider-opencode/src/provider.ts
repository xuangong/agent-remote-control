import { OpenCodeCallbackBridge, CALLBACK_TOOL_IDS } from './callback-bridge.js';
import { readReferenceHistory } from './reference-history.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentHistoryPage, AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeTransport, OpenCodeRequestError, type OpenCodeAgentProviderOptions } from './transport.js';
import { OpenCodeSession } from './session.js';
import { preparePromptEdit, type OpenCodePromptEditTarget } from './prompt-edit.js';
export type { OpenCodeAgentProviderOptions } from './transport.js';
export interface OpenCodeSessionSummary { id: string; title: string; cwd: string; updatedAt: string; createdAt?: string; parentId?: string; }
export interface OpenCodePersistence { cwd: string; model?: string; agent?: string; variant?: string; }
export async function canonicalDirectory(cwd: string): Promise<string> { return realpath(resolve(cwd)); }
function summary(session: Session): OpenCodeSessionSummary {
  return { id: session.id, title: session.title, cwd: session.directory, updatedAt: new Date(session.time.updated).toISOString(), createdAt: new Date(session.time.created).toISOString(), ...(session.parentID ? { parentId: session.parentID } : {}) };
}
export class OpenCodeAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'opencode', displayName: 'OpenCode' };
  private readonly transport: OpenCodeTransport;
  private readonly sessions = new Set<OpenCodeSession>();
  private closed = false;
  private readonly callbackBridge?: OpenCodeCallbackBridge;
  constructor(options: OpenCodeAgentProviderOptions = {}) {
    if (options.restrictedNative) throw new Error('OpenCode shared server permissions cannot be restricted by the Host. Explicitly trust the native server permissions to connect.');
    this.transport = new OpenCodeTransport(options);
    if (options.callbackConfigPath) this.callbackBridge = new OpenCodeCallbackBridge(options.callbackConfigPath, new URL(options.serverUrl ?? 'http://127.0.0.1:4096').toString().replace(/\/$/, ''));
  }
  private assertOpen(): void { if (this.closed) throw new Error('OpenCode provider is closed.'); }
  async createSession(config: AgentSessionConfig): Promise<OpenCodeSession> {
    this.assertOpen();
    if (config.reasoningEffort !== undefined) throw new Error('OpenCode reasoning effort selection is not supported.');
    if (this.transport.restricted) throw new Error('OpenCode shared sessions require an unrestricted Host execution policy.');
    const cwd = await canonicalDirectory(config.cwd ?? process.cwd());
    if (config.tools?.length && !await this.supportsHostCallbacks(cwd)) throw new Error('OpenCode Host callbacks require an installed and connected ARC native plugin.');
    const session = await this.transport.request(() => this.transport.client.session.create({ directory: cwd }));
    if (await canonicalDirectory(session.directory) !== cwd) throw new Error('OpenCode native session directory does not match the requested workspace.');
    const opened = await this.open(session, { cwd, model: config.model, agent: config.planning ? 'plan' : undefined }, config);
    try {
      if (config.model !== undefined) await opened.setSessionSetting('model', config.model);
      if (config.planning !== undefined) await opened.setPlanning(config.planning);
      return opened;
    } catch (error) { await opened.dispose(); throw error; }
  }
  async resumeSession(handle: AgentPersistenceHandle, extensions: AgentSessionExtensions = {}): Promise<OpenCodeSession> {
    this.assertOpen();
    if (handle.providerId !== 'opencode' || !handle.sessionId) throw new Error('Invalid OpenCode persistence handle.');
    let persisted: OpenCodePersistence;
    try { persisted = JSON.parse(handle.opaque); } catch { throw new Error('Invalid OpenCode persistence handle.'); }
    if (!persisted || typeof persisted.cwd !== 'string' || (persisted.model !== undefined && typeof persisted.model !== 'string') || (persisted.agent !== undefined && typeof persisted.agent !== 'string') || (persisted.variant !== undefined && typeof persisted.variant !== 'string')) throw new Error('Invalid OpenCode persistence handle.');
    const cwd = await canonicalDirectory(persisted.cwd);
    const session = await this.transport.request(() => this.transport.client.session.get({ sessionID: handle.sessionId, directory: cwd }));
    if (await canonicalDirectory(session.directory) !== cwd) throw new Error('OpenCode native session directory does not match the requested workspace.');
    return this.open(session, { cwd, model: persisted.model, agent: persisted.agent, variant: persisted.variant }, extensions);
  }
  async validatePromptEdit(target: OpenCodePromptEditTarget): Promise<void> {
    this.assertOpen(); await preparePromptEdit(this.transport, target);
  }
  async forkForPromptEdit(target: OpenCodePromptEditTarget): Promise<OpenCodeSession> {
    this.assertOpen();
    const config = await preparePromptEdit(this.transport, target);
    const native = await this.transport.request(() => this.transport.client.session.fork({ sessionID: target.nativeSessionId, messageID: target.messageId, directory: config.cwd }));
    if (!native.id || native.id === target.nativeSessionId) throw new Error('OpenCode did not create an independent prompt-edit branch.');
    if (await canonicalDirectory(native.directory) !== config.cwd) throw new Error('OpenCode prompt-edit branch workspace does not match the source.');
    return this.open(native, config, {});
  }
  async openChildSession(parentNativeSessionId: string, childNativeSessionId: string): Promise<OpenCodeSession> {
    this.assertOpen();
    const parent = await this.transport.request(() => this.transport.client.session.get({ sessionID: parentNativeSessionId }));
    const child = await this.transport.request(() => this.transport.client.session.get({ sessionID: childNativeSessionId }));
    if (parent.id !== parentNativeSessionId || child.id !== childNativeSessionId || child.parentID !== parentNativeSessionId) throw new Error('The requested OpenCode session is not a direct native child.');
    const cwd = await canonicalDirectory(parent.directory);
    if (await canonicalDirectory(child.directory) !== cwd) throw new Error('The OpenCode child workspace does not match its parent.');
    return this.open(child, { cwd }, {});
  }
  private async open(native: Session, config: OpenCodePersistence, extensions: AgentSessionExtensions): Promise<OpenCodeSession> {
    let release: (() => void) | undefined;
    if (extensions.tools?.length) {
      if (!await this.supportsHostCallbacks(config.cwd)) throw new Error('OpenCode Host callbacks require an installed and connected ARC native plugin.');
      release = this.callbackBridge!.bind(native.id, extensions.tools);
      extensions = { ...extensions, systemPrompt: [extensions.systemPrompt,
        'Host tools are exposed through arc_host_discover and arc_host_invoke. First discover the callbacks authorized for this session. To use read_source_session or another Host callback, call arc_host_invoke with its exact name and an arguments object matching its schema. The native session identity and authorized source are fixed by the Host and cannot be selected in arguments.',
      ].filter(Boolean).join('\n\n') };
    }
    const session = new OpenCodeSession(this.transport, native.id, config, extensions, () => { release?.(); this.sessions.delete(session); });
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
    return readReferenceHistory(this.transport, id, native.cwd, query);
  }
  async supportsHostCallbacks(cwd: string): Promise<boolean> {
    this.assertOpen();
    if (!this.callbackBridge) return false;
    await this.callbackBridge.start();
    const directory = await canonicalDirectory(cwd);
    try {
      const ids = await this.transport.request(() => this.transport.client.tool.ids({ directory }));
      return CALLBACK_TOOL_IDS.every(id => ids.includes(id)) && await this.callbackBridge.waitForPlugin(directory);
    } catch { return false; }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await Promise.all([...this.sessions].map(session => session.dispose())); await this.transport.close(); await this.callbackBridge?.close(); }
  async dispose(): Promise<void> { await this.close(); }
}
