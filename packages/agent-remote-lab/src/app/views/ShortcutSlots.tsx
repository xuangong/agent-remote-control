// The movable shortcut and Ask slots and their entries.
import { createPortal } from 'react-dom';
import { ShortcutPlacement } from '../../kernel/shortcut-placement.js';
import { MovableHostSlot } from '../../shell/movable-host.js';
import { WindowMenu } from '../../features/windows/WindowMenu.js';
import type { AppScope } from '../types.js';

export function ShortcutSlots({ scope }: { readonly scope: Pick<AppScope, 'askBarSlot' | 'askEntry' | 'askFloatingSlot' | 'askHost' | 'askSidebarSlot' | 'askToolbarSlot' | 'shortcutToolbarSlot' | 'confirmBotRemoval' | 'menuCurrentBinding' | 'setWindowOverviewOpen' | 'shortcutBarSlot' | 'shortcutFloatingSlot' | 'shortcutHost' | 'shortcutPlacement' | 'shortcutSidebarSlot' | 'sidebarShortcuts' | 'supportingRailOpen' | 'trackTeamEntries' | 'windowMode' | 'windowOverviewAvailable' | 'windowSessionStatus' | 'windowView' | 'windowWorkspace'> }) {
  const { askBarSlot, askEntry, askFloatingSlot, askHost, askSidebarSlot, askToolbarSlot, shortcutToolbarSlot, confirmBotRemoval, menuCurrentBinding, setWindowOverviewOpen, shortcutBarSlot, shortcutFloatingSlot, shortcutHost, shortcutPlacement, shortcutSidebarSlot, sidebarShortcuts, supportingRailOpen, trackTeamEntries, windowMode, windowOverviewAvailable, windowSessionStatus, windowView, windowWorkspace } = scope;
  const [shortcutSlot, askSlot] = shortcutPlacement === 'sidebar' ? [shortcutSidebarSlot, askSidebarSlot] as const
    : shortcutPlacement === 'bar' ? [shortcutBarSlot, askBarSlot] as const
    : shortcutPlacement === 'toolbar' ? [shortcutToolbarSlot, askToolbarSlot] as const : [shortcutFloatingSlot, askFloatingSlot] as const;
  // The sidebar lists the Windows itself, so the Window entry exists only outside it.
  const windowEntry = sidebarShortcuts ? null : <WindowMenu workspace={windowWorkspace} current={menuCurrentBinding}
    visible={windowMode && windowView.visible} inert={supportingRailOpen} onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} sessionStatus={windowSessionStatus}
    onRemoveView={confirmBotRemoval} />;
  return <>
    {/* After the slots, so a slot rendered in this commit is attached before the entries' layout effects run. */}
    <MovableHostSlot host={shortcutHost} slot={shortcutSlot} />
    <MovableHostSlot host={askHost} slot={askSlot} />
    <ShortcutPlacement.Provider value={shortcutPlacement === 'toolbar' ? 'bar' : shortcutPlacement}>{createPortal(<>{trackTeamEntries}{windowEntry}</>, shortcutHost)}{createPortal(askEntry, askHost)}</ShortcutPlacement.Provider>
  </>;
}
