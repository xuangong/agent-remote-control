import { createContext } from 'react';

/**
 * Where the Track, Team, TPM, Window and Ask entries render: as rows in the desktop sidebar's Shortcuts, as capsules in a row the
 * layout reserves (the launcher bar of the compact navigation, or the Window's toolbar on a wide screen without the sidebar), or
 * as movable floating capsules beside a single conversation's reading column. A reserved row is part of the page layout, so no
 * entry can cover a conversation or a composer, however many there are and however wide the tiles are.
 */
export type ShortcutPlacementKind = 'floating' | 'sidebar' | 'bar';
export const ShortcutPlacement = createContext<ShortcutPlacementKind>('floating');
