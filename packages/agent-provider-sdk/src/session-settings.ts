import { AgentOperationRejectedError } from './provider.js';
export interface AgentSessionSettingOption {
  value: string;
  label: string;
  description?: string;
}

/** A native selection; values are opaque outside the declaring Provider. */
export interface AgentSessionSetting {
  id: string;
  category: 'model' | 'permissions';
  label: string;
  value: string | null;
  options: AgentSessionSettingOption[];
  mutable: boolean;
  scope: 'session' | 'session_and_default';
  description?: string;
}

export function validateSessionSetting(settings: readonly AgentSessionSetting[] | undefined, id: string, value: string): AgentSessionSetting {
  const matches = settings?.filter((setting) => setting.id === id) ?? [];
  if (matches.length !== 1) throw new AgentOperationRejectedError('invalid_operation', `Unknown session setting: ${id}`);
  const setting = matches[0]!;
  if (!setting.mutable) throw new AgentOperationRejectedError('invalid_operation', `${setting.label} is read-only.`);
  if (setting.options.filter((option) => option.value === value).length !== 1) throw new AgentOperationRejectedError('invalid_operation', `Unavailable ${setting.label} selection.`);
  return setting;
}
