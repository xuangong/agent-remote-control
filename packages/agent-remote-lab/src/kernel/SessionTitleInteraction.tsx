import { createContext, type HTMLAttributes } from 'react';

/** A containing layout can make the title interactive without coupling the view to that layout. */
export type SessionTitleInteraction = HTMLAttributes<HTMLElement> & { 'data-session-title-draggable'?: boolean };
export const SessionTitleInteractionContext = createContext<SessionTitleInteraction | undefined>(undefined);
