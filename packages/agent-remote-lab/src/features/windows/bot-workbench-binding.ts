import { createWindowView, type WindowGroup, type WindowLayout, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WORKBENCH_FEATURE, workbenchBotId, workbenchMainView, type WorkbenchTile } from './bot-workbench.js';

/**
 * Binding a Window to a bot, and the edits around it. The binding is one tag on the main tile (`feature { kind: 'bot', id }` with a
 * managed binding), so every function here answers a layout for `layout.apply` or a group to create; no Relay change is involved.
 */
const sameSession = (a: WindowSessionBinding | undefined, b: Pick<WindowSessionBinding, 'hostId' | 'providerId' | 'nativeSessionId'>) =>
  !!a && a.hostId === b.hostId && a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId;
const layoutOf = (window: WorkspaceWindow, views: WindowView[], selection?: string): WindowLayout => {
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = window;
  return { ...layout, views, ...(selection ? { selectedPrimaryViewId: selection, selectedViewId: selection } : {}) };
};
const tagged = (view: WindowView, botId: string): WindowView => ({ ...view, feature: { kind: WORKBENCH_FEATURE, id: botId }, bindingPolicy: 'managed' });

/** The id a bot's first workbench takes, so two devices creating it at once meet; a taken id gets a random one. */
export const workbenchWindowId = (botId: string, taken: ReadonlySet<string>): string => taken.has(`wb-${botId}`) ? `wb-${botId}-${crypto.randomUUID()}` : `wb-${botId}`;

/** A new bot workbench: a Window shown in Window mode only, holding the bot's main session as its tagged main tile. */
export function workbenchGroup(botId: string, name: string, main: WindowSessionBinding, windowId: string): WindowGroup {
  const view = tagged(createWindowView('main', main, 'primary'), botId);
  return { window: { schemaVersion: 3, id: windowId, revision: 0, title: name, selectedPrimaryViewId: view.id, selectedViewId: view.id, views: [view] }, presentation: { bots: false } };
}

/** Binds a free Window: the tile that shows the bot's main session is tagged and put first, or a new main tile is added first. */
export function bindWorkbench(window: WorkspaceWindow, botId: string, main: WindowSessionBinding): WindowLayout {
  const existing = window.views.find(view => view.placement === 'primary' && sameSession(view.binding, main));
  if (existing) return layoutOf(window, [tagged(existing, botId), ...window.views.filter(view => view !== existing)], existing.id);
  let id = 'main'; for (let n = 2; window.views.some(view => view.id === id); n += 1) id = `main-${n}`;
  const view = tagged(createWindowView(id, main, 'primary'), botId);
  return layoutOf(window, [view, ...window.views], view.id);
}

/** The stored view a derived tile becomes when it is kept: bound to its session, folded as it was shown. */
export function adoptedView(tile: WorkbenchTile, viewId: string): WindowView {
  const view = createWindowView(viewId, { ...tile.locator!, title: tile.title }, 'primary');
  return { ...view, collapsed: tile.folded, ...(tile.taskId ? { feature: { kind: 'sub', id: tile.taskId } } : {}) };
}

/** Unbinds: the main tile becomes an ordinary one, and the derived tiles the person has open (`keep`) become stored tiles. */
export function unbindWorkbench(window: WorkspaceWindow, keep: readonly WorkbenchTile[]): WindowLayout {
  const taken = new Set(window.views.map(view => view.id));
  const adopted = keep.filter(tile => tile.locator).map(tile => { let id = `kept-${tile.taskId ?? tile.id}`; for (let n = 2; taken.has(id); n += 1) id = `kept-${tile.taskId ?? tile.id}-${n}`; taken.add(id); return adoptedView(tile, id); });
  const views = window.views.map(view => { if (view.feature?.kind !== WORKBENCH_FEATURE || view !== workbenchMainView(window)) return view; const { feature: _feature, bindingPolicy: _policy, ...rest } = view; return rest; });
  return layoutOf(window, [...views, ...adopted]);
}

/** The bot's workbench to open: the most recently used one of this device, else the first in catalog order. */
export function resolveWorkbench(groups: readonly WindowGroup[], botId: string, recent: readonly string[]): WindowGroup | undefined {
  const own = groups.filter(group => workbenchBotId(group.window) === botId);
  const rank = (id: string) => { const index = recent.indexOf(id); return index < 0 ? Infinity : index; };
  return [...own].sort((a, b) => rank(a.window.id) - rank(b.window.id))[0];
}

/** A standing bot as a workbench needs it: its record id, where its conversation is, and the session it started in. */
export interface StandingBot { readonly botId: string; readonly groupId: string; readonly viewId: string; readonly binding: WindowSessionBinding; readonly chief?: string }

/** Every standing bot of the groups with bot details, in catalog order; a bot hidden in Bot mode is still a bot. */
export function standingBots(groups: readonly WindowGroup[]): StandingBot[] {
  return groups.flatMap(group => group.window.views.flatMap(view => {
    const details = group.bots?.members[view.id];
    return details?.botId && view.binding ? [{ botId: details.botId, groupId: group.window.id, viewId: view.id, binding: view.binding, ...(details.chief ? { chief: details.chief } : {}) }] : [];
  }));
}
