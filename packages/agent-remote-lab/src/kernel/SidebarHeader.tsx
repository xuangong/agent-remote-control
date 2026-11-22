import type { ReactNode } from 'react';
import { Wordmark } from '@orchardworks/agent-client-web/primitives';
import '../shell/shell.css';

/**
 * The top of either mode's sidebar: a title (the Orchard wordmark with `brand`) and the mode's actions, its + menu or button.
 * The rail carries the modes and Search.
 */
export function SidebarHeader({ title, actions, brand = false }: { title?: string; actions?: ReactNode; brand?: boolean }) {
  return <div className="lab-sidebar-header">
    {brand ? <Wordmark className="lab-sidebar-brand" /> : <h2 className="lab-sidebar-title">{title}</h2>}
    <div className="lab-sidebar-header-actions">{actions}</div>
  </div>;
}
