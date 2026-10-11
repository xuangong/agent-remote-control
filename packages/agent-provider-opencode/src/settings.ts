import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { validateSessionSetting, type AgentSessionSetting } from '@orchardworks/agent-provider-sdk';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentInfo, ModelInfo, PermissionRuleset, SessionInfo } from '@opencode/client';
import { OpenCodeRequestError, OpenCodeTransport } from './transport.js';

export interface OpenCodeSelection {
  model?: string;
  agent?: string;
  variant?: string;
}

/** Native V2 represents an omitted model variant as the reserved `default` value. */
export function nativeVariant(value?: string): string | undefined {
  return value === 'default' ? undefined : value;
}

export function openCodeModel(value?: string): { providerID: string; modelID: string } | undefined {
  if (value === undefined) return;
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) throw new Error('OpenCode models use provider/model identifiers.');
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

export function nativeSelections(session: SessionInfo | undefined): { model: string; agent: string; variant?: string } | undefined {
  if (!session?.agent || !session.model?.providerID || !session.model.id) return;
  const variant = nativeVariant(session.model.variant);
  return { agent: session.agent, model: `${session.model.providerID}/${session.model.id}`, ...(variant ? { variant } : {}) };
}

/** Session-local native controls; never writes project or global configuration. */
export class OpenCodeSettings {
  private models: ModelInfo[] = [];
  private agents: AgentInfo[] = [];
  private permission: PermissionRuleset = [];
  private native?: SessionInfo;
  private nativeRevision = 0;
  get revision(): number { return this.nativeRevision; }
  constructor(
    private readonly transport: OpenCodeTransport,
    private readonly nativeId: string,
    private readonly cwd: string,
    private readonly selected: OpenCodeSelection,
  ) {}

  async refresh(): Promise<SessionInfo> {
    const revision = this.nativeRevision;
    const parameters = { location: { directory: this.cwd } };
    const [models, agents, session] = await Promise.all([
      this.transport.request(() => this.transport.client.model.list(parameters)),
      this.transport.request(() => this.transport.client.agent.list(parameters)),
      this.transport.request(() => this.transport.client.session.get({ sessionID: this.nativeId })),
    ]);
    this.models = models.data;
    this.agents = agents.data;
    this.updateNative(session, revision);
    return this.native!;
  }

  updateNative(session: SessionInfo, expectedRevision = this.nativeRevision): boolean {
    if (expectedRevision !== this.nativeRevision) return false;
    this.nativeRevision++;
    this.native = session;
    this.permission = session.permissions ?? [];
    // Older sessions may not contain durable selections; retain their message/persistence fallback.
    if (session.agent !== undefined) this.selected.agent = session.agent;
    if (session.model !== undefined) {
      this.selected.model = `${session.model.providerID}/${session.model.id}`;
      const variant = nativeVariant(session.model.variant);
      if (!variant) delete this.selected.variant;
      else this.selected.variant = variant;
    }
    return true;
  }

  private variants(): string[] {
    const model = openCodeModel(this.selected.model);
    return (this.models.find(item => item.providerID === model?.providerID && item.id === model?.modelID)?.variants ?? []).map(variant => variant.id).filter(value => value.length > 0 && value !== 'default');
  }

  private defaultVariantValue(): string {
    let value = 'opencode:default';
    const variants = this.variants();
    while (variants.includes(value)) value = `opencode:${value}`;
    return value;
  }

  contextWindows(): ReadonlyMap<string, number> {
    const windows = new Map<string, number>();
    for (const model of this.models) {
      const context = model.limit?.context;
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) windows.set(`${model.providerID}/${model.id}`, context);
    }
    return windows;
  }

  planningAgentId(id: 'plan' | 'build'): string | undefined {
    return this.agents.find(agent => agent.id === id && !agent.hidden && agent.mode !== 'subagent')?.id;
  }

  get planningAvailable(): boolean {
    return !this.transport.restricted && this.planningAgentId('plan') !== undefined && this.planningAgentId('build') !== undefined;
  }

  list(): AgentSessionSetting[] {
    const mutable = !this.transport.restricted;
    const description = 'Saved to the native session for its next supported execution boundary.';
    const modelOptions = this.models.filter(model => model.enabled).map(model => ({ value: `${model.providerID}/${model.id}`, label: `${model.providerID}: ${model.name}` }));
    const variants = this.variants();
    const agent = this.agents.find(agent => agent.id === this.selected.agent);
    const settings: AgentSessionSetting[] = [
      { id: 'model', category: 'model', label: 'Model', value: this.selected.model ?? null, mutable, scope: 'session', description, options: modelOptions },
      { id: 'agent', category: 'model', label: 'Agent', value: this.selected.agent ?? null, mutable, scope: 'session', description, options: this.agents.filter(agent => !agent.hidden && agent.mode !== 'subagent').map(agent => ({ value: agent.id, label: agent.name, description: agent.description })) },
    ];
    if (variants.length || this.selected.variant !== undefined) settings.push({
      id: 'variant', category: 'model', label: 'Model variant', value: this.selected.variant || this.defaultVariantValue(), mutable, scope: 'session',
      description: `Native model-specific variant; its meaning depends on the model and is not a universal reasoning-effort level. Native default uses the model without a variant overlay. ${description}`,
      options: [{ value: this.defaultVariantValue(), label: 'Model default' }, ...variants.map(value => ({ value, label: value }))],
    });
    const rules = [...(agent?.permissions ?? []), ...this.permission];
    const names = [...new Set(['*', ...rules.map(rule => rule.action)])].filter(name => name === '*' || !/[?*]/u.test(name));
    for (const name of names) {
      const matching = rules.filter(rule => rule.action === '*' || rule.action === name);
      const last = matching.at(-1);
      settings.push({
        id: `permission:${name}`, category: 'permissions', label: name === '*' ? 'All native permissions' : `Permission: ${name}`,
        value: last?.resource === '*' ? last.effect : null, mutable, scope: 'session',
        description: 'Adds a native session permission rule for all matching paths/actions. This overrides earlier matching rules, including agent defaults; it does not configure an OS sandbox. A blank value means inherited or path-specific rules.',
        options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }],
      });
    }
    return settings;
  }

  async set(id: string, value: string): Promise<void> {
    const setting = this.list().find(item => item.id === id);
    if (!this.transport.restricted && ['model', 'agent', 'variant'].includes(id) && !setting?.options.some(option => option.value === value)) {
      // Native catalogs can be empty while a new location's provider plugins initialize.
      // Read until the requested option is authoritative; never retry the mutation itself.
      const deadline = Date.now() + Math.min(this.transport.timeout, 5000);
      let observedCatalog = false;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const parameters = { location: { directory: this.cwd } };
        const requestOptions = { signal: AbortSignal.timeout(remaining) };
        try {
          const [models, agents] = await Promise.all([
            this.transport.request(() => this.transport.client.model.list(parameters, requestOptions)),
            this.transport.request(() => this.transport.client.agent.list(parameters, requestOptions)),
          ]);
          this.models = models.data; this.agents = agents.data; observedCatalog = true;
        } catch (error) {
          if (observedCatalog && requestOptions.signal.aborted && error instanceof OpenCodeRequestError && error.status === undefined && error.nativeCode === undefined) break;
          throw error;
        }
        if (this.list().find(item => item.id === id)?.options.some(option => option.value === value)) break;
        if (Date.now() >= deadline) break;
        await delay(Math.min(50, deadline - Date.now()));
      } while (Date.now() < deadline);
    }
    validateSessionSetting(this.list(), id, value);
    if (id.startsWith('permission:')) {
      const action = id.slice('permission:'.length);
      // V2 replaces the session ruleset. Keep scoped rules and replace only our broad override.
      const current = await this.transport.request(() => this.transport.client.session.get({ sessionID: this.nativeId }));
      const permissions: PermissionRuleset = [
        ...(current.permissions ?? []).filter(rule => rule.action !== action || rule.resource !== '*'),
        { action, resource: '*', effect: value as 'ask' | 'allow' | 'deny' },
      ];
      await this.transport.request(() => this.transport.client.session.update({ sessionID: this.nativeId, permissions }));
      const revision = ++this.nativeRevision;
      const response = await this.transport.request(() => this.transport.client.session.get({ sessionID: this.nativeId }));
      this.updateNative(response, revision);
      if (this.list().find(setting => setting.id === id)?.value !== value) {
        throw new Error('OpenCode did not confirm the requested session permission. Its outcome is unknown.');
      }
      return;
    }
    const next = { ...this.selected };
    if (id === 'model') { next.model = value; delete next.variant; }
    else if (id === 'agent') next.agent = value;
    else if (id === 'variant') { if (value === this.defaultVariantValue()) delete next.variant; else next.variant = value; }
    else throw new AgentOperationRejectedError('operation_rejected', 'Unsupported OpenCode setting.');
    if (id === 'agent') await this.transport.request(() => this.transport.client.session.switchAgent({ sessionID: this.nativeId, agent: next.agent! }));
    else {
      const model = openCodeModel(next.model);
      if (!model) throw new AgentOperationRejectedError('operation_rejected', 'Select an OpenCode model before choosing its variant.');
      await this.transport.request(() => this.transport.client.session.switchModel({ sessionID: this.nativeId, model: { providerID: model.providerID, id: model.modelID, ...(next.variant ? { variant: next.variant } : {}) } }));
    }
    const revision = ++this.nativeRevision;
    const response = await this.transport.request(() => this.transport.client.session.get({ sessionID: this.nativeId }));
    this.updateNative(response, revision);
    const session = this.native;
    const confirmed = id === 'agent' ? session?.agent === next.agent
      : session?.model !== undefined && `${session.model.providerID}/${session.model.id}` === next.model && nativeVariant(session.model.variant) === nativeVariant(next.variant);
    if (!confirmed) throw new Error('OpenCode did not confirm the requested session selection. Its outcome is unknown.');
  }

}
