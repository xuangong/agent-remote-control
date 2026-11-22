/**
 * The appearance choice of this device: follow the system, or pin the light or the dark theme. Pure: the stored value,
 * the root element's theme and the browser chrome colour are reached through a port; bindAppearance in browser.ts stores the choice.
 */
import { orchardColors, type ThemeName } from './tokens.js';

export type Appearance = 'system' | 'light' | 'dark';
/** The localStorage key, per device; it is not conversation content, so clearing conversations keeps it. */
export const APPEARANCE_STORAGE_KEY = 'agent-remote:appearance';
export const appearances: readonly Appearance[] = ['system', 'light', 'dark'];

export interface AppearancePort {
  /** Pins the root's theme (`data-theme`), or clears it to follow the system. */
  setTheme(theme: ThemeName | undefined): void;
  /** Sets the browser chrome colour the page declares for the system's light or dark appearance. */
  setChromeColor(color: string, media: ThemeName): void;
}

/** A stored value as an appearance; anything unknown or missing follows the system. */
export function readAppearance(stored: string | null): Appearance {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * The browser chrome's colour (`theme-color`) under each system appearance: the ground, so the title bar of the installed app and a
 * phone's status bar continue the page. A pinned theme gives both its own ground; following the system gives each its ground.
 */
export function chromeColors(appearance: Appearance): Readonly<Record<ThemeName, string>> {
  const pinned = appearance === 'system' ? undefined : appearance;
  return { light: orchardColors.ground[pinned ?? 'light'], dark: orchardColors.ground[pinned ?? 'dark'] };
}

/** Shows `appearance`: a pinned theme sets data-theme, a followed system clears it; the chrome colours follow (`chromeColors`). */
export function applyAppearance(port: AppearancePort, appearance: Appearance): void {
  port.setTheme(appearance === 'system' ? undefined : appearance);
  const colors = chromeColors(appearance);
  for (const media of ['light', 'dark'] as const) port.setChromeColor(colors[media], media);
}
