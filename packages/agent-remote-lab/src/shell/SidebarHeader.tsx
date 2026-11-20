import type { ReactNode } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';
import { IconButton } from '../ui/IconButton.js';
import { applePlatform } from '../platform.js';
import { Wordmark } from '@orchardworks/agent-client-web/primitives';
import './shell.css';

/**
 * The top of either mode's sidebar: the Window / Bot mode switch, then Search (when `onSearch` is given) and the mode's
 * actions (its + menu or button). With `brand`, the Orchard wordmark stands above them.
 */
export function SidebarHeader({ mode, onModeChange, onSearch, actions, brand = false }: { mode: WorkbenchMode; onModeChange(mode: WorkbenchMode): void; onSearch?(): void; actions?: ReactNode; brand?: boolean }) {
  const apple = applePlatform();
  const header = <div className="lab-sidebar-header">
    <WorkbenchModeSwitch mode={mode} onChange={onModeChange} />
    <div className="lab-sidebar-header-actions">
      {onSearch ? <IconButton icon="search" label="Search" title={`Search (${apple ? '⌘K' : 'Ctrl+K'})`} aria-keyshortcuts={apple ? 'Meta+K' : 'Control+K'} onClick={onSearch} /> : null}
      {actions}
    </div>
  </div>;
  return brand ? <div className="lab-sidebar-top"><Wordmark className="lab-sidebar-brand" />{header}</div> : header;
}
