import type { WindowSessionBinding, WindowView, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { WindowLayoutAuthority } from './window-workspace-context.js';

export interface WindowAskSourceAnchor { hostId: string; providerId: string; nativeSessionId: string; roleKey?: string; agentId?: string; title?: string }

type FeatureAssociation = NonNullable<WindowView['feature']>;
export type WindowAppFeature =
  | { kind: 'ask'; id: string; source?: WindowAskSourceAnchor }
  | { kind: 'tpm'; id: string; hostId: string }
  | { kind: 'team'; id: string; role: 'leader' | 'member'; memberId?: string };

const nativeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;

/** Only validated application associations receive feature behavior. Unknown tags remain ordinary views. */
export function parseWindowFeature(feature: FeatureAssociation | undefined): WindowAppFeature | undefined {
  if (!feature || !nativeId(feature.id)) return;
  if (feature.kind === 'ask') {
    const m = feature.metadata;
    if (!m || !Object.keys(m).some(key => key.startsWith('source'))) return { kind: 'ask', id: feature.id };
    if (![m.sourceHostId, m.sourceProviderId, m.sourceNativeSessionId].every(nativeId)
      || [m.sourceRoleKey, m.sourceAgentId, m.sourceTitle].some(value => value !== undefined && !nativeId(value))) return;
    return { kind: 'ask', id: feature.id, source: { hostId: m.sourceHostId!, providerId: m.sourceProviderId!, nativeSessionId: m.sourceNativeSessionId!,
      ...(m.sourceRoleKey ? { roleKey: m.sourceRoleKey } : {}), ...(m.sourceAgentId ? { agentId: m.sourceAgentId } : {}), ...(m.sourceTitle ? { title: m.sourceTitle } : {}) } };
  }
  if (feature.kind === 'tpm' && nativeId(feature.metadata?.hostId)) {
    return { kind: 'tpm', id: feature.id, hostId: feature.metadata.hostId };
  }
  if (feature.kind === 'team') {
    const role = feature.metadata?.role;
    const memberId = feature.metadata?.memberId;
    if (role !== 'leader' && role !== 'member' || memberId !== undefined && !nativeId(memberId)) return;
    return { kind: 'team', id: feature.id, role, ...(memberId ? { memberId } : {}) };
  }
}

export function createWindowFeature(feature: WindowAppFeature): FeatureAssociation {
  if (feature.kind === 'ask') return { kind: feature.kind, id: feature.id, ...(feature.source ? { metadata: {
    sourceHostId: feature.source.hostId, sourceProviderId: feature.source.providerId, sourceNativeSessionId: feature.source.nativeSessionId,
    ...(feature.source.roleKey ? { sourceRoleKey: feature.source.roleKey } : {}), ...(feature.source.agentId ? { sourceAgentId: feature.source.agentId } : {}),
    ...(feature.source.title ? { sourceTitle: feature.source.title } : {}),
  } } : {}) };
  if (feature.kind === 'tpm') return { kind: feature.kind, id: feature.id, metadata: { hostId: feature.hostId } };
  return { kind: feature.kind, id: feature.id, metadata: { role: feature.role, ...(feature.memberId ? { memberId: feature.memberId } : {}) } };
}

export function featureView(window: WorkspaceWindow, kind: WindowAppFeature['kind'], id: string) {
  return window.views.find(view => {
    const feature = parseWindowFeature(view.feature);
    return feature?.kind === kind && feature.id === id;
  });
}

/** Shared Ask identity follows its source view, independently of page-local draft ownership. */
export function askFeatureView(window: WorkspaceWindow, localOwnerId: string, sourceViewId?: string, matchesAnchor?: (source: WindowAskSourceAnchor) => boolean) {
  const anchored = window.views.find(view => { const feature = parseWindowFeature(view.feature); return feature?.kind === 'ask' && feature.source && matchesAnchor?.(feature.source) && (!sourceViewId || view.closeWith === sourceViewId); });
  if (anchored) return anchored;
  const associated = sourceViewId && window.views.find(view => { const feature = parseWindowFeature(view.feature); return feature?.kind === 'ask' && !feature.source && feature.id === localOwnerId && view.closeWith === sourceViewId; });
  if (associated) return associated;
  const legacy = featureView(window, 'ask', localOwnerId);
  return legacy && !(parseWindowFeature(legacy.feature) as { source?: unknown })?.source && (!sourceViewId || !legacy.closeWith || legacy.closeWith === sourceViewId) ? legacy : undefined;
}

export function openFeatureView(authority: WindowLayoutAuthority, feature: WindowAppFeature, binding?: WindowSessionBinding, closeWith?: string, closedViewId?: string) {
  const candidate = featureView(authority.window, feature.kind, feature.id);
  const held = candidate?.id === closedViewId ? undefined : candidate;
  if (held) {
    if (held.collapsed || authority.window.selectedViewId !== held.id) authority.operate({ type: 'view.select', viewId: held.id });
    return;
  }
  const id = `${feature.kind}-${crypto.randomUUID()}`;
  authority.operate({ type: 'batch', operations: [
    { type: 'view.create', view: {
      id, feature: createWindowFeature(feature), bindingPolicy: 'managed',
      ...(binding ? { binding } : {}), ...(closeWith ? { closeWith } : {}),
      placement: 'float', width: 440, collapsed: false, display: { mode: 'content', lettersVisible: true },
    } },
    { type: 'view.select', viewId: id },
  ] });
}

/** Feature records project native bindings through the authorized application layout operation. */
export function projectFeatureBinding(authority: WindowLayoutAuthority, kind: WindowAppFeature['kind'], id: string, binding: WindowSessionBinding) {
  const view = featureView(authority.window, kind, id);
  if (!view || JSON.stringify(view.binding) === JSON.stringify(binding)) return false;
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = authority.window;
  authority.operate({ type: 'layout.apply', layout: { ...layout, views: layout.views.map(item => item.id === view.id ? { ...item, binding } : item) } });
  return true;
}
