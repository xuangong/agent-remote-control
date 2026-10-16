import { createContext, useContext } from 'react';
import type { WindowOperation, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
/** Layout commands and opaque local identity adaptation; no session ownership capability. */
export interface WindowLayoutAuthority {
  window: WorkspaceWindow;
  operate(operation: WindowOperation): void;
  resolveViewId?(localId: string): string | undefined;
}
export const WindowLayoutContext = createContext<WindowLayoutAuthority | undefined>(undefined);
export const useWindowLayout = () => useContext(WindowLayoutContext);
/** Page-local fallback focus does not change shared selection or layout commands. */
export const WindowPresentationContext = createContext<string | undefined>(undefined);
