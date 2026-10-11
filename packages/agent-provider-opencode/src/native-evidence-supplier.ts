import { createHash } from 'node:crypto';
import { AgentOperationRejectedError, AGENT_NATIVE_EVIDENCE_REASONS, type AgentNativeAuthorityScope } from '@orchardworks/agent-provider-sdk';
import type { Agent, Config, GlobalEvent, ProviderListResponse, Session } from '@opencode-ai/sdk/v2/client';
import { nativeEvidenceEvent, type OpenCodeNativeEvidenceVerifier, type OpenCodeNativeSelections } from './native-evidence.js';
import { nativeSelections, openCodeModel } from './settings.js';
import type { OpenCodeTransport } from './transport.js';

type Profile = { cwd: string; generation: number; digest: string; config: Config; providers: ProviderListResponse; agents: Agent[]; reading: boolean };
type NativeIdentity = { id: string; directory: string; parentID?: string; selections: string };
function reject(): never { throw new AgentOperationRejectedError('native_evidence_unsupported', AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_unsupported); }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const profileEvents = new Set(['global.disposed', 'server.instance.disposed', 'models-dev.refreshed', 'integration.updated', 'integration.connection.updated', 'catalog.updated', 'reference.updated', 'installation.updated', 'plugin.added', 'mcp.tools.changed', 'project.updated', 'project.directories.updated', 'workspace.ready', 'workspace.failed', 'workspace.status', 'worktree.ready', 'worktree.failed']);
const informationalEvents = new Set(['server.connected', 'server.heartbeat', 'installation.update-available', 'file.edited', 'file.watcher.updated', 'lsp.updated', 'vcs.branch.updated']);

/** Current native facts on the provider's existing transport; no process or database ownership claim. */
export class OpenCodeNativeEvidenceSupplier implements OpenCodeNativeEvidenceVerifier {
  private readonly authority: AgentNativeAuthorityScope;
  private readonly profiles = new Map<string, Profile>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, NativeIdentity>();
  private readonly unresolved = new Map<string, string>();
  private resolving?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private generation = 0;
  private connected = false;
  private stream?: Promise<void>;
  private readonly connectionWaiters = new Set<() => void>();
  constructor(private readonly transport: OpenCodeTransport) {
    this.authority = Object.freeze({ kind: 'trusted-service', authorityId: 'opencode', namespaceId: transport.namespaceId });
  }
  private start(): void {
    if (this.stream) return;
    this.stream = this.transport.events(this.lifetime.signal, () => {
      this.connected = true;
      for (const resolve of this.connectionWaiters) resolve(); this.connectionWaiters.clear();
    }, () => {
      this.connected = false; this.sessions.clear(); this.unresolved.clear(); this.invalidate();
    }, event => this.receive(event));
  }
  private invalidate(): void {
    this.generation++; this.profiles.clear();
    for (const listener of this.listeners) listener();
  }
  private async waitConnected(): Promise<void> {
    this.start(); if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.connectionWaiters.delete(done); resolve(); };
      const timer = setTimeout(() => { this.connectionWaiters.delete(done); reject(new Error('Native observation is unavailable.')); }, this.transport.timeout);
      this.connectionWaiters.add(done);
    });
  }
  async refresh(cwd: string, force = false): Promise<void> {
    await this.waitConnected();
    if (!force && this.profiles.has(cwd)) { await this.resolveUnknown(); return; }
    const active = this.reads.get(cwd); if (active) return active;
    const task = this.readProfile(cwd).finally(() => { this.reads.delete(cwd); });
    this.reads.set(cwd, task); return task;
  }
  private async readProfile(cwd: string): Promise<void> {
    const generation = this.generation, previous = this.profiles.get(cwd);
    if (previous) previous.reading = true;
    try {
      const parameters = { directory: cwd };
      const [health, config, providers, agents, tools, capabilities] = await Promise.all([
        this.transport.request(() => this.transport.client.global.health()),
        this.transport.request(() => this.transport.client.config.get(parameters)),
        this.transport.request(() => this.transport.client.provider.list(parameters)),
        this.transport.request(() => this.transport.client.app.agents(parameters)),
        this.transport.request(() => this.transport.client.tool.ids(parameters)),
        this.transport.request(() => this.transport.client.experimental.capabilities.get(parameters)),
      ]);
      // This scope covers ordinary native runs and observed children, not background continuations.
      if (!health?.healthy || !/^1\.18\.\d+$/.test(health.version) || Number(health.version.split('.')[2]) < 18
        || capabilities?.backgroundSubagents !== false || !Array.isArray(tools) || tools.length > 4096 || tools.some(id => typeof id !== 'string' || id.length > 256)
        || !config || !Array.isArray(providers?.all) || !Array.isArray(providers?.connected) || !Array.isArray(agents)) reject();
      const declared = JSON.stringify({ config, providers, agents, tools, capabilities }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
      if (Buffer.byteLength(declared) > 1024 * 1024) reject();
      const digest = createHash('sha256').update(declared).digest('hex');
      if (!this.connected || generation !== this.generation || previous && this.profiles.get(cwd) !== previous) throw new Error('Native profile changed during observation.');
      if (previous?.digest === digest) previous.reading = false;
      else {
        this.profiles.set(cwd, { cwd, generation, digest, config, providers, agents, reading: false });
        if (previous) for (const listener of this.listeners) listener();
      }
      await this.resolveUnknown();
    } catch (error) {
      this.profiles.delete(cwd); if (previous) for (const listener of this.listeners) listener();
      throw error;
    } finally { if (previous) previous.reading = false; }
  }
  captureAuthority(transport: OpenCodeTransport, cwd: string) {
    const profile = this.profiles.get(cwd);
    if (transport !== this.transport || !profile || !this.isCurrent(profile)) return { status: 'unavailable' as const };
    return { status: 'verified' as const, authority: this.authority, lease: profile };
  }
  isCurrent(lease: object): boolean {
    const profile = lease as Profile;
    return !this.lifetime.signal.aborted && this.connected && profile.generation === this.generation && this.profiles.get(profile.cwd) === profile && !profile.reading;
  }
  isObservationCurrent(lease: object): boolean { return this.isCurrent(lease) && this.unresolved.size === 0; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  validateSelections(cwd: string, selected: OpenCodeNativeSelections): void {
    const profile = this.profiles.get(cwd), model = openCodeModel(selected.model);
    if (!profile || !this.isCurrent(profile) || !model || !profile.agents.some(agent => agent.name === selected.agent && !agent.hidden && agent.mode !== 'subagent')) reject();
    const provider = profile.providers.all.find(item => item.id === model.providerID), nativeModel = provider?.models[model.modelID];
    if (!profile.providers.connected.includes(model.providerID) || !nativeModel || selected.variant !== undefined && !Object.hasOwn(nativeModel.variants ?? {}, selected.variant)) reject();
  }
  async targetSelections(cwd: string, selectionSourceSessionId?: string): Promise<OpenCodeNativeSelections> {
    const profile = this.profiles.get(cwd); if (!profile || !this.isCurrent(profile)) reject();
    let selected: OpenCodeNativeSelections | undefined;
    if (selectionSourceSessionId) {
      const source = await this.transport.request(() => this.transport.client.session.get({ sessionID: selectionSourceSessionId, directory: cwd }));
      if (source?.id !== selectionSourceSessionId || source.directory !== cwd || !this.isCurrent(profile)) reject();
      this.observeSession(source); selected = nativeSelections(source);
    } else {
      const agent = profile.agents.find(item => item.name === profile.config.default_agent);
      if (agent) {
        const model = agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : profile.config.model;
        if (model) selected = { agent: agent.name, model, ...(agent.variant ? { variant: agent.variant } : {}) };
      }
    }
    if (!selected) reject(); this.validateSelections(cwd, selected); return selected;
  }
  observeSession(session: Session): void {
    if (!session || !identity(session.id) || typeof session.directory !== 'string' || !session.directory || session.parentID !== undefined && !identity(session.parentID)) reject();
    const previous = this.sessions.get(session.id);
    const selections = JSON.stringify(nativeSelections(session) ?? null);
    if (previous && (previous.directory !== session.directory || previous.parentID !== session.parentID || previous.selections !== selections)) this.invalidate();
    if (!previous && this.sessions.size >= 4096) { this.invalidate(); reject(); }
    this.sessions.set(session.id, { id: session.id, directory: session.directory, selections, ...(session.parentID ? { parentID: session.parentID } : {}) });
    this.unresolved.delete(session.id);
    if (session.parentID && !this.sessions.has(session.parentID)) this.unresolved.set(session.parentID, session.directory);
  }
  relation(first: string, second: string): 'self' | 'related' | 'independent' | 'unknown' {
    if (first === second) return 'self';
    const ancestry = (id: string): string[] | undefined => {
      const chain: string[] = [];
      for (let depth = 0; depth < 64; depth++) {
        if (chain.includes(id)) return;
        const session = this.sessions.get(id); if (!session) return;
        chain.push(id); if (!session.parentID) return chain; id = session.parentID;
      }
    };
    const a = ancestry(first), b = ancestry(second); if (!a || !b) return 'unknown';
    return a.includes(second) || b.includes(first) ? 'related' : 'independent';
  }
  private receive(global: GlobalEvent): void {
    const event = nativeEvidenceEvent(global);
    if (!event?.type) { this.invalidate(); return; }
    if (informationalEvents.has(event.type)) return;
    if (profileEvents.has(event.type) || event.type === 'session.next.agent.switched' || event.type === 'session.next.model.switched') { this.invalidate(); return; }
    const properties = event.properties ?? {};
    if (['session.created', 'session.updated', 'session.deleted'].includes(event.type)) {
      const native = properties.info;
      try {
        if (properties.sessionID !== undefined && properties.sessionID !== native?.id) reject();
        if (event.type === 'session.deleted') { this.sessions.delete(native?.id); this.invalidate(); }
        else this.observeSession(native);
      } catch { this.invalidate(); }
      return;
    }
    const id = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;
    if (identity(id) && !this.sessions.has(id) && typeof global.directory === 'string') {
      if (this.unresolved.size >= 4096) { this.invalidate(); return; }
      this.unresolved.set(id, global.directory);
      for (const listener of this.listeners) listener();
      void this.resolveUnknown().catch(() => undefined);
    } else if (!id && !event.type.startsWith('pty.')) this.invalidate();
  }
  private resolveUnknown(): Promise<void> {
    if (!this.resolving) this.resolving = this.resolveAncestry().finally(() => { this.resolving = undefined; });
    return this.resolving;
  }
  private async resolveAncestry(): Promise<void> {
    for (const [id, directory] of [...this.unresolved].slice(0, 64)) {
      let current = id;
      for (let depth = 0; depth < 64 && !this.sessions.has(current); depth++) {
        const generation = this.generation;
        const native = await this.transport.request(() => this.transport.client.session.get({ sessionID: current, directory }));
        if (generation !== this.generation || !this.connected || native.id !== current || native.directory !== directory) throw new Error('Native ancestry changed during readback.');
        this.observeSession(native); if (!native.parentID) break; current = native.parentID;
      }
      for (const listener of this.listeners) listener();
    }
  }
  async activeDescendants(nativeId: string, cwd: string, activeIds: readonly string[]): Promise<number> {
    const ids = [...new Set(activeIds)].filter(id => id !== nativeId);
    if (ids.length > 4096 || ids.some(id => !identity(id))) reject();
    for (const id of ids) if (!this.sessions.has(id)) this.unresolved.set(id, cwd);
    await this.resolveUnknown();
    let count = 0;
    for (const id of ids) {
      let current = id; const visited = new Set<string>(); let resolved = false;
      for (let depth = 0; depth < 64; depth++) {
        if (current === nativeId) { count++; resolved = true; break; }
        if (visited.has(current)) reject(); visited.add(current);
        const native = this.sessions.get(current); if (!native) reject();
        if (!native.parentID) { resolved = true; break; }
        current = native.parentID;
      }
      if (!resolved) reject();
    }
    return count;
  }
  async close(): Promise<void> { this.lifetime.abort(); this.connected = false; this.invalidate(); await this.stream; }
}
