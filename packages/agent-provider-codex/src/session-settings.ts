import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { validateSessionSetting, type AgentSessionSetting, type AgentSessionSettingOption } from '@orchardworks/agent-provider-sdk';
import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';

interface NativeModel {
  value: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}

const approvalOptions: AgentSessionSettingOption[] = [
  { value: 'untrusted', label: 'Untrusted', description: 'Ask before commands outside the trusted set.' },
  { value: 'on-request', label: 'On request', description: 'The agent requests approval when needed.' },
  { value: 'never', label: 'Never ask', description: 'Approval requests are disabled; sandbox restrictions still apply.' },
];
const sandboxOptions: AgentSessionSettingOption[] = [
  { value: 'readOnly', label: 'Read only', description: 'Read-only filesystem; preserve native network policy when available.' },
  { value: 'workspaceWrite', label: 'Workspace write', description: 'Allow workspace writes; preserve native roots and network policy when available.' },
  { value: 'dangerFullAccess', label: 'Full access', description: 'No filesystem or network sandbox restrictions.' },
];
const sandboxModes: Record<string, string> = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' };

export class CodexSessionSettings {
  private models: NativeModel[] = [];
  private requirements: Record<string, unknown> | undefined;
  private approval: unknown;
  private sandbox: Record<string, unknown> | undefined;
  private readonly sandboxPolicies = new Map<string, Record<string, unknown>>();
  private discoveryFailure: string | undefined;

  inheritCatalog(source: CodexSessionSettings): void {
    this.models = structuredClone(source.models);
    this.requirements = structuredClone(source.requirements);
    this.discoveryFailure = source.discoveryFailure;
  }

  async discover(transport: CodexAppServerTransport): Promise<void> {
    this.models = [];
    this.discoveryFailure = undefined;
    this.requirements = undefined;
    try {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await transport.request('model/list', { ...(cursor ? { cursor } : {}) });
        if (!isRecord(result) || !Array.isArray(result.data)) break;
        for (const item of result.data) {
          if (!isRecord(item) || item.hidden === true) continue;
          const value = readString(item.model);
          if (!value || this.models.some((model) => model.value === value)) continue;
          this.models.push({ value, label: readString(item.displayName) ?? value, description: readString(item.description),
            efforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.flatMap((entry) => isRecord(entry) && readString(entry.reasoningEffort) ? [String(entry.reasoningEffort)] : []) : [],
            defaultEffort: readString(item.defaultReasoningEffort),
          });
        }
        cursor = readString(result.nextCursor);
        if (cursor && seen.has(cursor)) throw new Error('Native model catalog repeated its cursor.');
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (error) {
      this.discoveryFailure = error instanceof Error ? error.message : 'Native model catalog unavailable.';
      this.models = [];
    }
    try {
      const result = await transport.request('configRequirements/read', {});
      if (isRecord(result) && (result.requirements === null || isRecord(result.requirements))) {
        this.requirements = result.requirements ?? {};
      }
    } catch { /* Unknown requirements keep permission controls read-only. */ }
  }

  apply(settings: Record<string, unknown>): void {
    if ('approvalPolicy' in settings) this.approval = settings.approvalPolicy;
    if (isRecord(settings.sandboxPolicy) && readString(settings.sandboxPolicy.type)) {
      this.sandbox = structuredClone(settings.sandboxPolicy);
      this.sandboxPolicies.set(String(settings.sandboxPolicy.type), this.sandbox!);
    }
  }

  describe(model: string | undefined, effort: string | undefined): AgentSessionSetting[] {
    const selected = this.models.find((entry) => entry.value === model);
    const settings: AgentSessionSetting[] = [{
      id: 'model', category: 'model', label: 'Model', value: model ?? null,
      options: this.models.map(({ value, label, description }) => ({ value, label, ...(description ? { description } : {}) })),
      mutable: this.models.length > 0, scope: 'session',
      description: this.discoveryFailure ?? 'Applies to subsequent turns.',
    }];
    if (selected?.efforts.length) settings.push({
      id: 'effort', category: 'model', label: 'Reasoning effort', value: effort ?? selected.defaultEffort ?? null,
      options: selected.efforts.map((value) => ({ value, label: value })), mutable: true, scope: 'session',
    });
    const allowedApproval = this.requirements?.allowedApprovalPolicies;
    const allowedSandbox = this.requirements?.allowedSandboxModes;
    settings.push({
      id: 'approval', category: 'permissions', label: 'Approval policy',
      value: typeof this.approval === 'string' ? this.approval : this.approval ? JSON.stringify(this.approval) : null,
      options: approvalOptions.filter(({ value }) => !Array.isArray(allowedApproval) || allowedApproval.includes(value)),
      mutable: this.requirements !== undefined && this.approval !== undefined, scope: 'session',
      description: this.requirements === undefined ? 'Native policy requirements unavailable; read-only.' : 'Native approval policy; sandbox restrictions are independent.',
    }, {
      id: 'sandbox', category: 'permissions', label: 'Sandbox', value: readString(this.sandbox?.type) ?? null,
      options: sandboxOptions.filter(({ value }) => !Array.isArray(allowedSandbox) || allowedSandbox.includes(sandboxModes[value])),
      mutable: this.requirements !== undefined && this.sandbox !== undefined, scope: 'session',
      description: describeSandbox(this.sandbox),
    });
    return settings;
  }

  patch(id: string, value: string, model: string | undefined, effort: string | undefined): Record<string, unknown> {
    validateSessionSetting(this.describe(model, effort), id, value);
    if (id === 'model') {
      const selected = this.models.find((entry) => entry.value === value)!;
      const nextEffort = effort && selected.efforts.includes(effort) ? effort : selected.defaultEffort;
      return { model: value, ...(nextEffort ? { effort: nextEffort } : {}) };
    }
    if (id === 'effort') return { effort: value };
    if (id === 'approval') return { approvalPolicy: value };
    if (id === 'sandbox') return { sandboxPolicy: this.sandboxPolicies.get(value) ?? (
      value === 'workspaceWrite' ? { type: value, writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : value === 'readOnly' ? { type: value, networkAccess: false } : { type: value }
    ) };
    throw new AgentOperationRejectedError('invalid_operation', 'Unsupported Codex setting.');
  }
}

function describeSandbox(policy: Record<string, unknown> | undefined): string {
  if (!policy) return 'Native sandbox state unavailable.';
  if (policy.type === 'dangerFullAccess') return 'Filesystem and network access are unrestricted.';
  const network = policy.networkAccess === true || policy.networkAccess === 'enabled' ? 'Network access allowed.' : 'Network access blocked.';
  if (policy.type === 'readOnly') return `Read-only filesystem. ${network}`;
  if (policy.type === 'externalSandbox') return `Sandbox enforcement is managed externally. ${network}`;
  const roots = Array.isArray(policy.writableRoots) ? policy.writableRoots.filter((root): root is string => typeof root === 'string') : [];
  const writable = ['the workspace', ...roots, ...(policy.excludeSlashTmp === true ? [] : ['/tmp']), ...(policy.excludeTmpdirEnvVar === true ? [] : ['the runtime temporary directory'])];
  return `Writes allowed in ${writable.join(', ')}. ${network}`;
}
