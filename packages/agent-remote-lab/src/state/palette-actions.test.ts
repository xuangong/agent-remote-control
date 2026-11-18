// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { paletteActions, type PaletteFacts, type PaletteRuns } from './palette-actions.js';

const facts = (overrides: Partial<PaletteFacts> = {}): PaletteFacts => ({
  windowMode: true, hasDirectory: true, userScoped: true, windowEditable: true, sidebarShown: true, canToggleSidebar: true, windowOverviewSupported: true, apple: true, ...overrides,
});

function recorder() {
  const calls: string[] = [];
  const runs: PaletteRuns = {
    toWindow: () => { calls.push('toWindow'); },
    inWindow: (step, confirmed = false) => () => { calls.push(`inWindow${confirmed ? ':confirmed' : ''}`); step(); },
    switchMode: mode => { calls.push(`mode:${mode}`); },
    newBot: () => { calls.push('newBot'); },
    newSessionPanel: () => { calls.push('newSessionPanel'); },
    createWindow: () => { calls.push('createWindow'); },
    addSessionView: () => { calls.push('addSessionView'); },
    showPanel: panel => { calls.push(`panel:${panel}`); },
    toggleSidebar: () => { calls.push('toggleSidebar'); },
    openWindowOverview: () => { calls.push('overview'); },
  };
  return { calls, runs };
}
const ids = (given: Partial<PaletteFacts>) => paletteActions(facts(given), recorder().runs).map(item => item.id);
const run = (id: string, given: Partial<PaletteFacts> = {}) => {
  const { calls, runs } = recorder();
  paletteActions(facts(given), runs).find(item => item.id === id)!.run();
  return calls;
};

describe('which actions the palette offers', () => {
  it('offers the full Window mode set to a signed-in person', () => {
    expect(ids({})).toEqual(['action:new-session', 'action:new-window', 'action:new-session-view', 'action:all-sessions', 'action:favorites', 'action:settings',
      'action:toggle-sidebar', 'action:bot-mode', 'action:all-windows']);
  });

  it.each([
    { name: 'New bot only in Bot mode with a directory', given: { windowMode: false }, has: 'action:new-bot', not: false },
    { name: 'no New bot without a directory', given: { windowMode: false, hasDirectory: false }, has: 'action:new-bot', not: true },
    { name: 'no New bot in Window mode', given: {}, has: 'action:new-bot', not: true },
    { name: 'no New session view without an editable Window', given: { windowEditable: false }, has: 'action:new-session-view', not: true },
    { name: 'no Favorites for an anonymous workbench', given: { userScoped: false }, has: 'action:favorites', not: true },
    { name: 'no sidebar toggle on a compact layout', given: { canToggleSidebar: false }, has: 'action:toggle-sidebar', not: true },
    { name: 'no All Windows without overview support', given: { windowOverviewSupported: false }, has: 'action:all-windows', not: true },
  ])('$name', ({ given, has, not }) => {
    expect(ids(given).includes(has)).toBe(!not);
  });

  it('offers the other mode', () => {
    expect(ids({ windowMode: true })).toContain('action:bot-mode');
    expect(ids({ windowMode: false })).toContain('action:window-mode');
    expect(ids({ windowMode: false })).not.toContain('action:bot-mode');
  });

  it('names the sidebar toggle by what it will do and shows the platform shortcut', () => {
    const [shown] = paletteActions(facts({ sidebarShown: true }), recorder().runs).filter(item => item.id === 'action:toggle-sidebar');
    expect(shown).toMatchObject({ title: 'Hide sidebar', shortcut: '⌘\\', keyShortcuts: 'Meta+\\' });
    const [hidden] = paletteActions(facts({ sidebarShown: false, apple: false }), recorder().runs).filter(item => item.id === 'action:toggle-sidebar');
    expect(hidden).toMatchObject({ title: 'Show sidebar', shortcut: 'Ctrl+\\', keyShortcuts: 'Control+\\' });
    const mode = paletteActions(facts({ apple: false }), recorder().runs).find(item => item.id === 'action:bot-mode');
    expect(mode).toMatchObject({ shortcut: 'Ctrl+Alt+2', keyShortcuts: 'Control+Alt+2' });
  });
});

describe('what each action does first', () => {
  it('switches to Window mode before showing a panel, the new-session form or the overview', () => {
    expect(run('action:all-sessions')).toEqual(['toWindow', 'panel:list']);
    expect(run('action:favorites')).toEqual(['toWindow', 'panel:favorites']);
    expect(run('action:settings')).toEqual(['toWindow', 'panel:settings']);
    expect(run('action:new-session')).toEqual(['toWindow', 'newSessionPanel']);
    expect(run('action:all-windows')).toEqual(['toWindow', 'overview']);
  });

  it('queues Window edits for Window mode, and a view edit for a confirmed Window', () => {
    expect(run('action:new-window')).toEqual(['inWindow', 'createWindow']);
    expect(run('action:new-session-view')).toEqual(['inWindow:confirmed', 'addSessionView']);
  });

  it('switches modes and toggles the sidebar directly', () => {
    expect(run('action:bot-mode')).toEqual(['mode:bot']);
    expect(run('action:window-mode', { windowMode: false })).toEqual(['toWindow']);
    expect(run('action:toggle-sidebar')).toEqual(['toggleSidebar']);
    expect(run('action:new-bot', { windowMode: false })).toEqual(['newBot']);
  });
});
