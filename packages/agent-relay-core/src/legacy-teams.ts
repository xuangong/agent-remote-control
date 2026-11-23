/**
 * What Relay state of earlier builds holds and this build no longer has, dropped when the state loads and not converted:
 * ordinary Teams (a Team of none of a task, a link, a bot's inbox or a room, which the person made from a panel), the `team` and
 * `tpm` tags and managed bindings of the Window views that showed their members and TPM works, and the file transfers of a Team
 * (uploads, grants and message attachments). The Window views stay plain sessions.
 */
import type { Team } from '@orchardworks/agent-remote-protocol';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

/** A Team of one person's own making: none of a task, a link, a bot's inbox or a room. */
export const isOrdinaryTeam = (team: unknown): boolean => {
  const value = team as Partial<Team> | null;
  return !!value && typeof value === 'object' && typeof value.id === 'string' && !value.task && !value.link && !value.inbox && !value.room;
};
interface Broker { teams?: Team[] }
type Tenant = { subject: string; broker: Broker };

const removedFeatures = new Set(['team', 'tpm']);
const taggedByRemovedFeature = (row: SavedWorkspaceWindow) => !row.deleted && !!row.window?.views.some(view => view.feature !== undefined && removedFeatures.has(view.feature.kind));

/** Whether the state still holds an ordinary Team or a view tagged for a removed feature. */
export const hasLegacyTeams = (tenants: readonly Tenant[], rows: readonly SavedWorkspaceWindow[] = []): boolean =>
  tenants.some(tenant => tenant.broker?.teams?.some(isOrdinaryTeam)) || rows.some(taggedByRemovedFeature);

/** Removes every ordinary Team, and the `team` or `tpm` tag and managed binding of every view that carries one. */
export function dropLegacyTeams(tenants: Tenant[], rows: SavedWorkspaceWindow[]): void {
  for (const tenant of tenants) if (tenant.broker?.teams) tenant.broker.teams = tenant.broker.teams.filter(team => !isOrdinaryTeam(team));
  for (const row of rows) for (const view of row.window?.views ?? []) {
    if (view.feature === undefined || !removedFeatures.has(view.feature.kind)) continue;
    delete view.feature;
    if (view.bindingPolicy === 'managed') delete view.bindingPolicy;
  }
}

const hasResources = (team: unknown): boolean => {
  const value = team as { messages?: unknown } | null;
  return !!value && typeof value === 'object' && (Object.hasOwn(value, 'resourceUploads') || Object.hasOwn(value, 'resourceGrants')
    || Array.isArray(value.messages) && value.messages.some(message => !!message && typeof message === 'object' && Object.hasOwn(message, 'resources')));
};
/** The Team without its file transfer fields; a Team that has none is returned itself. */
export function withoutLegacyTeamResources<T>(team: T): T {
  if (!hasResources(team)) return team;
  const { resourceUploads: _uploads, resourceGrants: _grants, ...rest } = team as T & { resourceUploads?: unknown; resourceGrants?: unknown; messages?: Record<string, unknown>[] };
  return { ...rest, ...(rest.messages ? { messages: rest.messages.map(({ resources: _resources, ...message }) => message) } : {}) } as T;
}
/** Whether some tenant still holds a Team with file transfer fields. */
export const hasLegacyTeamResources = (tenants: readonly Tenant[]): boolean => tenants.some(tenant => tenant.broker?.teams?.some(hasResources));
