import { validateSessionSetting, type AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import type { Agent, PermissionRuleset, ProviderListResponse, Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeTransport } from './transport.js';

export interface OpenCodeSelection {
  model?: string;
  agent?: string;
  variant?: string;
}

export function openCodeModel(value?: string): { providerID: string; modelID: string } | undefined {
  if (value === undefined) return;
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) throw new Error('OpenCode models use provider/model identifiers.');
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

/** Session-local native controls; never writes project or global configuration. */
export class OpenCodeSettings {
  private providers?: ProviderListResponse;
  private agents: Agent[] = [];
  private permission: PermissionRuleset = [];
  private native?: Session;
  constructor(
    private readonly transport: OpenCodeTransport,
    private readonly nativeId: string,
    private readonly cwd: string,
    private readonly selected: OpenCodeSelection,
  ) {}

  async refresh(): Promise<Session> {
    const parameters = { directory: this.cwd };
    const [providers, agents, session] = await Promise.all([
      this.transport.request(() => this.transport.client.provider.list(parameters)),
      this.transport.request(() => this.transport.client.app.agents(parameters)),
      this.transport.request(() => this.transport.client.session.get({ ...parameters, sessionID: this.nativeId })),
    ]);
    this.providers = providers;
    this.agents = agents;
    this.updateNative(session);
    return session;
  }

  updateNative(session: Session): void {
    this.native = session;
    this.permission = session.permission ?? [];
    // Older sessions may not contain durable selections; retain their message/persistence fallback.
    if (session.agent !== undefined) this.selected.agent = session.agent;
    if (session.model !== undefined) {
      this.selected.model = `${session.model.providerID}/${session.model.id}`;
      if (!session.model.variant) delete this.selected.variant;
      else this.selected.variant = session.model.variant;
    }
  }

  private variants(): string[] {
    const model = openCodeModel(this.selected.model);
    return Object.keys(this.providers?.all.find(provider => provider.id === model?.providerID)?.models[model?.modelID ?? '']?.variants ?? {}).filter(value => value.length > 0);
  }

  private defaultVariantValue(): string {
    let value = 'opencode:default';
    const variants = this.variants();
    while (variants.includes(value)) value = `opencode:${value}`;
    return value;
  }

  contextWindows(): ReadonlyMap<string, number> {
    const windows = new Map<string, number>();
    for (const provider of this.providers?.all ?? []) for (const model of Object.values(provider.models)) {
      const context = model.limit?.context;
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) windows.set(`${provider.id}/${model.id}`, context);
    }
    return windows;
  }

  get planningAvailable(): boolean {
    return !this.transport.restricted && ['plan', 'build'].every(name => this.agents.some(agent => agent.name === name && !agent.hidden && agent.mode !== 'subagent'));
  }

  list(): AgentSessionSetting[] {
    const mutable = !this.transport.restricted;
    const description = 'Saved to the native session for subsequent turns.';
    const providers = this.providers;
    const modelOptions = providers?.all.filter(provider => providers.connected.includes(provider.id)).flatMap(provider => Object.values(provider.models).map(model => ({ value: `${provider.id}/${model.id}`, label: `${provider.name}: ${model.name}` }))) ?? [];
    const variants = this.variants();
    const agent = this.agents.find(agent => agent.name === this.selected.agent);
    const settings: AgentSessionSetting[] = [
      { id: 'model', category: 'model', label: 'Model', value: this.selected.model ?? null, mutable, scope: 'session', description, options: modelOptions },
      { id: 'agent', category: 'model', label: 'Agent', value: this.selected.agent ?? null, mutable, scope: 'session', description, options: this.agents.filter(agent => !agent.hidden && agent.mode !== 'subagent').map(agent => ({ value: agent.name, label: agent.name, description: agent.description })) },
    ];
    if (variants.length || this.selected.variant !== undefined) settings.push({
      id: 'variant', category: 'model', label: 'Model variant', value: this.selected.variant || null, mutable, scope: 'session',
      description: `Native model-specific variant; its meaning depends on the model and is not a universal reasoning-effort level. ${description}`,
      options: [{ value: this.defaultVariantValue(), label: 'Agent/model default' }, ...variants.map(value => ({ value, label: value }))],
    });
    const rules = [...(agent?.permission ?? []), ...this.permission];
    const names = [...new Set(['*', ...rules.map(rule => rule.permission)])].filter(name => name === '*' || !/[?*]/u.test(name));
    for (const name of names) {
      const matching = rules.filter(rule => rule.permission === '*' || rule.permission === name);
      const last = matching.at(-1);
      settings.push({
        id: `permission:${name}`, category: 'permissions', label: name === '*' ? 'All native permissions' : `Permission: ${name}`,
        value: last?.pattern === '*' ? last.action : null, mutable, scope: 'session',
        description: 'Adds a native session permission rule for all matching paths/actions. This overrides earlier matching rules, including agent defaults; it does not configure an OS sandbox. A blank value means inherited or path-specific rules.',
        options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }],
      });
    }
    return settings;
  }

  async set(id: string, value: string): Promise<void> {
    validateSessionSetting(this.list(), id, value);
    if (id.startsWith('permission:')) {
      const rule = { permission: id.slice('permission:'.length), pattern: '*', action: value as 'ask' | 'allow' | 'deny' };
      const session = await this.transport.request(() => this.transport.client.session.update({ sessionID: this.nativeId, directory: this.cwd, permission: [rule] }));
      this.updateNative(session);
      return;
    }
    const next = { ...this.selected };
    if (id === 'model') { next.model = value; delete next.variant; }
    else if (id === 'agent') next.agent = value;
    else if (id === 'variant') { if (value === this.defaultVariantValue()) delete next.variant; else next.variant = value; }
    else throw new Error('Unsupported OpenCode setting.');
    if (id === 'agent') await this.transport.request(() => this.transport.client.v2.session.switchAgent({ sessionID: this.nativeId, agent: next.agent }));
    else {
      const model = openCodeModel(next.model);
      if (!model) throw new Error('Select an OpenCode model before choosing its variant.');
      await this.transport.request(() => this.transport.client.v2.session.switchModel({ sessionID: this.nativeId, model: { providerID: model.providerID, id: model.modelID, ...(next.variant ? { variant: next.variant } : {}) } }));
    }
    Object.assign(this.selected, next);
    if (next.variant === undefined) delete this.selected.variant;
  }

  /** Older native compaction routes require an explicit provider/model pair. */
  compactionModel(): { providerID: string; modelID: string } {
    const selected = openCodeModel(this.selected.model);
    if (selected) return selected;
    if (this.native?.model) return { providerID: this.native.model.providerID, modelID: this.native.model.id };
    const agent = this.agents.find(agent => agent.name === this.selected.agent);
    if (agent?.model) return agent.model;
    throw new Error('Choose an available OpenCode model before compacting this session.');
  }
}
