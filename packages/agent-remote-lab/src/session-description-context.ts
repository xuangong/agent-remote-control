import { createContext } from 'react';
import type { SessionAttribution, SessionDescription } from '@orchardworks/agent-remote-web';
import type { SessionEntry } from './session-tree.js';

/** Product owners supply descriptions; containers resolve their navigation. */
export interface SessionDescriptions {
  describe(session: SessionEntry): SessionDescription;
  navigate(attribution: SessionAttribution): void | Promise<void>;
}

export const SessionDescriptionsContext = createContext<SessionDescriptions | undefined>(undefined);
