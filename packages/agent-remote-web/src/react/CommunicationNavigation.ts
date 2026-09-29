import { createContext } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

/** Session owners resolve identities and arrange windows; the renderer only presents a letter. */
export interface CommunicationNavigation {
  direction(entry: ProjectedTimelineEntry): 'left' | 'right' | undefined;
  open(entry: ProjectedTimelineEntry): Promise<void>;
}
export const CommunicationNavigationContext = createContext<CommunicationNavigation | undefined>(undefined);
