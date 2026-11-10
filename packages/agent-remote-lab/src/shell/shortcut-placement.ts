import { createContext } from 'react';

/** Where the Team, TPM, Track and Ask entries render: as floating capsules, or as rows in the desktop sidebar's Shortcuts. */
export const ShortcutPlacement = createContext<'floating' | 'sidebar'>('floating');
