import { createWindowView, type WindowGroup, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

/** Builders for Window mock data: a binding, a view, a Window and a group, each from overrides. */
export function buildBinding(id: string, overrides: Partial<WindowSessionBinding> = {}): WindowSessionBinding {
  return { hostId: 'local', providerId: 'codex', nativeSessionId: id, title: id, ...overrides };
}

export function buildView(id: string, placement: WindowView['placement'] = 'primary', overrides: Partial<WindowView> = {}): WindowView {
  return { ...createWindowView(id, buildBinding(id), placement), ...overrides };
}

export function buildWindow(views: readonly WindowView[], selectedViewId: string | undefined = views[0]?.id, overrides: Partial<WorkspaceWindow> = {}): WorkspaceWindow {
  return { schemaVersion: 3, id: 'W', revision: 0, title: 'W', views: [...views], selectedViewId, selectedPrimaryViewId: selectedViewId, ...overrides } as WorkspaceWindow;
}

/** A group with bot details: `asleep` lists the bots put to sleep. */
export function buildGroup(window: WorkspaceWindow, options: { asleep?: readonly string[]; bots?: boolean; presentation?: WindowGroup['presentation'] } = {}): WindowGroup {
  const members = Object.fromEntries(window.views.map(view => [view.id, options.asleep?.includes(view.id) ? { asleep: true } : {}]));
  return { window, ...(options.bots === false ? {} : { bots: { rank: 0, members } as never }), ...(options.presentation ? { presentation: options.presentation } : {}) } as WindowGroup;
}
