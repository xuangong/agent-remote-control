import { validateSessionSetting, type AgentSessionSetting, type AgentSessionSettingOption } from '@agent-remote-controller/agent-provider-sdk';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isRecord, nonEmptyString } from './native.js';

interface ModelSelection { provider: string; model: string; reasoningEffort?: string; }
interface ModelOption extends AgentSessionSettingOption {
  selection: ModelSelection;
  efforts: Array<AgentSessionSettingOption & { selection: ModelSelection }>;
}
const MODEL_SCOPE_DESCRIPTION = 'DSH applies the selection to the next session request and attempts to save it as the default for future sessions. A default-save failure is reported only in the native DSH log.';
interface ModelController {
  modelCatalog(): Promise<unknown>;
  selectModel(input: ModelSelection & { sessionId: string }): Promise<unknown>;
}
interface PermissionPresets {
  names: readonly string[];
  current(session: Agent['session']): string;
  optionOf(name: string): { value: string; name: string; description?: string };
}
interface NativeCommands {
  list?(agent: Agent): readonly { name: string }[];
  view?(agent: Agent): { get(name: string): unknown };
  execute(agent: Agent, line: string, images: readonly never[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>;
}

export class DshSessionSettings {
  private models: ModelOption[] = [];
  private loading: Promise<void> | undefined;
  private failure: string | undefined;

  constructor(private readonly agent: Agent, private readonly service: (name: string) => unknown) {}

  get supported(): boolean { return this.controller() !== undefined || this.presets() !== undefined; }

  load(): Promise<void> {
    this.loading ??= this.loadCatalog().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async loadCatalog(): Promise<void> {
    const controller = this.controller();
    if (!controller) {
      this.models = [];
      this.failure = undefined;
      return;
    }
    try {
      const catalog = await controller.modelCatalog();
      if (!isRecord(catalog) || !Array.isArray(catalog.groups)) throw new Error('Native model catalog unavailable.');
      this.models = catalog.groups.flatMap((group) => {
        if (!isRecord(group) || !nonEmptyString(group.id) || !Array.isArray(group.models)) return [];
        return group.models.flatMap((model) => {
          if (!isRecord(model) || !nonEmptyString(model.id)) return [];
          const selection = { provider: String(group.id), model: String(model.id) };
          const reasoning = isRecord(model.reasoning) ? model.reasoning : undefined;
          const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts.flatMap((effort) => {
            if (!isRecord(effort) || !nonEmptyString(effort.id)) return [];
            const effortSelection = { ...selection, reasoningEffort: String(effort.id) };
            return [{ value: effortValue(effortSelection), label: nonEmptyString(effort.name) ?? String(effort.id),
              ...(nonEmptyString(effort.description) ? { description: String(effort.description) } : {}), selection: effortSelection }];
          }) : [];
          return [{ value: modelValue(selection), label: `${nonEmptyString(group.name) ?? group.id} / ${nonEmptyString(model.name) ?? model.id}`,
            ...(nonEmptyString(model.description) ? { description: String(model.description) } : {}), selection, efforts }];
        });
      });
      this.failure = undefined;
    } catch (error) {
      this.models = [];
      this.failure = error instanceof Error ? error.message : 'Native model catalog unavailable.';
    }
  }

  currentModel(): string | undefined { return this.selection()?.model; }

  describe(): AgentSessionSetting[] {
    if (!this.supported) return [];
    const selection = this.selection();
    const settings: AgentSessionSetting[] = [{
      id: 'model', category: 'model', label: 'Model', value: selection ? modelValue(selection) : null,
      options: this.models.map(({ selection: _selection, efforts: _efforts, ...option }) => option),
      mutable: this.controller() !== undefined && this.models.length > 0, scope: 'session_and_default',
      description: this.failure ?? MODEL_SCOPE_DESCRIPTION,
    }];
    const model = selection && this.models.find(({ value }) => value === modelValue(selection));
    if (model && model.efforts.length > 0) {
      settings.push({
        id: 'effort', category: 'model', label: 'Reasoning effort',
        value: selection?.reasoningEffort ? effortValue(selection) : null,
        options: model.efforts.map(({ selection: _selection, ...option }) => option),
        mutable: this.controller() !== undefined, scope: 'session_and_default', description: MODEL_SCOPE_DESCRIPTION,
      });
    }
    const presets = this.presets();
    if (presets) {
      const commands = this.commands();
      const mutable = commands?.list ? commands.list(this.agent).some(({ name }) => name === 'permission')
        : commands?.view?.(this.agent).get('permission') !== undefined;
      settings.push({
        id: 'permissions', category: 'permissions', label: 'Permissions', value: presets.current(this.agent.session),
        options: presets.names.map((name) => {
          const option = presets.optionOf(name);
          return { value: option.value, label: option.name, ...(option.description ? { description: option.description } : {}) };
        }),
        mutable, scope: 'session',
        description: mutable ? 'Native DSH permission preset (sandbox and approval policy).' : 'The native /permission command is unavailable; read-only.',
      });
    }
    return settings;
  }

  async select(id: string, value: string): Promise<void> {
    await this.load();
    validateSessionSetting(this.describe(), id, value);
    if (id === 'model') {
      const selected = this.models.find((model) => model.value === value)!;
      await this.controller()!.selectModel({ sessionId: this.agent.session.id, ...selected.selection });
      return;
    }
    if (id === 'effort') {
      const selected = this.models.flatMap((model) => model.efforts).find((effort) => effort.value === value)!;
      await this.controller()!.selectModel({ sessionId: this.agent.session.id, ...selected.selection });
      return;
    }
    if (id === 'permissions') {
      const execution = await this.commands()!.execute(this.agent, `/permission ${value}`, [], new AbortController().signal);
      if (execution?.result.kind !== 'success') throw new Error(execution?.result.text ?? 'Native permission command rejected.');
      return;
    }
    throw new Error('Unsupported DSH session setting.');
  }

  private selection(): ModelSelection | undefined {
    if (!this.controller()) return undefined;
    const projections = this.service('sessionProjections');
    const state: unknown = isRecord(projections) && typeof projections.stateOf === 'function'
      ? projections.stateOf(this.agent.session, 'modelSelection') : undefined;
    if (isRecord(state)) {
      const pending = selectionOf(state.pending);
      if (pending) return pending;
      const lastUsed = selectionOf(state.lastUsed);
      if (lastUsed) return lastUsed;
    }
    const session = this.agent.session as unknown as { requestHeader?(): unknown };
    const header = session.requestHeader?.();
    const logged = isRecord(header) ? selectionOf(header.config) : undefined;
    if (logged) return logged;
    const defaults = this.service('agentDefaultModel');
    return isRecord(defaults) && typeof defaults.currentSelection === 'function' ? selectionOf(defaults.currentSelection()) : undefined;
  }

  private controller(): ModelController | undefined {
    const value = this.service('sessionController');
    return isRecord(value) && typeof value.modelCatalog === 'function' && typeof value.selectModel === 'function' ? value as unknown as ModelController : undefined;
  }
  private presets(): PermissionPresets | undefined {
    const value = this.service('permissionPresets');
    return isRecord(value) && Array.isArray(value.names) && typeof value.current === 'function' && typeof value.optionOf === 'function' ? value as unknown as PermissionPresets : undefined;
  }
  private commands(): NativeCommands | undefined {
    const value = this.service('commands');
    return isRecord(value) && (typeof value.list === 'function' || typeof value.view === 'function') && typeof value.execute === 'function' ? value as unknown as NativeCommands : undefined;
  }
}

function selectionOf(value: unknown): ModelSelection | undefined {
  return isRecord(value) && nonEmptyString(value.provider) && nonEmptyString(value.model) ? {
    provider: String(value.provider), model: String(value.model),
    ...(nonEmptyString(value.reasoningEffort) ? { reasoningEffort: String(value.reasoningEffort) } : {}),
  } : undefined;
}
function modelValue(selection: ModelSelection): string { return JSON.stringify([selection.provider, selection.model]); }
function effortValue(selection: ModelSelection): string { return JSON.stringify([selection.provider, selection.model, selection.reasoningEffort]); }
