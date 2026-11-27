import { describe, expect, it } from 'vitest';
import { keepInstalledAppStorage, platformSwipesBack, runsInstalled, type InstalledAppView } from './installed-app.js';

/** A page: installed through iOS's flag or the display mode, with a Storage API that answers `granted` or fails. */
function view(options: { standalone?: boolean; displayMode?: 'standalone' | 'window-controls-overlay' | 'browser'; persist?: 'granted' | 'refused' | 'throws' | 'none' } = {}) {
  const asked: string[] = [];
  const storage = options.persist === 'none' ? undefined : { persist: () => { asked.push('persist'); return options.persist === 'throws' ? Promise.reject(new Error('SecurityError')) : Promise.resolve(options.persist !== 'refused'); } };
  const page: InstalledAppView = {
    navigator: { ...(options.standalone === undefined ? {} : { standalone: options.standalone }), ...(storage ? { storage } : {}) },
    matchMedia: query => ({ matches: query === `(display-mode: ${options.displayMode})` }),
  };
  return { page, asked };
}

it('knows the installed app by iOS standalone or by its display mode, and a tab by neither', () => {
  expect(runsInstalled(view({ standalone: true }).page)).toBe(true);
  expect(runsInstalled(view({ displayMode: 'standalone' }).page)).toBe(true);
  expect(runsInstalled(view({ displayMode: 'window-controls-overlay' }).page)).toBe(true);
  expect(runsInstalled(view({ standalone: false, displayMode: 'browser' }).page)).toBe(false);
  expect(runsInstalled({ navigator: {} })).toBe(false);
});

it('asks the browser once to keep the storage of the installed app, and returns its answer', async () => {
  const granted = view({ standalone: true, persist: 'granted' });
  await expect(keepInstalledAppStorage(granted.page)).resolves.toBe(true);
  expect(granted.asked).toEqual(['persist']);
  const refused = view({ displayMode: 'standalone', persist: 'refused' });
  await expect(keepInstalledAppStorage(refused.page)).resolves.toBe(false);
  expect(refused.asked).toEqual(['persist']);
});

it('does not ask in a browser tab, and never fails the start when the browser cannot keep storage', async () => {
  const tab = view({ standalone: false, persist: 'granted' });
  await expect(keepInstalledAppStorage(tab.page)).resolves.toBeUndefined();
  expect(tab.asked).toEqual([]);
  await expect(keepInstalledAppStorage(view({ standalone: true, persist: 'none' }).page)).resolves.toBeUndefined();
  await expect(keepInstalledAppStorage(view({ standalone: true, persist: 'throws' }).page)).resolves.toBe(false);
});

describe('the platform\'s own swipe back', () => {
  const page = (navigator: object, standalone = false) => ({ navigator, matchMedia: (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }) }) as never;
  it('is iOS as a home-screen app, told by navigator.standalone', () => {
    expect(platformSwipesBack(page({ standalone: true }))).toBe(true);
    expect(platformSwipesBack(page({ standalone: false }))).toBe(false);
  });
  it('is an iPad asking for the desktop site in the standalone display mode', () => {
    expect(platformSwipesBack(page({ vendor: 'Apple Computer, Inc.', maxTouchPoints: 5 }, true))).toBe(true);
  });
  it('is not Chromium, nor a browser tab, nor a desktop app window', () => {
    expect(platformSwipesBack(page({ vendor: 'Google Inc.', maxTouchPoints: 5 }, true))).toBe(false);
    expect(platformSwipesBack(page({ vendor: 'Apple Computer, Inc.', maxTouchPoints: 5 }, false))).toBe(false);
    expect(platformSwipesBack(page({ vendor: 'Apple Computer, Inc.', maxTouchPoints: 0 }, true))).toBe(false);
  });
});
