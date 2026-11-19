import { expect, it } from 'vitest';
import { applyAppearance, chooseAppearance, readAppearance, type Appearance, type AppearancePort } from './appearance.js';
import type { ThemeName } from './tokens.js';

function stubPort(stored: string | null = null) {
  const state = { stored, theme: undefined as ThemeName | undefined, chrome: { light: '', dark: '' } as Record<ThemeName, string> };
  const port: AppearancePort = {
    read: () => state.stored,
    write: (value: Appearance) => { state.stored = value; },
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

it('stores a choice and shows it', () => {
  const { port, state } = stubPort('dark');
  chooseAppearance(port, 'light');
  expect(state.stored).toBe('light');
  expect(readAppearance(port.read())).toBe('light');
  expect(state.theme).toBe('light');
});
