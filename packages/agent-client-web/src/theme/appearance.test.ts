import { expect, it } from 'vitest';
import { applyAppearance, chromeColors, readAppearance, type Appearance, type AppearancePort } from './appearance.js';
import type { ThemeName } from './tokens.js';

function stubPort() {
  const state = { theme: undefined as ThemeName | undefined, chrome: { light: '', dark: '' } as Record<ThemeName, string> };
  const port: AppearancePort = {
    setTheme: theme => { state.theme = theme; },
    setChromeColor: (color, media) => { state.chrome[media] = color; },
  };
  return { port, state };
}

it('reads an unknown or missing value as the system', () => {
  expect(readAppearance(null)).toBe('system');
  expect(readAppearance('sepia')).toBe('system');
  expect(readAppearance('')).toBe('system');
  expect(readAppearance('light')).toBe('light');
  expect(readAppearance('dark')).toBe('dark');
});

// The browser chrome (theme-color) the person sees, by the appearance chosen and the system's: always the ground the page shows.
it.each([
  ['system', 'light', '#f3efe9'], ['system', 'dark', '#151517'],
  ['light', 'light', '#f3efe9'], ['light', 'dark', '#f3efe9'],
  ['dark', 'light', '#151517'], ['dark', 'dark', '#151517'],
] as const)('%s on a %s system shows the chrome in %s', (appearance: Appearance, system, color) => {
  expect(chromeColors(appearance)[system]).toBe(color);
});

it.each([['light', '#f3efe9'], ['dark', '#151517']] as const)('pins %s: data-theme and both chrome colours take its ground', (theme, ground) => {
  const { port, state } = stubPort();
  applyAppearance(port, theme);
  expect(state.theme).toBe(theme);
  expect(state.chrome).toEqual({ light: ground, dark: ground });
});

it('follows the system again: clears data-theme and restores each media colour', () => {
  const { port, state } = stubPort();
  applyAppearance(port, 'dark');
  applyAppearance(port, 'system');
  expect(state.theme).toBeUndefined();
  expect(state.chrome).toEqual({ light: '#f3efe9', dark: '#151517' });
});
