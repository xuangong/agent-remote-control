// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { translator } from '@orchardworks/agent-client';
import { paletteActions, type PaletteFacts, type PaletteRuns } from './palette-actions.js';

const facts = (overrides: Partial<PaletteFacts> = {}): PaletteFacts => ({
  windowMode: true, hasDirectory: true, userScoped: true, windowEditable: true, sidebarShown: true, canToggleSidebar: true, windowOverviewSupported: true, apple: true, ...overrides,
});

function recorder() {
  const calls: string[] = [];
  const runs: PaletteRuns = {
    toWindow: () => { calls.push('toWindow'); },
    inWindow: (step, confirmed = false) => () => { calls.push(`inWindow${confirmed ? ':confirmed' : ''}`); step(); },
    go: destination => { calls.push(`go:${destination}`); },
    newBot: () => { calls.push('newBot'); },
    newSessionPanel: () => { calls.push('newSessionPanel'); },
    createWindow: () => { calls.push('createWindow'); },
    addSessionView: () => { calls.push('addSessionView'); },
    openInBotMode: () => { calls.push('openInBotMode'); },
    pinToWindow: () => { calls.push('pinToWindow'); },
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
    expect(ids({})).toEqual(['action:new-session', 'action:new-window', 'action:new-session-view', 'action:all-sessions', 'action:favorites',
      'action:toggle-sidebar', 'action:chats', 'action:assistants', 'action:windows', 'action:settings', 'action:all-windows']);
  });

  it.each([
    { name: 'New bot only in Bot mode with a directory', given: { windowMode: false }, has: 'action:new-bot', not: false },
    { name: 'no New bot without a directory', given: { windowMode: false, hasDirectory: false }, has: 'action:new-bot', not: true },
    { name: 'no New bot in Window mode', given: {}, has: 'action:new-bot', not: true },
    { name: 'no New session view without an editable Window', given: { windowEditable: false }, has: 'action:new-session-view', not: true },
    { name: 'no Favorites for an anonymous workbench', given: { userScoped: false }, has: 'action:favorites', not: true },
    { name: 'no sidebar toggle on a compact layout', given: { canToggleSidebar: false }, has: 'action:toggle-sidebar', not: true },
    { name: 'no All groups without overview support', given: { windowOverviewSupported: false }, has: 'action:all-windows', not: true },
    { name: 'Open in Bot mode for a selected tile that is an assistant', given: { canOpenInBotMode: true }, has: 'action:open-in-bot-mode', not: false },
    { name: 'no Open in Bot mode without one', given: {}, has: 'action:open-in-bot-mode', not: true },
    { name: 'Pin to a window for the assistant shown in Bot mode', given: { windowMode: false, canPinToWindow: true }, has: 'action:pin-to-window', not: false },
    { name: 'no Pin to a window in Window mode', given: { canPinToWindow: true }, has: 'action:pin-to-window', not: true },
  ])('$name', ({ given, has, not }) => {
    expect(ids(given).includes(has)).toBe(!not);
  });

  it('offers Chats, Assistants, Windows and Settings by name in either mode, and no mode switch', () => {
    for (const windowMode of [true, false]) {
      const items = paletteActions(facts({ windowMode }), recorder().runs);
      expect(items.filter(item => ['chats', 'assistants', 'windows', 'settings'].some(id => item.id === `action:${id}`)).map(item => item.title)).toEqual(['Chats', 'Assistants', 'Windows', 'Settings']);
      expect(items.some(item => /Switch to/.test(item.title))).toBe(false);
    }
  });

  it('speaks the reader\'s language', () => {
    const items = paletteActions({ ...facts(), t: translator('zh') }, recorder().runs);
    expect(items.find(item => item.id === 'action:chats')?.title).toBe('聊天');
  });

  it('names the sidebar toggle by what it will do and shows the platform shortcut', () => {
    const [shown] = paletteActions(facts({ sidebarShown: true }), recorder().runs).filter(item => item.id === 'action:toggle-sidebar');
    expect(shown).toMatchObject({ title: 'Hide sidebar', shortcut: '⌘\\', keyShortcuts: 'Meta+\\' });
    const [hidden] = paletteActions(facts({ sidebarShown: false, apple: false }), recorder().runs).filter(item => item.id === 'action:toggle-sidebar');
    expect(hidden).toMatchObject({ title: 'Show sidebar', shortcut: 'Ctrl+\\', keyShortcuts: 'Control+\\' });
    const mode = paletteActions(facts({ apple: false }), recorder().runs).find(item => item.id === 'action:chats');
    expect(mode).toMatchObject({ shortcut: 'Ctrl+Alt+2', keyShortcuts: 'Control+Alt+2' });
  });
});

describe('what each action does first', () => {
  it('switches to Window mode before showing a panel, the new-session form or the overview', () => {
    expect(run('action:all-sessions')).toEqual(['toWindow', 'panel:list']);
    expect(run('action:favorites')).toEqual(['toWindow', 'panel:favorites']);
    expect(run('action:new-session')).toEqual(['toWindow', 'newSessionPanel']);
    expect(run('action:all-windows')).toEqual(['toWindow', 'overview']);
  });

  it('queues Window edits for Window mode, and a view edit for a confirmed Window', () => {
    expect(run('action:new-window')).toEqual(['inWindow', 'createWindow']);
    expect(run('action:new-session-view')).toEqual(['inWindow:confirmed', 'addSessionView']);
  });

  it('goes to a destination and toggles the sidebar directly', () => {
    for (const destination of ['chats', 'assistants', 'windows', 'settings']) expect(run(`action:${destination}`)).toEqual([`go:${destination}`]);
    expect(run('action:toggle-sidebar')).toEqual(['toggleSidebar']);
    expect(run('action:new-bot', { windowMode: false })).toEqual(['newBot']);
  });
});

it('names every action in the reader\'s language', () => {
  const titles = paletteActions(facts({ canOpenInBotMode: true, windowMode: true }), recorder().runs).map(item => item.title);
  const chinese = paletteActions(facts({ canOpenInBotMode: true, windowMode: true, t: translator('zh') }), recorder().runs).map(item => item.title);
  expect(chinese).toContain('新会话');
  expect(chinese).toContain('收起侧栏');
  expect(chinese).toContain('全部分组');
  expect(chinese).toHaveLength(titles.length);
});
