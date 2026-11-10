import type { ReactNode } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';
import './shell.css';

/** The top of either mode's sidebar: the Window / Bot mode switch, then the mode's actions (its + menu or button). */
export function SidebarHeader({ mode, onModeChange, actions }: { mode: WorkbenchMode; onModeChange(mode: WorkbenchMode): void; actions?: ReactNode }) {
  return <div className="lab-sidebar-header">
    <WorkbenchModeSwitch mode={mode} onChange={onModeChange} />
    <div className="lab-sidebar-header-actions">{actions}</div>
  </div>;
}
