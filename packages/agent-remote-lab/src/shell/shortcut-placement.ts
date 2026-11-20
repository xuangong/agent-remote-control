import { createContext } from 'react';

/**
 * Where the Track, Team, TPM, Window and Ask entries render: as movable floating capsules on a wide screen without the sidebar,
 * as rows in the desktop sidebar's Shortcuts, or as capsules in the launcher bar of the compact navigation. The launcher bar is
 * part of the page layout, so on a compact screen no entry can cover the conversation or the composer, however many there are.
 */
export type ShortcutPlacementKind = 'floating' | 'sidebar' | 'bar';
export const ShortcutPlacement = createContext<ShortcutPlacementKind>('floating');
