import { expect, it } from 'vitest';
import { keepInstalledAppStorage, runsInstalled, type InstalledAppView } from './installed-app.js';

/** A page: installed through iOS's flag or the display mode, with a Storage API that answers `granted` or fails. */
function view(options: { standalone?: boolean; displayMode?: 'standalone' | 'browser'; persist?: 'granted' | 'refused' | 'throws' | 'none' } = {}) {
  const asked: string[] = [];
  const storage = options.persist === 'none' ? undefined : { persist: () => { asked.push('persist'); return options.persist === 'throws' ? Promise.reject(new Error('SecurityError')) : Promise.resolve(options.persist !== 'refused'); } };
  const page: InstalledAppView = {
    navigator: { ...(options.standalone === undefined ? {} : { standalone: options.standalone }), ...(storage ? { storage } : {}) },
    matchMedia: query => ({ matches: query === '(display-mode: standalone)' && options.displayMode === 'standalone' }),
  };
  return { page, asked };
}

it('knows the installed app by iOS standalone or by the standalone display mode, and a tab by neither', () => {
  expect(runsInstalled(view({ standalone: true }).page)).toBe(true);
  expect(runsInstalled(view({ displayMode: 'standalone' }).page)).toBe(true);
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
