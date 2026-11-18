// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  contextVisible, initialPanels, pageOpen, reducePanels, sessionsPageTitle, supportingRailOpen, windowStageVisible,
  type PanelsEvent, type PanelsState,
} from './panels.js';

const desktop = initialPanels({ compact: false, opensSession: true });
const compact = initialPanels({ compact: true, opensSession: true });

function run(from: PanelsState, ...events: PanelsEvent[]): PanelsState {
  return events.reduce((state, event) => reducePanels(state, event).state, from);
}
const effectsOf = (state: PanelsState, event: PanelsEvent) => reducePanels(state, event).effects;

describe('initial panels', () => {
  it.each([
    { layout: { compact: false, opensSession: false }, drawer: false, sidebar: true },
    { layout: { compact: false, opensSession: true }, drawer: false, sidebar: false },
    { layout: { compact: true, opensSession: false }, drawer: true, sidebar: true },
    { layout: { compact: true, opensSession: true }, drawer: false, sidebar: false },
  ])('shows the drawer or sidebar a person without a session needs: $layout', ({ layout, drawer, sidebar }) => {
    const state = initialPanels(layout);
    expect(state.contextOpen).toBe(drawer);
    expect(state.desktopContextVisible).toBe(sidebar);
    expect(state).toMatchObject({ activeView: 'workbench', inspectorOpen: false, sessionsPage: false, headerHidden: true, sessionPanel: 'list' });
  });
});

describe('a change of layout', () => {
  it('closes the drawer, the inspector and, entering compact, the page', () => {
    const open = run(desktop, { type: 'page.open', panel: 'settings' }, { type: 'inspector.open' });
    const narrowed = run(open, { type: 'compact.changed', compact: true });
    expect(narrowed).toMatchObject({ compact: true, contextOpen: false, inspectorOpen: false, sessionsPage: false });
  });

  it('does not bring the page back when the layout widens again', () => {
    const widened = run(compact, { type: 'compact.changed', compact: false });
    expect(widened.sessionsPage).toBe(false);
  });

  it('closes the drawer when it widens', () => {
    expect(run(compact, { type: 'context.open', fromSessions: true }, { type: 'compact.changed', compact: false }).contextOpen).toBe(false);
  });
});

describe('the sidebar of a session context', () => {
  it('toggles the desktop sidebar and, on compact layouts, the drawer', () => {
    expect(run(desktop, { type: 'context.toggle' }).desktopContextVisible).toBe(true);
    expect(run(desktop, { type: 'context.toggle' }, { type: 'context.toggle' }).desktopContextVisible).toBe(false);
    const drawer = run(compact, { type: 'context.toggle' });
    expect(drawer).toMatchObject({ contextOpen: true, sessionPanel: 'list', contextFromSessions: false });
    expect(run(drawer, { type: 'context.toggle' }).contextOpen).toBe(false);
  });

  it('opens the drawer from the sessions button, replacing the inspector and remembering where focus returns', () => {
    const open = run(compact, { type: 'inspector.open' }, { type: 'context.open', fromSessions: true });
    expect(open).toMatchObject({ contextOpen: true, inspectorOpen: false, contextFromSessions: true, desktopContextVisible: true });
  });

  it('shows and hides the sidebar of Window mode apart from the Bot roster', () => {
    expect(run(desktop, { type: 'desktopSidebar.toggle' }).desktopContextVisible).toBe(!desktop.desktopContextVisible);
    expect(run(desktop, { type: 'botRoster.toggle' })).toMatchObject({ botRosterCollapsed: true, desktopContextVisible: desktop.desktopContextVisible });
  });
});

describe('the inspector', () => {
  it('opens in place of the drawer and toggles', () => {
    const open = run(compact, { type: 'context.open', fromSessions: false }, { type: 'inspector.toggle' });
    expect(open).toMatchObject({ inspectorOpen: true, contextOpen: false });
    expect(run(open, { type: 'inspector.toggle' }).inspectorOpen).toBe(false);
  });
});

describe('showing every panel or none', () => {
  it('shows the header and sidebar, and the inspector only on desktop', () => {
    expect(run(desktop, { type: 'all.setVisible', visible: true })).toMatchObject({ headerHidden: false, desktopContextVisible: true, inspectorOpen: true, contextOpen: false });
    expect(run(compact, { type: 'all.setVisible', visible: true })).toMatchObject({ headerHidden: false, inspectorOpen: false });
  });

  it('hides them all', () => {
    const shown = run(desktop, { type: 'all.setVisible', visible: true });
    expect(run(shown, { type: 'all.setVisible', visible: false })).toMatchObject({ headerHidden: true, desktopContextVisible: false, inspectorOpen: false });
    expect(run(desktop, { type: 'header.toggle' }).headerHidden).toBe(false);
  });
});

describe('the sessions page and the session chooser', () => {
  it('shows a panel as a page on desktop and as the drawer on compact layouts', () => {
    expect(run(desktop, { type: 'panel.show', panel: 'hosts' })).toMatchObject({ sessionsPage: true, sessionPanel: 'hosts', contextOpen: false, activeView: 'workbench' });
    const drawer = run(compact, { type: 'inspector.open' }, { type: 'view.show', view: 'trace' }, { type: 'panel.show', panel: 'settings' });
    expect(drawer).toMatchObject({ contextOpen: true, inspectorOpen: false, sessionsPage: false, sessionPanel: 'settings', activeView: 'workbench' });
  });

  it('asks for a favorites refresh whenever the favorites panel opens', () => {
    expect(effectsOf(desktop, { type: 'panel.show', panel: 'favorites' })).toEqual([{ type: 'refresh-favorites' }]);
    expect(effectsOf(compact, { type: 'panel.show', panel: 'favorites' })).toEqual([{ type: 'refresh-favorites' }]);
    expect(effectsOf(desktop, { type: 'page.open', panel: 'favorites' })).toEqual([{ type: 'refresh-favorites' }]);
    expect(effectsOf(desktop, { type: 'panel.show', panel: 'list' })).toEqual([]);
  });

  it('opens the session chooser on the list: a page on desktop, the drawer on compact layouts', () => {
    const from = run(desktop, { type: 'view.show', view: 'trace' }, { type: 'sessionPanel.set', panel: 'new' });
    expect(run(from, { type: 'chooser.show' })).toMatchObject({ activeView: 'workbench', sessionPanel: 'list', sessionsPage: true, contextOpen: false });
    expect(run(compact, { type: 'chooser.show' })).toMatchObject({ sessionPanel: 'list', sessionsPage: false, contextOpen: true });
  });

  it('asks the shell to return focus to the Window when the page closes around focus', () => {
    const open = run(desktop, { type: 'page.open', panel: 'list' });
    expect(effectsOf(open, { type: 'page.close', focusInPage: true })).toEqual([{ type: 'page-focus-return' }]);
    expect(effectsOf(open, { type: 'page.close', focusInPage: false })).toEqual([]);
    expect(effectsOf(open, { type: 'context.close', focusInPage: true })).toEqual([{ type: 'page-focus-return' }]);
    expect(run(open, { type: 'context.close', focusInPage: false }).sessionsPage).toBe(false);
  });
});

describe('what the Window can show', () => {
  it('has a page only on desktop in Window mode', () => {
    const open = run(desktop, { type: 'page.open', panel: 'list' });
    expect(pageOpen(open, true)).toBe(true);
    expect(pageOpen(open, false)).toBe(false);
    expect(pageOpen(run(open, { type: 'compact.changed', compact: true }), true)).toBe(false);
    expect(pageOpen(run(compact, { type: 'page.open', panel: 'list' }), true)).toBe(false);
  });

  it('is covered by Trace, the page and a compact drawer or inspector', () => {
    expect(windowStageVisible(desktop, true)).toBe(true);
    expect(windowStageVisible(desktop, false)).toBe(false);
    expect(windowStageVisible(run(desktop, { type: 'view.show', view: 'trace' }), true)).toBe(false);
    expect(windowStageVisible(run(desktop, { type: 'page.open', panel: 'list' }), true)).toBe(false);
    const drawer = run(compact, { type: 'context.open', fromSessions: true });
    expect(supportingRailOpen(drawer)).toBe(true);
    expect(windowStageVisible(drawer, true)).toBe(false);
    expect(supportingRailOpen(run(desktop, { type: 'inspector.open' }))).toBe(false);
  });

  it('reads the drawer on compact layouts and the sidebar on desktop', () => {
    expect(contextVisible(run(compact, { type: 'context.open', fromSessions: false }))).toBe(true);
    expect(contextVisible(compact)).toBe(false);
    expect(contextVisible(run(desktop, { type: 'desktopSidebar.toggle' }))).toBe(true);
  });

  it.each([['list', 'All sessions'], ['favorites', 'Favorites'], ['new', 'New session'], ['hosts', 'Hosts'], ['settings', 'Settings']] as const)('titles the %s page', (panel, title) => {
    expect(sessionsPageTitle(panel)).toBe(title);
  });
});
