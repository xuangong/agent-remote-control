import { createContext, useContext } from 'react';
import type { CompositionSlot } from './session-composition.js';

/** Application session ownership, independent of the generic Window layout authority. */
export interface WindowSessionBridge {
  slotForView(viewId: string): CompositionSlot | undefined;
}
export const WindowSessionBridgeContext = createContext<WindowSessionBridge | undefined>(undefined);
export const useWindowSessionBridgeContext = () => useContext(WindowSessionBridgeContext);
