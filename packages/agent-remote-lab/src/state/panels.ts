/**
 * Panels: which of the Workbench's surfaces are open (the sessions drawer on compact layouts, the sessions page and
 * sidebar on desktop, the inspector, the header, the Workbench or Trace view) and how every navigation event changes
 * them.
 *
 * Contract
 * - `reducePanels(state, event)` is pure. It returns the next state and the effects the shell must run, as data.
 * - Compact layouts have a drawer (`contextOpen`) and never a page; desktop has a sidebar (`desktopContextVisible`) and
 *   a page (`sessionsPage`), and never a drawer. A switch of layout closes the drawer, the inspector and the page.
 * - Showing a panel never leaves two competing surfaces open: on compact layouts the drawer replaces the inspector.
 * - Closing the page while focus is inside it asks the shell to return focus to the Window (`page-focus-return`).
 * - Reading and window state are not owned here; see window-composition and the Window workspace.
 */

export type SessionPanel = 'list' | 'favorites' | 'new' | 'settings' | 'hosts';
export type MainView = 'workbench' | 'trace';

export interface PanelsState {
  readonly activeView: MainView;
  readonly compact: boolean;
  /** The compact drawer. */
  readonly contextOpen: boolean;
  /** Whether the drawer was opened from the sessions button (it returns focus there) rather than the View menu. */
  readonly contextFromSessions: boolean;
  readonly inspectorOpen: boolean;
  /** The desktop sidebar. */
  readonly desktopContextVisible: boolean;
  /** The desktop page that replaces the Window with a sidebar panel. */
  readonly sessionsPage: boolean;
  readonly headerHidden: boolean;
  readonly sessionPanel: SessionPanel;
}

export type PanelsEvent =
  | { readonly type: 'view.show'; readonly view: MainView }
  | { readonly type: 'page.close'; readonly focusInPage: boolean }
  | { readonly type: 'context.close'; readonly focusInPage: boolean }
  | { readonly type: 'context.open'; readonly fromSessions: boolean }
  | { readonly type: 'context.toggle' }
  | { readonly type: 'inspector.open' }
  | { readonly type: 'inspector.close' }
  | { readonly type: 'inspector.toggle' }
  | { readonly type: 'compact.changed'; readonly compact: boolean }
  | { readonly type: 'all.setVisible'; readonly visible: boolean }
  | { readonly type: 'header.toggle' }
  | { readonly type: 'desktopSidebar.toggle' }
  | { readonly type: 'sessionPanel.set'; readonly panel: SessionPanel }
  | { readonly type: 'chooser.show' }
  | { readonly type: 'page.open'; readonly panel: SessionPanel }
  | { readonly type: 'panel.show'; readonly panel: SessionPanel };

export type PanelsEffect =
  | { readonly type: 'page-focus-return' }
  | { readonly type: 'refresh-favorites' };

export interface PanelsStep { readonly state: PanelsState; readonly effects: readonly PanelsEffect[] }

/** The state on first render: a compact layout without a session to show opens its drawer; desktop shows the sidebar. */
export function initialPanels(layout: { readonly compact: boolean; readonly opensSession: boolean }): PanelsState {
  return {
    activeView: 'workbench', compact: layout.compact, contextOpen: layout.compact && !layout.opensSession, contextFromSessions: true,
    inspectorOpen: false, desktopContextVisible: !layout.opensSession, sessionsPage: false, headerHidden: true,
    sessionPanel: 'list',
  };
}

const none: readonly PanelsEffect[] = [];
const favoritesRefresh: readonly PanelsEffect[] = [{ type: 'refresh-favorites' }];

export function reducePanels(state: PanelsState, event: PanelsEvent): PanelsStep {
  switch (event.type) {
    case 'view.show': return { state: { ...state, activeView: event.view }, effects: none };
    case 'page.close': return {
      state: { ...state, sessionsPage: false },
      effects: event.focusInPage ? [{ type: 'page-focus-return' }] : none,
    };
    case 'context.close': return reducePanels({ ...state, contextOpen: false }, { type: 'page.close', focusInPage: event.focusInPage });
    case 'context.open': return {
      state: { ...state, contextFromSessions: event.fromSessions, sessionPanel: 'list', desktopContextVisible: true, inspectorOpen: false, contextOpen: true },
      effects: none,
    };
    case 'context.toggle':
      if (state.compact) return state.contextOpen ? { state: { ...state, contextOpen: false }, effects: none } : reducePanels(state, { type: 'context.open', fromSessions: false });
      return { state: { ...state, desktopContextVisible: !state.desktopContextVisible }, effects: none };
    case 'inspector.open': return { state: { ...state, contextOpen: false, inspectorOpen: true }, effects: none };
    case 'inspector.close': return { state: { ...state, inspectorOpen: false }, effects: none };
    case 'inspector.toggle': return reducePanels(state, { type: state.inspectorOpen ? 'inspector.close' : 'inspector.open' });
    case 'compact.changed': return {
      state: { ...state, compact: event.compact, contextOpen: false, inspectorOpen: false, sessionsPage: event.compact ? false : state.sessionsPage },
      effects: none,
    };
    case 'all.setVisible': return {
      state: { ...state, headerHidden: !event.visible, desktopContextVisible: event.visible, contextOpen: false, inspectorOpen: event.visible && !state.compact },
      effects: none,
    };
    case 'header.toggle': return { state: { ...state, headerHidden: !state.headerHidden }, effects: none };
    case 'desktopSidebar.toggle': return { state: { ...state, desktopContextVisible: !state.desktopContextVisible }, effects: none };
    case 'sessionPanel.set': return { state: { ...state, sessionPanel: event.panel }, effects: none };
    case 'chooser.show': return {
      state: { ...state, activeView: 'workbench', sessionPanel: 'list', ...(state.compact ? { contextOpen: true } : { sessionsPage: true }) },
      effects: none,
    };
    case 'page.open': return {
      state: { ...state, sessionPanel: event.panel, activeView: 'workbench', sessionsPage: true },
      effects: event.panel === 'favorites' ? favoritesRefresh : none,
    };
    case 'panel.show':
      if (!state.compact) return reducePanels(state, { type: 'page.open', panel: event.panel });
      return {
        state: { ...state, activeView: 'workbench', sessionPanel: event.panel, inspectorOpen: false, contextOpen: true },
        effects: event.panel === 'favorites' ? favoritesRefresh : none,
      };
  }
}

/** The compact drawer or the desktop sidebar, whichever this layout has. */
export function contextVisible(state: PanelsState): boolean {
  return state.compact ? state.contextOpen : state.desktopContextVisible;
}

/** The desktop page is showing in place of the Window. */
export function pageOpen(state: PanelsState, windowMode: boolean): boolean {
  return windowMode && !state.compact && state.sessionsPage;
}

/** A compact drawer or inspector covers the page; the background is inert behind it. */
export function supportingRailOpen(state: PanelsState): boolean {
  return state.compact && (state.contextOpen || state.inspectorOpen);
}

/** The Window's views are on screen: not covered by Trace, the desktop sessions page or a compact drawer. */
export function windowStageVisible(state: PanelsState, windowMode: boolean): boolean {
  return windowMode && state.activeView === 'workbench' && !pageOpen(state, windowMode) && !supportingRailOpen(state);
}

/** The title of the sessions page for a panel. */
export function sessionsPageTitle(panel: SessionPanel): string {
  return panel === 'list' ? 'All sessions' : panel === 'favorites' ? 'Favorites' : panel === 'new' ? 'New session' : panel === 'hosts' ? 'Hosts' : 'Settings';
}
