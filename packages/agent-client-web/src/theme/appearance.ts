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

/** Shows `appearance`: a pinned theme sets data-theme and gives both chrome colours its ground; the system clears it and restores each. */
export function applyAppearance(port: AppearancePort, appearance: Appearance): void {
  const pinned = appearance === 'system' ? undefined : appearance;
  port.setTheme(pinned);
  for (const media of ['light', 'dark'] as const) port.setChromeColor(orchardColors.ground[pinned ?? media], media);
}
