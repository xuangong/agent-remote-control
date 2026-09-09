export const AGENT_REMOTE_SETTINGS_NAMESPACE = 'agent-remote-control-host';

export interface RemoteHostSettingsSnapshot {
  serverUrl: string;
  instanceName: string;
}

export interface RemoteHostSettingsDraft extends RemoteHostSettingsSnapshot {
  remoteKey?: string;
}

export type RemoteHostSettingsPathOp =
  | { op: 'set'; path: string[]; value: string }
  | { op: 'unset'; path: string[] };

export function remoteHostSettingsMutation(input: {
  resolved: RemoteHostSettingsSnapshot;
  draft: RemoteHostSettingsDraft;
}): RemoteHostSettingsPathOp[] {
  const ops: RemoteHostSettingsPathOp[] = [];
  appendVisibleField(ops, 'serverUrl', input.resolved.serverUrl, input.draft.serverUrl);
  if (input.draft.remoteKey?.trim()) {
    ops.push({ op: 'set', path: ['remoteKey'], value: input.draft.remoteKey.trim() });
  }
  appendVisibleField(ops, 'instanceName', input.resolved.instanceName, input.draft.instanceName);
  return ops;
}

export function reconcileRemoteHostSettingsDraft(input: {
  initialized: boolean;
  draft: RemoteHostSettingsDraft;
  previousResolved: RemoteHostSettingsSnapshot;
  resolved: RemoteHostSettingsSnapshot;
}): RemoteHostSettingsDraft {
  if (!input.initialized) return { ...input.resolved };
  return remoteHostSettingsMutation({
    resolved: input.previousResolved,
    draft: input.draft,
  }).length === 0 ? { ...input.resolved } : input.draft;
}

function appendVisibleField(
  ops: RemoteHostSettingsPathOp[],
  field: 'serverUrl' | 'instanceName',
  resolved: string,
  draft: string,
): void {
  const value = draft.trim();
  if (value !== resolved) ops.push({ op: 'set', path: [field], value });
}
