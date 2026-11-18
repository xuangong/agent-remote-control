// The movable shortcut and Ask slots and their entries.
import { createPortal } from 'react-dom';
import { ShortcutPlacement } from '../../shell/shortcut-placement.js';
import { MovableHostSlot } from '../../shell/movable-host.js';
import type { AppScope } from '../types.js';

export function ShortcutSlots({ scope }: { readonly scope: Pick<AppScope, 'askEntry' | 'askFloatingSlot' | 'askHost' | 'askSidebarSlot' | 'shortcutFloatingSlot' | 'shortcutHost' | 'shortcutPlacement' | 'shortcutSidebarSlot' | 'sidebarShortcuts' | 'trackTeamTpmEntries'> }) {
  const { askEntry, askFloatingSlot, askHost, askSidebarSlot, shortcutFloatingSlot, shortcutHost, shortcutPlacement, shortcutSidebarSlot, sidebarShortcuts, trackTeamTpmEntries } = scope;
  return <>
    {/* After both slots, so a slot rendered in this commit is attached before the entries' layout effects run. */}
    <MovableHostSlot host={shortcutHost} slot={sidebarShortcuts ? shortcutSidebarSlot : shortcutFloatingSlot} />
    <MovableHostSlot host={askHost} slot={sidebarShortcuts ? askSidebarSlot : askFloatingSlot} />
    <ShortcutPlacement.Provider value={shortcutPlacement}>{createPortal(trackTeamTpmEntries, shortcutHost)}{createPortal(askEntry, askHost)}</ShortcutPlacement.Provider>
  </>;
}
