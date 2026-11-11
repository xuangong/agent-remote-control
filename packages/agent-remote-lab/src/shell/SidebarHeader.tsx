import type { ReactNode } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';
import { IconButton } from '../ui/IconButton.js';
import { applePlatform } from '../platform.js';
import './shell.css';

/**
 * The top of either mode's sidebar: the Window / Bot mode switch, then Search (when `onSearch` is given) and the mode's
 * actions (its + menu or button).
 */
export function SidebarHeader({ mode, onModeChange, onSearch, actions }: { mode: WorkbenchMode; onModeChange(mode: WorkbenchMode): void; onSearch?(): void; actions?: ReactNode }) {
  const apple = applePlatform();
  return <div className="lab-sidebar-header">
    <WorkbenchModeSwitch mode={mode} onChange={onModeChange} />
    <div className="lab-sidebar-header-actions">
      {onSearch ? <IconButton icon="search" label="Search" title={`Search (${apple ? '⌘K' : 'Ctrl+K'})`} aria-keyshortcuts={apple ? 'Meta+K' : 'Control+K'} onClick={onSearch} /> : null}
      {actions}
    </div>
  </div>;
}
